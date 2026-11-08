import { describe, expect, it } from 'vitest';
import { ChatterMostClient } from '../src/clients/chattermost.js';
import { HiveMemClient, HiveMemError } from '../src/clients/hivemem.js';
import { ACTING_SUBJECT_HEADER, MagnusClient, MagnusError, parseAgentRef, STUDIO_ACTIONS } from '../src/clients/magnus.js';
import { ServiceTokenProvider } from '../src/clients/service-token.js';
import { parseSse } from '../src/clients/sse.js';
import { profile } from './helpers.js';

type Call = { url: string; init: RequestInit };
function recorder(answer: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return answer(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, fetcher };
}
const headers = (call: Call) => new Headers(call.init.headers);
const stream = (text: string) => new Response(text).body!;
const TOKEN_URL = 'https://identity.example.com/api/v1/oauth/token';
const fixedTokens = { token: async () => 'fixture-service-token', invalidate: () => undefined };
const TASK = '11111111-1111-4111-8111-111111111111';

describe('service tokens', () => {
  it('fetch a client_credentials token, cache it and refresh before expiry', async () => {
    let now = 1_000_000;
    let issued = 0;
    const { calls, fetcher } = recorder(() => Response.json({ access_token: `fixture-token-${++issued}`, expires_in: 300 }));
    const provider = new ServiceTokenProvider({ tokenUrl: TOKEN_URL, clientId: 'ardentstudio-magnus', clientSecret: 'fixture-secret', scope: 'magnus:studio', fetch: fetcher, now: () => now });
    expect(await provider.token()).toBe('fixture-token-1');
    expect(await provider.token()).toBe('fixture-token-1');
    expect(calls).toHaveLength(1);
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', client_id: 'ardentstudio-magnus', client_secret: 'fixture-secret', scope: 'magnus:studio' });
    expect(calls[0]!.init.redirect).toBe('error');
    now += 250_000;
    expect(await provider.token()).toBe('fixture-token-1');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await provider.token()).toBe('fixture-token-2');
    provider.invalidate();
    expect(await provider.token()).toBe('fixture-token-3');
  });

  it('back off after a failure without leaking the secret', async () => {
    let now = 0;
    const { calls, fetcher } = recorder(() => new Response('fixture-secret echoed', { status: 401 }));
    const provider = new ServiceTokenProvider({ tokenUrl: TOKEN_URL, clientId: 'c', clientSecret: 'fixture-secret', fetch: fetcher, now: () => now });
    const error = await provider.token().then(() => new Error("unexpected success"), (caught: unknown) => caught as Error);
    expect(error.message).toBe('Oathweave token request failed (HTTP 401)');
    await expect(provider.token()).rejects.toThrow(/backing off/);
    expect(calls).toHaveLength(1);
    now += 6_000;
    await expect(provider.token()).rejects.toThrow(/HTTP 401/);
  });
});

describe('Magnus client', () => {
  it('lists profiles with the service token and the acting subject', async () => {
    const { calls, fetcher } = recorder(() => Response.json({ success: true, data: [profile('node1', 'lead')] }));
    const client = new MagnusClient({ baseUrl: 'https://magnus.example.com/', tokens: fixedTokens, fetch: fetcher });
    const profiles = await client.listProfiles({ actingSubject: 'subject-operator' });
    expect(profiles[0]).toMatchObject({ id: 'lead', nodeId: 'node1' });
    expect(calls[0]!.url).toBe('https://magnus.example.com/api/v1/ardent/profiles');
    expect(headers(calls[0]!).get('authorization')).toBe('Bearer fixture-service-token');
    expect(headers(calls[0]!).get(ACTING_SUBJECT_HEADER)).toBe('subject-operator');
    await client.listProfiles();
    expect(headers(calls[1]!).has(ACTING_SUBJECT_HEADER)).toBe(false);
  });

  it('reads allow-listed resources and runs the released actions', async () => {
    const { calls, fetcher } = recorder(call => {
      if (call.url.endsWith('/skills')) return Response.json({ success: true, data: { skills: [{ name: 'research', enabled: true, hash: 'x' }] } });
      if (call.url.includes('/events')) return Response.json({ success: true, data: { events: [{ sequence: 3, task_id: TASK, kind: 'task_completed', created_ms: 1 }] } });
      return Response.json({ success: true, data: { task_id: TASK, state: 'queued' } });
    });
    const client = new MagnusClient({ baseUrl: 'https://magnus.example.com', tokens: fixedTokens, fetch: fetcher });
    expect(await client.skills('node1~lead')).toEqual([{ name: 'research', enabled: true, hash: 'x' }]);
    expect(calls[0]!.url).toBe('https://magnus.example.com/api/v1/ardent/installations/node1/profiles/lead/skills');
    expect((await client.taskEvents('node1~lead', TASK, 2))[0]!.sequence).toBe(3);
    expect(calls[1]!.url).toBe(`https://magnus.example.com/api/v1/ardent/installations/node1/profiles/lead/tasks/${TASK}/events?after=2`);
    expect(await client.submitTask('node1~lead', { prompt: 'Outline the adventure', idempotency_key: TASK })).toEqual({ task_id: TASK, state: 'queued' });
    expect(calls[2]!.url).toBe('https://magnus.example.com/api/v1/ardent/installations/node1/profiles/lead/action');
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ action: 'task-submit', body: { prompt: 'Outline the adventure', idempotency_key: TASK } });
    await expect(client.submitTask('node1~lead', { prompt: 'x'.repeat(16_001), idempotency_key: TASK })).rejects.toThrow(/16000/);
    await expect(client.cancelTask('node1~lead', 'not-a-task')).rejects.toThrow(/task ID/);
    await client.cancelTask('node1~lead', TASK);
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ action: 'task-cancel', target: TASK });
  });

  it('maps Magnus errors, and renews a rejected service token once', async () => {
    let invalidated = 0;
    const tokens = { token: async () => `fixture-token-${invalidated}`, invalidate: () => { invalidated++; } };
    const { calls, fetcher } = recorder((_call, index) => index === 0 ? new Response('', { status: 401 })
      : Response.json({ success: false, error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Ardent node unavailable' } }, { status: 503 }));
    const client = new MagnusClient({ baseUrl: 'https://magnus.example.com', tokens, fetch: fetcher });
    const error = await client.listProfiles().catch((caught: unknown) => caught as MagnusError);
    expect(error).toBeInstanceOf(MagnusError);
    expect(error).toMatchObject({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', message: 'Ardent node unavailable' });
    expect(invalidated).toBe(1);
    expect(headers(calls[1]!).get('authorization')).toBe('Bearer fixture-token-1');
  });

  it('calls the Studio routes with their Magnus shapes', async () => {
    const { calls, fetcher } = recorder(call => call.url.endsWith('/stream?after=4')
      ? new Response('event: task.delta\ndata: {"step":1,"text":"Hel"}\n\nid: 5\nevent: task.event\ndata: {"sequence":5}\n\n', { headers: { 'content-type': 'text/event-stream' } })
      : call.url.endsWith('/installations/node1') ? Response.json({ success: true, data: { installed: true, version: '2.2.0', owner: 'operator', profiles: [], checkedAt: 'x',
        nodeId: 'node1', nodeName: 'Node 1', hostname: 'node1.example.com', reachable: true, error: null, capabilities: { studio: 2 } } })
        : call.url.includes('/action') && JSON.parse(String(call.init.body)).action === 'session-open'
          ? Response.json({ success: true, data: { id: TASK, caller: 'management', context: 'mission', key: 'studio:k', created_ms: 1, updated_ms: 1 } })
          : Response.json({ success: true, data: { operationId: 'op-1', task_id: TASK, state: 'queued', steps: [] } }));
    const client = new MagnusClient({ baseUrl: 'https://magnus.example.com', tokens: fixedTokens, fetch: fetcher });
    expect(await client.studioLevel('node1')).toBe(2);
    expect((await client.openSession('node1~lead', { key: 'studio:k', context: 'mission' })).id).toBe(TASK);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ action: 'session-open', body: { key: 'studio:k', context: 'mission' } });
    const mission = { id: 'tsk_1', revision: 1, parent_task: null, constraints: [], allowed_actions: ['observe' as const], resources: ['tool:team_ask_user'],
      deadline: 4_000_000_000, acceptance_criteria: ['Reply'], expected_artifacts: [] };
    await client.submitMission('node1~lead', { session_id: TASK, objective: 'Draft', mission, idempotency_key: 'tsk_1' });
    expect(JSON.parse(String(calls[2]!.init.body))).toMatchObject({ action: 'mission-submit', body: { session_id: TASK, objective: 'Draft', mission } });
    await expect(client.submitMission('node1~lead', { objective: 'Draft', mission: { ...mission, resources: [] }, idempotency_key: 'tsk_1' })).rejects.toThrow(/Mission is invalid/);
    await expect(client.submitMission('node1~lead', { objective: 'Draft', mission, idempotency_key: 'tsk_1',
      context_items: [{ title: 'Big', text: 'x'.repeat(70_000) }] })).rejects.toThrow(/64 KiB/);
    const events = [];
    for await (const event of client.streamTask('node1~lead', TASK, { after: 4 })) events.push(event);
    expect(events).toEqual([{ event: 'task.delta', data: '{"step":1,"text":"Hel"}' }, { event: 'task.event', data: '{"sequence":5}', id: '5' }]);
    const deploy = { nodeId: 'node1', profile: 'mapper', soul_md: 'Soul', identity_md: 'Identity', model: { emberpath_alias: 'fixture' }, skills: [], hivemem: true as const };
    await expect(client.createAgent(deploy, {})).rejects.toThrow(/acting person/);
    expect(await client.createAgent(deploy, { actingSubject: 'subject-operator' })).toEqual({ operationId: 'op-1' });
    expect(calls.at(-1)!.url).toBe('https://magnus.example.com/api/v1/ardent/agents');
    await expect(client.createAgent({ ...deploy, model: { base_url: 'https://user:secret@llm.example.com', model: 'm' } }, { actingSubject: 'subject-operator' })).rejects.toThrow();
    expect(STUDIO_ACTIONS).toEqual(['session-open', 'mission-submit', 'task-pause', 'task-resume', 'preview-submit', 'development-note', 'skill-install']);
  });

  it('parses agent references strictly', () => {
    expect(parseAgentRef('node-1~lead_2')).toEqual({ nodeId: 'node-1', profile: 'lead_2' });
    for (const bad of ['node1', 'node1~', '~lead', 'a~b~c', 'node/1~lead', '../x~y']) expect(() => parseAgentRef(bad), bad).toThrow();
  });
});

describe('HiveMem client', () => {
  it('creates the workspace and syncs a source with preview before apply', async () => {
    const { calls, fetcher } = recorder(call => call.url.endsWith('/v1/workspaces')
      ? Response.json({ workspace_id: 'ardentstudio-prj', owner_agent_id: 'ardentstudio' }, { status: 201 })
      : Response.json({ mode: JSON.parse(String(call.init.body)).mode, workspace_id: 'w', project_id: 'p', source_id: 's', revision: 'r', created: 1, superseded: 0, retired: 0, unchanged: 0 }));
    const client = new HiveMemClient({ baseUrl: 'https://hivemem.example.com/', tokens: fixedTokens, fetch: fetcher });
    await client.ensureWorkspace({ workspace_id: 'ardentstudio-prj', title: 'Project' });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ workspace_id: 'ardentstudio-prj', title: 'Project' });
    const result = await client.syncKnowledgeSourceChecked({ workspace_id: 'w', project_id: 'p', source_id: 's', source_uri: 'ardentstudio://x', revision: 'r', observed_at: '2026-11-08T00:00:00.000Z', chunks: [] });
    expect([result.preview.mode, result.applied.mode]).toEqual(['preview', 'apply']);
    expect(calls.slice(1).map(call => [call.url, JSON.parse(String(call.init.body)).mode])).toEqual([
      ['https://hivemem.example.com/v1/knowledge/sources/sync', 'preview'], ['https://hivemem.example.com/v1/knowledge/sources/sync', 'apply'],
    ]);
  });

  it('reports HiveMem errors by their detail', async () => {
    const { fetcher } = recorder(() => Response.json({ detail: 'content_hash does not match source chunk content' }, { status: 400 }));
    const client = new HiveMemClient({ baseUrl: 'https://hivemem.example.com', tokens: fixedTokens, fetch: fetcher });
    await expect(client.syncKnowledgeSource({ mode: 'preview', workspace_id: 'w', project_id: 'p', source_id: 's', source_uri: 'u', revision: 'r', observed_at: 'x', chunks: [] }))
      .rejects.toEqual(new HiveMemError('content_hash does not match source chunk content', 400));
  });
});

describe('ChatterMost client', () => {
  it('posts a labelled announcement and never reveals the webhook URL', async () => {
    const url = 'https://chat.example.com/api/v4/webhooks/incoming/hook/fixture-secret';
    const { calls, fetcher } = recorder((_call, index) => index === 0 ? Response.json({ id: 'post' }) : new Response('', { status: 404 }));
    const client = new ChatterMostClient(url, fetcher);
    await client.announce({ text: 'Decision pinned: map scale 1:50', link: 'https://console.example.com/studio/p/prj' });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: 'Decision pinned: map scale 1:50\nhttps://console.example.com/studio/p/prj', username: 'Ardent Project Studio' });
    const error = await client.announce({ text: "again" }).then(() => new Error("unexpected success"), (caught: unknown) => caught as Error);
    expect(error.message).toBe('ChatterMost webhook answered HTTP 404');
    expect(error.message).not.toContain('fixture-secret');
  });
});

describe('SSE parser', () => {
  it('handles multi-line data, comments, ids and CRLF, and drops an unterminated event', async () => {
    const events = [];
    for await (const event of parseSse(stream(': hello\r\nevent: a\r\ndata: one\r\ndata: two\r\nid: 7\r\n\r\ndata: plain\n\nevent: cut\ndata: x'))) events.push(event);
    expect(events).toEqual([{ event: 'a', data: 'one\ntwo', id: '7' }, { event: 'message', data: 'plain' }]);
  });

  it('refuses an oversized event', async () => {
    const run = async () => { for await (const _event of parseSse(stream(`data: ${'x'.repeat(100)}\n\n`), 10)) { /* drain */ } };
    await expect(run()).rejects.toThrow(/size limit/);
  });
});
