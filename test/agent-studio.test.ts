import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSse, type SseMessage } from '../src/clients/sse.js';
import { ARDENT_STUDIO_API_PREFIX } from '../src/shared/browser.js';
import { createProject, createTestContext, json, publishTeam, waitFor, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => { await ctx?.close(); });

const REF = 'node1~lead';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

async function preview(body: Record<string, unknown>, key?: string) {
  const controller = new AbortController();
  const response = await ctx.app.request(`${ARDENT_STUDIO_API_PREFIX}/agents/${REF}/preview`, {
    method: 'POST', signal: controller.signal, body: JSON.stringify(body),
    headers: { authorization: `Bearer ${await ctx.token()}`, 'content-type': 'application/json', ...(key ? { 'x-idempotency-key': key } : {}) },
  });
  const events: SseMessage[] = [];
  const reading = response.status === 200 ? (async () => { for await (const event of parseSse(response.body!)) events.push(event); })() : Promise.resolve();
  return { response, events, reading, close: () => controller.abort() };
}

describe('agent presentation and drafts', () => {
  it('keeps Studio presentation and one draft per person, based on the agent\'s current revisions', async () => {
    ctx = await createTestContext();
    expect(await json(await ctx.call('GET', `/agents/${REF}/presentation`))).toMatchObject({ agent_ref: REF, display_name: null, portrait: null });
    const saved = await json(await ctx.call('PUT', `/agents/${REF}/presentation`, { body: { display_name: 'Story Lead', portrait: { preset: 'silhouette-a', accent: 'amber', emblem: 'crown' } } }));
    expect(saved).toMatchObject({ display_name: 'Story Lead', updated_by: 'operator' });
    const project = await createProject(ctx);
    const reference = await json(await ctx.call('POST', `/projects/${project.id}/files?name=a.md`, { raw: '# A', headers: { 'content-type': 'text/markdown' } }));
    expect((await ctx.call('PUT', `/agents/${REF}/presentation`, { body: { display_name: null, portrait: null, avatar_file_id: reference.id } })).status).toBe(422);
    expect((await ctx.call('GET', '/agents/not-a-ref/presentation')).status).toBe(404);

    expect(await json(await ctx.call('GET', `/agents/${REF}/draft`))).toEqual({ draft: null });
    const draft = await json(await ctx.call('PUT', `/agents/${REF}/draft`, { body: { draft: { soul: 'Calm and exact.', model: 'fixture-alias' } } }));
    expect(draft.draft).toMatchObject({ agent_ref: REF, user_id: 'operator', draft: { soul: 'Calm and exact.', model: 'fixture-alias' },
      base: { soul_revision: digest(`# soul of ${REF}\n`) } });
    expect(draft.draft.base.identity_revision).toBeUndefined();
    expect(ctx.magnus.calls.find(call => call.path.endsWith('/identity/soul'))?.actingSubject).toBe('subject-operator');
    expect(await json(await ctx.call('DELETE', `/agents/${REF}/draft`))).toEqual({ draft: null });
    expect(ctx.store.agents.draft(REF, 'operator')).toBeUndefined();
  });
});

describe('preview', () => {
  it('streams a preview task with the draft as overrides, and refuses agents that cannot preview', async () => {
    ctx = await createTestContext();
    ctx.magnus.studio.set('node1', 1);
    const refused = await preview({ prompt: 'Introduce yourself.' });
    expect(refused.response.status).toBe(409);
    expect((await json(refused.response)).error.code).toBe('PREVIEW_UNAVAILABLE');
    ctx.magnus.studio.set('node1', 2);

    await ctx.call('PUT', `/agents/${REF}/draft`, { body: { draft: { soul: 'Calm and exact.', skills_enabled: ['research'] } } });
    const run = await preview({ prompt: 'Introduce yourself.' }, 'fixture-preview-1');
    expect(run.response.status).toBe(200);
    const [task] = await ctx.magnus.submitted(1);
    expect(task).toMatchObject({ context: 'preview', prompt: 'Introduce yourself.', body: { overrides: { soul: 'Calm and exact.', skills_enabled: ['research'] }, idempotency_key: 'studio-preview:fixture-preview-1' } });
    expect([...ctx.magnus.sessions.values()][0]).toMatchObject({ key: 'studio-preview:operator', context: 'preview' });
    expect(ctx.magnus.calls.find(call => (call.body as { action?: string } | undefined)?.action === 'preview-submit')?.actingSubject).toBe('subject-operator');
    await waitFor(() => ctx.magnus.openStreams(task!.id));
    ctx.magnus.setState(task!.id, 'running');
    ctx.magnus.delta(task!.id, 1, 'I am ');
    ctx.magnus.delta(task!.id, 1, 'calm.');
    ctx.magnus.finish(task!.id, { state: 'completed', result: 'I am calm and exact.' });
    await run.reading;
    expect(run.events.map(event => event.event)).toEqual(['preview.accepted', 'preview.event', 'preview.delta', 'preview.delta', 'preview.event', 'preview.done']);
    expect(JSON.parse(run.events[0]!.data)).toEqual({ task_id: task!.id, session_id: [...ctx.magnus.sessions.values()][0]!.id });
    expect(JSON.parse(run.events[1]!.data)).toEqual({ sequence: 1, kind: 'state' });
    expect(JSON.parse(run.events.at(-1)!.data)).toEqual({ task_id: task!.id, state: 'completed', result: 'I am calm and exact.', error: null });
    // Nothing about the agent changed.
    expect(ctx.magnus.calls.some(call => ['identity-save', 'skill-set', 'config-save'].includes((call.body as { action?: string } | undefined)?.action ?? ''))).toBe(false);

    const again = await preview({ prompt: 'Introduce yourself.' }, 'fixture-preview-1');
    await again.reading;
    expect(ctx.magnus.tasks.size).toBe(1);
    expect(again.events.at(-1)!.event).toBe('preview.done');
    const saved = await preview({ prompt: 'Plain run.', use_draft: false, new_session: true });
    const [, plain] = await ctx.magnus.submitted(2);
    expect(plain!.body.overrides).toBeUndefined();
    saved.close();
  });
});

describe('apply', () => {
  const action = (call: { body?: unknown }) => (call.body as { action?: string } | undefined)?.action;

  it('reports each part: Magnus refusals as they are, and applied parts against their base revisions', async () => {
    ctx = await createTestContext();
    ctx.magnus.allowAgentEdits = false;
    ctx.magnus.skillMap.set(REF, [{ name: 'research', enabled: false }, { name: 'mapping', enabled: true }]);
    await ctx.call('PUT', `/agents/${REF}/draft`, { body: { base: { config_revision: 'c'.repeat(64) }, draft: { soul: 'Calm and exact.', skills_enabled: ['research'], model: 'fixture-alias' } } });
    const refused = await json(await ctx.call('POST', `/agents/${REF}/apply`, { body: { parts: ['model', 'soul', 'identity', 'skills'] } }));
    expect(refused.results).toEqual([
      { part: 'soul', status: 'failed', error: 'Action identity-save is not allowed for this identity', code: 'FORBIDDEN', revision: null, activation_required: false },
      { part: 'identity', status: 'unchanged', error: null, code: null, revision: null, activation_required: false },
      { part: 'skills', status: 'failed', error: 'Action skill-set is not allowed for this identity', code: 'FORBIDDEN', revision: null, activation_required: false },
      { part: 'model', status: 'failed', error: 'Resource config is not allowed for this identity', code: 'FORBIDDEN', revision: null, activation_required: false },
    ]);
    expect(refused).toMatchObject({ activation_required: false, restart: { available: false, reason: expect.stringContaining('Magnus console') } });
    expect(refused.draft.draft).toEqual({ soul: 'Calm and exact.', skills_enabled: ['research'], model: 'fixture-alias' });

    ctx.magnus.allowAgentEdits = true;
    const project = await createProject(ctx);
    await publishTeam(ctx, project.id);
    await ctx.call('POST', `/projects/${project.id}/tasks`, { body: { title: 'Plan', role_key: 'lead' } });
    await waitFor(() => ctx.store.tasks.list(project.id)[0]!.ardent.task_id);
    const mark = ctx.magnus.calls.length;
    const applied = await json(await ctx.call('POST', `/agents/${REF}/apply`, { body: { parts: ['soul', 'skills'] } }));
    expect(applied.results).toMatchObject([{ part: 'soul', status: 'applied', revision: digest('Calm and exact.'), activation_required: false },
      { part: 'skills', status: 'applied', revision: ctx.magnus.configOf(REF).revision, activation_required: true }]);
    expect(ctx.magnus.identityOf(REF, 'soul').text).toBe('Calm and exact.');
    expect(ctx.magnus.skillMap.get(REF)).toEqual([{ name: 'research', enabled: true }, { name: 'mapping', enabled: false }]);
    // Each skill change is based on the revision the previous one answered.
    const skillCalls = ctx.magnus.calls.slice(mark).filter(call => action(call) === 'skill-set');
    expect(skillCalls.map(call => (call.body as { body: { revision: string } }).body.revision)).toEqual(['c'.repeat(64), digest(`${'c'.repeat(64)}:research`)]);
    expect(skillCalls.every(call => call.actingSubject === 'subject-operator')).toBe(true);
    expect(applied.active_tasks).toBe(1);
    expect(applied.activation_required).toBe(true);
    expect(applied.note).toBe('Applies from the agent\'s next turn; 1 running task keeps current instructions. Skill and model changes take effect after the agent\'s profile restarts; restart it from the Magnus console.');
    // The model is still to apply, now based on the revision the skill changes produced.
    expect(applied.draft).toMatchObject({ draft: { model: 'fixture-alias' }, base: { config_revision: ctx.magnus.configOf(REF).revision } });
    expect(ctx.magnus.calls.some(call => action(call) === 'service-restart')).toBe(false);

    await ctx.call('PUT', `/agents/${REF}/draft`, { body: { base: { soul_revision: 'a'.repeat(64) }, draft: { soul: 'Stale edit.' } } });
    const stale = await json(await ctx.call('POST', `/agents/${REF}/apply`, { body: { parts: ['soul'] } }));
    expect(stale.results[0]).toMatchObject({ part: 'soul', status: 'failed', code: 'CONFLICT', error: expect.stringContaining('changed since this draft was saved') });
    expect(ctx.magnus.identityOf(REF, 'soul').text).toBe('Calm and exact.');
    expect((await ctx.call('POST', '/agents/node2~mapper/apply', { body: { parts: ['soul'] } })).status).toBe(409);
  });

  it('applies the model with config-save, changing only the model setting of the configured backend', async () => {
    ctx = await createTestContext();
    const saved = await json(await ctx.call('PUT', `/agents/${REF}/draft`, { body: { draft: { model: 'emberpath/story-large' } } }));
    expect(saved.draft.base).toEqual({ config_revision: 'c'.repeat(64) });
    expect(ctx.magnus.calls.find(call => call.path.endsWith('/config'))?.actingSubject).toBe('subject-operator');
    const before = ctx.magnus.configOf(REF).text;
    const applied = await json(await ctx.call('POST', `/agents/${REF}/apply`, { body: { parts: ['model'] } }));
    const after = ctx.magnus.configOf(REF);
    expect(applied.results).toEqual([{ part: 'model', status: 'applied', error: null, code: null, revision: after.revision, activation_required: true }]);
    expect(applied).toMatchObject({ activation_required: true, draft: null, restart: { available: false } });
    expect(after.text).toBe(before.replace('model: fixture-model', 'model: emberpath/story-large'));
    const call = ctx.magnus.calls.find(item => action(item) === 'config-save')!;
    expect(call).toMatchObject({ actingSubject: 'subject-operator', body: { body: { revision: 'c'.repeat(64) } } });

    // Codex profiles keep their model under providers.codex; a stale base is refused before anything is sent.
    ctx.magnus.configs.set('node1~scout', { text: 'execution:\n  backend: codex\nproviders:\n  codex:\n    command: codex\n', revision: 'd'.repeat(64) });
    await ctx.call('PUT', '/agents/node1~scout/draft', { body: { base: { config_revision: 'e'.repeat(64) }, draft: { model: 'gpt-fixture' } } });
    const stale = await json(await ctx.call('POST', '/agents/node1~scout/apply', { body: { parts: ['model'] } }));
    expect(stale.results[0]).toMatchObject({ status: 'failed', code: 'CONFLICT' });
    expect(ctx.magnus.calls.filter(item => action(item) === 'config-save')).toHaveLength(1);
    await ctx.call('PUT', '/agents/node1~scout/draft', { body: { base: { config_revision: 'd'.repeat(64) }, draft: { model: 'gpt-fixture' } } });
    expect((await json(await ctx.call('POST', '/agents/node1~scout/apply', { body: { parts: ['model'] } }))).results[0].status).toBe('applied');
    expect(ctx.magnus.configOf('node1~scout').text).toBe('execution:\n  backend: codex\nproviders:\n  codex:\n    command: codex\n    model: gpt-fixture\n');
  });

  it('explains Magnus refusals of agent changes', async () => {
    ctx = await createTestContext();
    ctx.magnus.skillMap.set(REF, [{ name: 'web.search', enabled: false }]);
    await ctx.call('PUT', `/agents/${REF}/draft`, { body: { draft: { soul: 'Calm.', model: 'fixture-alias', skills_enabled: ['web.search'] } } });
    ctx.magnus.forbidConfig = true;
    const results = (await json(await ctx.call('POST', `/agents/${REF}/apply`, { body: { parts: ['skills', 'model'] } }))).results;
    expect(results).toMatchObject([{ part: 'skills', status: 'failed', code: 'INVALID_INPUT' },
      { part: 'model', status: 'failed', code: 'CONFIG_PATH_FORBIDDEN', error: 'Magnus refused a configuration change outside the settings Studio may change.' }]);

    ctx.magnus.admins.clear();
    expect((await json(await ctx.call('POST', `/agents/${REF}/apply`, { body: { parts: ['soul'] } }))).results[0])
      .toMatchObject({ code: 'ACTING_ADMIN_REQUIRED', error: expect.stringContaining('Magnus ADMIN') });
    ctx.magnus.unlinked.add('subject-operator');
    expect((await json(await ctx.call('POST', `/agents/${REF}/apply`, { body: { parts: ['soul'] } }))).results[0]).toMatchObject({ code: 'ACTING_SUBJECT_UNLINKED' });
    // Without a readable configuration the draft has no configuration base, and Apply says so.
    await ctx.call('PUT', `/agents/${REF}/draft`, { body: { draft: { model: 'other-alias' } } });
    expect((await json(await ctx.call('POST', `/agents/${REF}/apply`, { body: { parts: ['model'] } }))).results[0]).toMatchObject({ code: 'CONFIG_REVISION_REQUIRED' });
  });
});

describe('development records', () => {
  it('lists records with Studio comments, relays a comment as an operator note, and says when a runtime has none', async () => {
    ctx = await createTestContext();
    ctx.magnus.development.set(REF, [
      { id: 'dev_1', agent_ref: REF, kind: 'self_understanding', title: 'I work best with outlines', body: 'Outlines first.', author: 'agent', epistemic: 'agent_reported',
        before_sha256: null, after_sha256: null, sources: [{ kind: 'task', ref: 'task-1' }], created_at: '2026-11-08T00:00:00.000Z' },
      { id: 'dev_2', agent_ref: REF, kind: 'identity_revision', title: 'Soul edited', body: '', author: 'runtime', epistemic: 'observed',
        before_sha256: 'a'.repeat(64), after_sha256: 'b'.repeat(64), sources: [], created_at: '2026-11-08T01:00:00.000Z' },
    ]);
    const posted = await ctx.call('POST', `/agents/${REF}/development/dev_1/comments`, { body: { body_md: 'Agreed: keep outlining.', relay_to_agent: true } });
    expect(posted.status).toBe(201);
    expect(await json(posted)).toMatchObject({ comment: { record_ref: 'dev_1', author: 'operator' }, relayed: true, relay_error: null });
    expect(ctx.magnus.notes).toEqual([{ ref: REF, actingSubject: 'subject-operator', body: { kind: 'operator_comment', title: 'Comment on dev_1', body: 'Agreed: keep outlining.', sources: [{ kind: 'note', ref: 'dev_1' }], author: 'operator' } }]);
    const page = await json(await ctx.call('GET', `/agents/${REF}/development?limit=1`));
    expect(page).toMatchObject({ supported: true, next: 'dev_1', records: [{ id: 'dev_1', epistemic: 'agent_reported', comments: [{ body_md: 'Agreed: keep outlining.' }] }] });
    expect((await json(await ctx.call('GET', `/agents/${REF}/development?after=dev_1`))).records.map((record: { id: string }) => record.id)).toEqual(['dev_2']);

    ctx.magnus.studio.set('node2', 1);
    const old = await json(await ctx.call('GET', '/agents/node2~mapper/development'));
    expect(old).toMatchObject({ supported: false, records: [], next: null, reason: 'Upgrade the Magnus agent on Node node2' });
    const relayed = await json(await ctx.call('POST', '/agents/node2~mapper/development/dev_9/comments', { body: { body_md: 'Note', relay_to_agent: true } }));
    expect(relayed).toMatchObject({ relayed: false, relay_error: 'Upgrade the Magnus agent on Node node2' });
  });
});

describe('New Agent', () => {
  it('creates an agent through Magnus for an ADMIN person and relays the operation to the project stream', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const template = ctx.store.templates.list({ kind: 'agent', archived: 'false' })[0]!;
    const version = ctx.store.templates.version(template.id, 1)!;
    ctx.magnus.admins.clear();
    const refused = await ctx.call('POST', '/agents', { body: { node_id: 'node3', profile: 'cartographer', template: { template_id: template.id, version: 1 }, model: { emberpath_alias: 'fixture' } } });
    expect(refused.status).toBe(403);
    expect((await json(refused)).error.code).toBe('ACTING_ADMIN_REQUIRED');
    ctx.magnus.admins.add('subject-operator');
    expect((await ctx.call('POST', '/agents', { body: { node_id: 'node3', profile: 'blank', model: { emberpath_alias: 'fixture' } } })).status).toBe(422);
    expect((await ctx.call('POST', '/agents', { body: { node_id: 'node3', profile: 'x', soul_md: 'S', identity_md: 'I', model: { base_url: 'https://user:pw@llm.example.com', model: 'm' } } })).status).toBe(400);

    const created = await ctx.call('POST', '/agents', { body: { node_id: 'node3', profile: 'cartographer', template: { template_id: template.id, version: 1 }, model: { emberpath_alias: 'fixture' },
      project_id: project.id, role_key: 'mapper' } });
    expect(created.status).toBe(201);
    const operation = await json(created);
    expect(operation).toMatchObject({ agent_ref: 'node3~cartographer', project_id: project.id, role_key: 'mapper', status: 'running' });
    const request = ctx.magnus.calls.find(call => call.method === 'POST' && call.path === '/api/v1/ardent/agents')!;
    const body = version.kind === 'agent' ? version.body : undefined;
    expect(request.actingSubject).toBe('subject-operator');
    expect(request.body).toMatchObject({ nodeId: 'node3', profile: 'cartographer', soul_md: body!.soul_md, identity_md: body!.identity_md, hivemem: true, model: { emberpath_alias: 'fixture' } });
    expect(ctx.store.agents.presentation('node3~cartographer')).toMatchObject({ display_name: body!.name, portrait: body!.avatar_preset });

    await waitFor(() => ctx.magnus.calls.some(call => call.path.endsWith(`/operations/${operation.id}/stream`)));
    const now = new Date().toISOString();
    ctx.magnus.updateOperation(operation.id, { steps: [{ name: 'profile-create', status: 'succeeded', startedAt: now, finishedAt: now, receipt: { profile: 'cartographer' }, error: null },
      { name: 'hivemem-enroll', status: 'running', startedAt: now, finishedAt: null, receipt: null, error: null }] });
    await waitFor(() => ctx.store.events.after(project.id, 0).filter(event => event.type === 'agent.operation.updated').length >= 3);
    ctx.magnus.updateOperation(operation.id, { status: 'succeeded', completedAt: now });
    await waitFor(() => ctx.store.agents.operation(operation.id)!.status === 'succeeded');
    const events = ctx.store.events.after(project.id, 0).filter(event => event.type === 'agent.operation.updated').map(event => event.payload.operation as { status: string; steps: unknown[] });
    expect(events.at(-1)).toMatchObject({ status: 'succeeded', steps: [{ name: 'profile-create', status: 'succeeded', receipt: { profile: 'cartographer' } }, { name: 'hivemem-enroll' }] });
    const fetched = await json(await ctx.call('GET', `/agents/operations/${operation.id}`));
    expect(fetched).toMatchObject({ id: operation.id, status: 'succeeded', kind: 'deploy' });
    expect((await ctx.call('GET', '/agents/operations/unknown-operation')).status).toBe(404);
  });
});
