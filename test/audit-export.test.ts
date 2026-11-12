import { encodeCursor } from '@hivemagnus/hive-common/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flattenDetails, toAuditRecord } from '../src/audit/export.js';
import { auditExportResponseSchema, hiveAuditRecordSchema, type HiveAuditRecord } from '../src/shared/browser.js';
import { createProject, createTestContext, json, type TestContext } from './helpers.js';

let ctx: TestContext;
let service: string;
// Built at runtime so the fixture is not a literal token in the source.
const fakeJwt = [{ alg: 'RS256' }, { sub: 'x' }, 'signature'].map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');
const urlSecret = ['abc123', 'secret', 'value'].join('');
const actor = { userId: 'operator', subject: 'subject-operator', issuer: 'https://identity.example.com' };

beforeAll(async () => {
  ctx = await createTestContext({ seed: false });
  service = await ctx.serviceToken();
  for (let index = 0; index < 5; index++) await createProject(ctx, { name: `Audit ${index}` });
  ctx.store.tx(() => {
    ctx.store.record(actor, 'agent.presentation', { type: 'agent', id: 'node-a~default' });
    ctx.store.record(actor, 'team.propose', { type: 'project', id: 'prj_01HZZZZZZZZZZZZZZZZZZZZZZZ' }, { proposal_id: 'p1', agent_ref: 'node-b~coder' });
    ctx.store.record(actor, 'link.create', { type: 'link', id: 'lnk_1' }, {
      url: `https://user:hunter2@example.com/doc?access_token=${urlSecret}`,
      token: `Bearer ${fakeJwt}`,
      password: 'correct horse battery staple',
      content: 'private memory content',
      nested: { secret: 'nested-secret' },
      roles: ['writer', 'editor'],
      results: [{ part: 'soul', status: 'ok' }],
    });
  });
});
afterAll(() => ctx?.close());

async function page(query = '', token: string | null = service): Promise<Response> {
  return ctx.call('GET', `/audit/export${query}`, { token });
}

async function readAll(limit: number): Promise<HiveAuditRecord[]> {
  const records: HiveAuditRecord[] = [];
  let after: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const response = await page(`?limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    expect(response.status).toBe(200);
    const body = auditExportResponseSchema.parse(await json(response));
    expect(body.data.length).toBeLessThanOrEqual(limit);
    records.push(...body.data);
    if (!body.nextCursor) return records;
    after = body.nextCursor;
  }
  throw new Error('paging did not end');
}

const native = (record: HiveAuditRecord) => Number(record.id.split(':').at(-1));

describe('GET /audit/export', () => {
  it('pages oldest first and round-trips the cursor without skips or repeats', async () => {
    const all = await readAll(200);
    expect(all.length).toBe(8);
    expect(all.map(native)).toEqual([...all.map(native)].sort((a, b) => a - b));
    expect(await readAll(3)).toEqual(all);
    expect(await readAll(1)).toEqual(all);
    expect(all.slice(0, 5).every(record => record.action === 'project.create')).toBe(true);
  });

  it('returns only records after the cursor, and null when caught up', async () => {
    const first = await json(await page('?limit=8'));
    expect(first.nextCursor).toBeNull();
    const two = await json(await page('?limit=2'));
    const rest = await json(await page(`?after=${two.nextCursor}`));
    expect(rest.data[0].id).toBe(`ardentstudio:audit:${native(two.data[1]) + 1}`);
    expect(rest.nextCursor).toBeNull();
    // A cursor at the end picks up records written later.
    const tail = encodeCursor({ id: native(first.data.at(-1)) });
    expect((await json(await page(`?after=${tail}`))).data).toEqual([]);
    ctx.store.tx(() => ctx.store.record(actor, 'project.archive', { type: 'project', id: 'prj_01HZZZZZZZZZZZZZZZZZZZZZZZ' }));
    const later = await json(await page(`?after=${tail}`));
    expect(later.data.map((record: HiveAuditRecord) => record.action)).toEqual(['project.archive']);
  });

  it('keeps record IDs stable across reads', async () => {
    const a = await json(await page());
    const b = await json(await page());
    expect(a.data.map((record: HiveAuditRecord) => record.id)).toEqual(b.data.map((record: HiveAuditRecord) => record.id));
    expect(new Set(a.data.map((record: HiveAuditRecord) => record.id)).size).toBe(a.data.length);
  });

  it('bounds limit: default 100, at most 200, and rejects 0 or junk', async () => {
    ctx.store.tx(() => { for (let index = 0; index < 250; index++) ctx.store.record(actor, 'project.update', { type: 'project', id: 'prj_01HZZZZZZZZZZZZZZZZZZZZZZZ' }, { fields: 'name' }); });
    expect((await json(await page())).data).toHaveLength(100);
    expect((await json(await page('?limit=500'))).data).toHaveLength(200);
    expect((await json(await page('?limit=1'))).data).toHaveLength(1);
    for (const bad of ['?limit=0', '?limit=-1', '?limit=abc', '?limit=1.5', '?limit=1&limit=2']) {
      const response = await page(bad);
      expect(response.status, bad).toBe(400);
      expect((await json(response)).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('answers 400 for a malformed cursor', async () => {
    for (const bad of ['not*base64', 'Zm9v', encodeCursor({ id: 'x' }), encodeCursor({ id: -1 }), encodeCursor({ id: 1, extra: 2 }), encodeCursor({ seq: 1 })]) {
      const response = await page(`?after=${encodeURIComponent(bad)}`);
      expect(response.status, bad).toBe(400);
      expect((await json(response)).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('authenticates: 401 without a token, 403 without the permission, service and admin accepted', async () => {
    expect((await page('', null)).status).toBe(401);
    expect((await page('', 'not-a-jwt')).status).toBe(401);
    expect((await page('', await ctx.serviceToken({ aud: 'hivemem' }))).status).toBe(401);
    expect((await page('', await ctx.serviceToken({ permissions: ['ardentstudio:projects:read'] }))).status).toBe(403);
    // A service token never carries Studio permissions other than audit:read, even when admin is in the token.
    expect((await page('', await ctx.serviceToken({ permissions: ['ardentstudio:agents:admin'] }))).status).toBe(403);
    expect((await page('', await ctx.token({ permissions: ['ardentstudio:projects:read', 'ardentstudio:projects:write'] }))).status).toBe(403);
    expect((await page('', await ctx.token({ sub: 'subject-viewer' }))).status).toBe(403);
    expect((await page('', await ctx.token({ sub: 'subject-unlinked', permissions: ['ardentstudio:audit:read'] }))).status).toBe(403);
    expect((await page('', service)).status).toBe(200);
    expect((await page('', await ctx.token({ permissions: ['ardentstudio:agents:admin'] }))).status).toBe(200);
    expect((await page('', await ctx.token({ permissions: ['ardentstudio:audit:read'] }))).status).toBe(200);
  });

  it('refuses service tokens everywhere else', async () => {
    const strong = await ctx.serviceToken({ permissions: ['ardentstudio:projects:read', 'ardentstudio:audit:read'] });
    expect((await ctx.call('GET', '/projects', { token: strong })).status).toBe(401);
  });

  it('passes every record through the schema in strict mode and leaks no secrets or content', async () => {
    const text = await (await page('?limit=200')).text();
    const body = auditExportResponseSchema.parse(JSON.parse(text));
    for (const record of body.data) expect(() => hiveAuditRecordSchema.parse(record)).not.toThrow();
    for (const leak of ['hunter2', urlSecret, fakeJwt.split('.')[0]!, 'correct horse', 'private memory content', 'nested-secret']) {
      expect(text).not.toContain(leak);
    }
    const link = body.data.find(record => record.action === 'link.create')!;
    expect(link.details.roles).toBe('writer,editor');
    expect(link.details.results_count).toBe(1);
    expect(link.details).not.toHaveProperty('content');
    expect(link.details).not.toHaveProperty('nested');
  });

  it('maps actors, targets and agent subjects', async () => {
    const body = await json(await page('?limit=200'));
    const created: HiveAuditRecord = body.data[0];
    expect(created).toMatchObject({ product: 'ardentstudio', outcome: 'success', action: 'project.create',
      actor: { type: 'user', id: 'subject-operator', issuer: 'https://identity.example.com', displayName: 'operator' }, target: { type: 'project' }, subject: {}, details: { name: 'Audit 0' } });
    expect(created.occurredAt).toMatch(/Z$/);
    const agent = body.data.find((record: HiveAuditRecord) => record.action === 'agent.presentation');
    expect(agent.subject).toEqual({ agentRef: 'node-a~default', nodeId: 'node-a' });
    const proposal = body.data.find((record: HiveAuditRecord) => record.action === 'team.propose');
    expect(proposal.subject).toEqual({ agentRef: 'node-b~coder', nodeId: 'node-b' });
  });
});

describe('toAuditRecord', () => {
  const entry = { id: 7, at: '2026-11-12T10:00:00.000Z', actor_user_id: 'system', actor_subject: null, actor_issuer: null, action: 'task.cancel', target_type: 'task', target_id: 'tsk_1', idempotency_key: 'secret-key-value', detail: { state: 'cancelled' } };

  it('maps a task to the agent it ran on and the system actor', () => {
    const record = toAuditRecord(entry, new Map([['tsk_1', 'node-c~writer']]));
    expect(hiveAuditRecordSchema.parse(record)).toEqual({
      id: 'ardentstudio:audit:7', product: 'ardentstudio', occurredAt: '2026-11-12T10:00:00.000Z', action: 'task.cancel', outcome: 'success',
      actor: { type: 'system', id: 'system' }, target: { type: 'task', id: 'tsk_1' }, subject: { agentRef: 'node-c~writer', nodeId: 'node-c' }, details: { state: 'cancelled' },
    });
    expect(JSON.stringify(record)).not.toContain('secret-key-value');
  });

  it('maps a service actor', () => {
    const record = toAuditRecord({ ...entry, actor_user_id: 'service:collector', actor_subject: 'collector', actor_issuer: 'https://identity.example.com' });
    expect(record.actor).toEqual({ type: 'service', id: 'collector', issuer: 'https://identity.example.com' });
  });

  it('caps details at 4 KB', () => {
    const detail = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, 'x'.repeat(400)]));
    const flat = flattenDetails(detail);
    expect(Buffer.byteLength(JSON.stringify(flat))).toBeLessThanOrEqual(4096);
    expect(flat.truncated).toBe(true);
  });
});
