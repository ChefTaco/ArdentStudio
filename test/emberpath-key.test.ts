// The Emberpath client key New Agent and Create agent from definition relay to Magnus (Magnus #164): write-only,
// passed on in one request, never stored, logged, audited, fingerprinted or returned.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_DEFINITION_EMBERPATH_KEY_PATTERN } from '@hivemagnus/magnus-contracts/agent-definition';
import { ARDENT_EMBERPATH_CLIENT_KEY_PATTERN } from '@hivemagnus/magnus-contracts/ardent-service';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';
import { emberpathRefusal, forgetEmberpathKey } from '../src/server/emberpath-key.js';
import { EMBERPATH_CLIENT_KEY_PATTERN, emberpathClientKeySchema } from '../src/shared/browser.js';
import { createProject, createTestContext, EMBERPATH_KEY, json, waitFor, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(() => ctx?.close());

const OTHER_KEY = 'fixture-emberpath-client-key-0002';
const REFUSED_KEY = 'fixture-emberpath-client-key-0403';
const ALL_BOUND = { hivemem: 'default' };
const agentBody = (backend: 'any' | 'codex' = 'any') => ({
  name: 'Archivist', category: 'research', purpose: 'Keeps the project archive tidy.', example_uses: ['Index notes'],
  soul_md: '# Archivist\n\nOrderly and kind.', identity_md: '# Identity\n\nThe project archivist.', skills: [],
  model_hint: 'research-large', runtime_req: { ardent: '>=3.2.0', backend }, integrations: ['hivemem'],
  expected_outputs: ['Index'], avatar_preset: { preset: 'silhouette-a', accent: 'blue', emblem: 'book' },
});

async function agentTemplate(backend: 'any' | 'codex' = 'any'): Promise<string> {
  const created = await ctx.call('POST', '/templates', { body: { kind: 'agent', body: agentBody(backend) } });
  expect(created.status).toBe(201);
  return (await json<{ id: string }>(created)).id;
}
const keyOf = (call: { body?: unknown }) => (call.body as { emberpath_client_key?: string } | undefined)?.emberpath_client_key;
const sentTo = (path: string) => ctx.magnus.calls.filter(call => call.method === 'POST' && call.path === path);

describe('Emberpath client key', () => {
  it('keeps the browser contract pattern equal to the published Magnus contract', () => {
    // The browser contract imports only zod, so it repeats Magnus's pattern; it must not drift from magnus-contracts.
    expect(EMBERPATH_CLIENT_KEY_PATTERN.source).toBe(ARDENT_EMBERPATH_CLIENT_KEY_PATTERN.source);
    expect(EMBERPATH_CLIENT_KEY_PATTERN.flags).toBe(ARDENT_EMBERPATH_CLIENT_KEY_PATTERN.flags);
    expect(AGENT_DEFINITION_EMBERPATH_KEY_PATTERN.source).toBe(ARDENT_EMBERPATH_CLIENT_KEY_PATTERN.source);
  });

  it('has the pattern Magnus checks, and is refused malformed without echoing it or calling Magnus', async () => {
    for (const good of [EMBERPATH_KEY, 'a'.repeat(16), `${'A1._~+/=-'.repeat(56)}abcdefgh`]) expect(emberpathClientKeySchema.safeParse(good).success, good.slice(0, 20)).toBe(true);
    for (const bad of ['short-key', 'a'.repeat(513), 'fixture key with spaces', `${EMBERPATH_KEY}\n`, 'fixture-emberpath-key-ü-0001']) {
      expect(emberpathClientKeySchema.safeParse(bad).success, JSON.stringify(bad.slice(0, 20))).toBe(false);
    }
    ctx = await createTestContext();
    const template = await agentTemplate();
    const bad = 'fixture key with spaces 0001';
    for (const [path, body] of [
      [`/templates/${template}/versions/1/deploy-check`, { node_id: 'node3', emberpath_client_key: bad }],
      [`/templates/${template}/versions/1/deploy`, { node_id: 'node3', profile: 'archivist', bindings: ALL_BOUND, emberpath_client_key: bad }],
      ['/agents', { node_id: 'node3', profile: 'mapper', soul_md: 'S', identity_md: 'I', model: { emberpath_alias: 'fixture' }, emberpath_client_key: bad }],
    ] as const) {
      const refused = await ctx.call('POST', path, { body });
      expect(refused.status, path).toBe(400);
      const text = await refused.text();
      expect(JSON.parse(text).error).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ path: 'emberpath_client_key' }] });
      expect(text).not.toContain(bad);
    }
    expect(ctx.magnus.calls.filter(call => call.method === 'POST')).toEqual([]);
  });

  it('is checked by Magnus on deploy-check: missing, refused and accepted', async () => {
    ctx = await createTestContext();
    const template = await agentTemplate();
    const check = async (body: Record<string, unknown>) => (await json<{ preflight: { ok: boolean; problems: Array<{ code: string; detail: string }> } }>(
      await ctx.call('POST', `/templates/${template}/versions/1/deploy-check`, { body }))).preflight;

    expect(await check({ node_id: 'node3', bindings: ALL_BOUND })).toEqual({ ok: false, problems: [{ code: 'SECRET_UNBOUND', detail: expect.stringMatching(/^Emberpath key missing/) }] });
    ctx.magnus.emberpathRefusals.set(REFUSED_KEY, { status: 422, code: 'EMBERPATH_KEY_FORBIDDEN', message: 'Emberpath refused the client key (403)' });
    expect(await check({ node_id: 'node3', bindings: ALL_BOUND, emberpath_client_key: REFUSED_KEY })).toEqual({ ok: false, problems: [
      { code: 'SECRET_UNBOUND', detail: 'emberpath_client_key: Emberpath refused the client key (403)' }] });
    expect(await check({ node_id: 'node3', bindings: ALL_BOUND, emberpath_client_key: EMBERPATH_KEY })).toEqual({ ok: true, problems: [] });
    expect(sentTo('/api/v1/ardent/agent-definitions/validate').map(keyOf)).toEqual([undefined, REFUSED_KEY, EMBERPATH_KEY]);

    // A codex agent has no Emberpath alias: no key needed.
    const codex = await agentTemplate('codex');
    const codexCheck = await json<{ preflight: unknown }>(await ctx.call('POST', `/templates/${codex}/versions/1/deploy-check`, { body: { node_id: 'node3', bindings: ALL_BOUND } }));
    expect(codexCheck.preflight).toEqual({ ok: true, problems: [] });
  });

  it('is relayed to the definition install; without it or refused, nothing is created', async () => {
    ctx = await createTestContext();
    const template = await agentTemplate();
    const deploy = (body: Record<string, unknown>) => ctx.call('POST', `/templates/${template}/versions/1/deploy`, { body });

    const missing = await deploy({ node_id: 'node3', profile: 'archivist', bindings: ALL_BOUND });
    expect(missing.status).toBe(409);
    expect((await json(missing)).error).toMatchObject({ code: 'PREFLIGHT_FAILED', details: { problems: [{ code: 'SECRET_UNBOUND', detail: expect.stringMatching(/^Emberpath key missing/) }] } });
    ctx.magnus.emberpathRefusals.set(REFUSED_KEY, { status: 422, code: 'EMBERPATH_KEY_INVALID', message: 'Emberpath does not know the client key (401)' });
    const refused = await deploy({ node_id: 'node3', profile: 'archivist', bindings: ALL_BOUND, emberpath_client_key: REFUSED_KEY });
    expect((await json(refused)).error).toMatchObject({ code: 'PREFLIGHT_FAILED', details: { problems: [{ code: 'SECRET_UNBOUND', detail: 'emberpath_client_key: Emberpath does not know the client key (401)' }] } });
    expect(ctx.magnus.operations.size).toBe(0);
    expect(ctx.store.agents.presentation('node3~archivist')).toBeUndefined();

    const created = await deploy({ node_id: 'node3', profile: 'archivist', bindings: ALL_BOUND, emberpath_client_key: EMBERPATH_KEY });
    expect(created.status).toBe(201);
    expect(sentTo('/api/v1/ardent/agent-definitions/install').at(-1)!.body).toMatchObject({ nodeId: 'node3', name: 'archivist', bindings: ALL_BOUND, emberpath_client_key: EMBERPATH_KEY });
  });

  it('passes Magnus\'s EMBERPATH_* refusals on with their codes', async () => {
    ctx = await createTestContext();
    const newAgent = (key?: string) => ctx.call('POST', '/agents', { body: { node_id: 'node3', profile: 'mapper', soul_md: 'S', identity_md: 'I', model: { emberpath_alias: 'fixture' },
      ...(key !== undefined ? { emberpath_client_key: key } : {}) } });
    const missing = await newAgent();
    expect(missing.status).toBe(400);
    expect((await json(missing)).error).toMatchObject({ code: 'EMBERPATH_KEY_REQUIRED', message: expect.stringMatching(/^Emberpath key missing/) });
    for (const [status, code] of [[422, 'EMBERPATH_KEY_INVALID'], [422, 'EMBERPATH_KEY_FORBIDDEN'], [422, 'EMBERPATH_ALIAS_UNAVAILABLE'], [409, 'EMBERPATH_NOT_EXPLICIT'], [503, 'EMBERPATH_UNAVAILABLE']] as const) {
      ctx.magnus.emberpathRefusals.set(REFUSED_KEY, { status, code, message: `Refused: ${code}` });
      const answer = await newAgent(REFUSED_KEY);
      expect(answer.status, code).toBe(status);
      expect((await json(answer)).error, code).toEqual({ code, message: `Refused: ${code}` });
    }
    expect(ctx.magnus.operations.size).toBe(0);
    // Only EMBERPATH_ codes at the statuses Magnus uses are passed on.
    expect(emberpathRefusal({ status: 500, code: 'EMBERPATH_KEY_INVALID', message: 'x' })).toBeUndefined();
    expect(emberpathRefusal({ status: 422, code: 'MAGNUS_REJECTED', message: 'x' })).toBeUndefined();
    const input: { emberpath_client_key?: string; node_id: string } = { emberpath_client_key: EMBERPATH_KEY, node_id: 'node3' };
    forgetEmberpathKey(input);
    expect(input).toEqual({ node_id: 'node3' });
  });

  it('replays an idempotent deploy whatever key it carries, and refuses the same idempotency key without one', async () => {
    ctx = await createTestContext();
    const template = await agentTemplate();
    const body = { node_id: 'node3', profile: 'archivist', bindings: ALL_BOUND };
    const first = await ctx.call('POST', `/templates/${template}/versions/1/deploy`, { body: { ...body, emberpath_client_key: EMBERPATH_KEY }, key: 'fixture-deploy-0001' });
    expect(first.status).toBe(201);
    const again = await ctx.call('POST', `/templates/${template}/versions/1/deploy`, { body: { ...body, emberpath_client_key: OTHER_KEY }, key: 'fixture-deploy-0001' });
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect((await json(again)).id).toBe((await json(first)).id);
    expect(sentTo('/api/v1/ardent/agent-definitions/install')).toHaveLength(1);
    const without = await ctx.call('POST', `/templates/${template}/versions/1/deploy`, { body, key: 'fixture-deploy-0001' });
    expect(without.status).toBe(409);
    expect((await json(without)).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('is never stored: not in any row, file, log line, event, audit record or answer', async () => {
    const lines: string[] = [];
    ctx = await createTestContext({ logger: createLogger('debug', line => lines.push(line)) });
    const project = await createProject(ctx);
    const template = await agentTemplate();
    const answers: string[] = [];
    const sentBodies: string[] = [];
    const call = async (path: string, body: Record<string, unknown>) => {
      const text = JSON.stringify(body);
      sentBodies.push(text);
      const response = await ctx.call('POST', path, { body });
      answers.push(`${[...response.headers].map(([name, value]) => `${name}: ${value}`).join('\n')}\n${await response.clone().text()}`);
      return response;
    };

    await call(`/templates/${template}/versions/1/deploy-check`, { node_id: 'node3', bindings: ALL_BOUND, emberpath_client_key: EMBERPATH_KEY });
    ctx.magnus.emberpathRefusals.set(REFUSED_KEY, { status: 422, code: 'EMBERPATH_KEY_INVALID', message: 'Emberpath does not know the client key (401)' });
    await call(`/templates/${template}/versions/1/deploy`, { node_id: 'node3', profile: 'archivist', bindings: ALL_BOUND, emberpath_client_key: REFUSED_KEY, project_id: project.id });
    await call('/agents', { node_id: 'node3', profile: 'refused', soul_md: 'S', identity_md: 'I', model: { emberpath_alias: 'fixture' }, emberpath_client_key: REFUSED_KEY });
    const deployed = await call(`/templates/${template}/versions/1/deploy`, { node_id: 'node3', profile: 'archivist', bindings: ALL_BOUND, emberpath_client_key: EMBERPATH_KEY, project_id: project.id, role_key: 'archivist' });
    expect(deployed.status).toBe(201);
    const created = await call('/agents', { node_id: 'node3', profile: 'mapper', soul_md: 'S', identity_md: 'I', model: { emberpath_alias: 'fixture' }, emberpath_client_key: OTHER_KEY, project_id: project.id });
    expect(created.status).toBe(201);
    // Magnus had each key; the operations run to the end and are relayed and stored.
    expect(sentTo('/api/v1/ardent/agent-definitions/install').map(keyOf)).toEqual([REFUSED_KEY, EMBERPATH_KEY]);
    expect(sentTo('/api/v1/ardent/agents').map(keyOf)).toEqual([REFUSED_KEY, OTHER_KEY]);
    for (const operation of [await json<{ id: string }>(deployed), await json<{ id: string }>(created)]) {
      await waitFor(() => ctx.magnus.calls.some(call => call.path.endsWith(`/operations/${operation.id}/stream`)));
      ctx.magnus.updateOperation(operation.id, { status: 'succeeded', completedAt: new Date().toISOString() });
      await waitFor(() => ctx.store.agents.operation(operation.id)!.status === 'succeeded');
      answers.push(await (await ctx.call('GET', `/agents/operations/${operation.id}`)).text());
    }
    answers.push(await (await ctx.call('GET', '/audit/export')).text());
    expect(ctx.store.events.after(project.id, 0).some(event => event.type === 'agent.operation.updated')).toBe(true);

    const secrets = [EMBERPATH_KEY, OTHER_KEY, REFUSED_KEY];
    // Nor a digest of a request body that carried one (the idempotency fingerprint hashes the body).
    const digests = sentBodies.flatMap(text => [createHash('sha256').update(text).digest('hex'), createHash('sha256').update(`${text}\u0000`).digest('hex')]);
    const db = ctx.store.db;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name);
    expect(tables).toContain('idempotency_keys');
    const rows = JSON.stringify(Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()])));
    expect(rows).toContain('agent.create');
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap(name => statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]);
    })(ctx.dir);
    expect(files.some(file => file.endsWith('studio.sqlite'))).toBe(true);
    const stored = files.map(file => readFileSync(file).toString('latin1')).join('\n');
    for (const secret of [...secrets, ...digests]) {
      expect(rows).not.toContain(secret);
      expect(stored).not.toContain(secret);
      expect(lines.join('\n')).not.toContain(secret);
      expect(answers.join('\n')).not.toContain(secret);
    }
  });
});
