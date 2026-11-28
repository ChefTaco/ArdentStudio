import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSseStream } from '@hivemagnus/hive-common/sse';
import { ARDENT_STUDIO_API_PREFIX, purgeProjectResponseSchema } from '../src/shared/browser.js';
import { createProject, createTestContext, json, ManualClock, NOT_ADMIN, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(() => ctx?.close());

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const upload = (projectId: string, body: BodyInit, type: string, query: string) =>
  ctx.call('POST', `/projects/${projectId}/files?${query}`, { raw: body, headers: { 'content-type': type } });
const purge = (projectId: string, confirm: string, options: { token?: string; key?: string } = {}) =>
  ctx.call('POST', `/projects/${projectId}/purge`, { body: { confirm_name: confirm }, ...options });
const count = (sql: string, ...args: unknown[]) => (ctx.store.db.prepare(sql).get(...args) as { n: number }).n;

/** A project with a reference file (indexed), an attachment, a link (indexed) and a decision, then archived. */
async function populated(clock: ManualClock) {
  const project = await createProject(ctx, { name: 'Old Campaign' });
  const reference = await json(await upload(project.id, '# Lore\n\nThe fen is old.', 'text/markdown', 'name=lore.md'));
  const attachment = await json(await upload(project.id, PNG, 'image/png', 'name=map.png&purpose=attachment'));
  const link = await json(await ctx.call('POST', `/projects/${project.id}/links`, { body: { url: 'https://example.com/fen', title: 'Fen notes' } }));
  await ctx.call('POST', `/projects/${project.id}/decisions`, { body: { title: 'Tone', statement_md: 'Keep it eerie.' } });
  await ctx.knowledge.idle(); await ctx.knowledge.runPass();
  expect(ctx.store.files.get(reference.id)!.knowledge.state).toBe('indexed');
  expect(ctx.store.links.get(link.id)!.knowledge.state).toBe('indexed');
  expect((await ctx.call('POST', `/projects/${project.id}/archive`)).status).toBe(200);
  // Past the blob grace period, so unreferenced bytes go at once.
  clock.advance(3600_000);
  return { project, reference, attachment, link };
}

describe('project purge', () => {
  it('refuses a project that is not archived, a wrong confirmation and a caller who is not an admin', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx, { name: 'Keep Me' });
    const code = async (response: Response) => [response.status, (await json(response)).error.code];
    expect(await code(await purge(project.id, 'Keep Me'))).toEqual([409, 'PROJECT_NOT_ARCHIVED']);
    expect((await ctx.call('POST', `/projects/${project.id}/archive`)).status).toBe(200);
    expect(await code(await purge(project.id, 'keep me'))).toEqual([422, 'CONFIRMATION_MISMATCH']);
    expect(await code(await purge(project.id, ' Keep Me'))).toEqual([422, 'CONFIRMATION_MISMATCH']);
    expect((await ctx.call('POST', `/projects/${project.id}/purge`, { body: {} })).status).toBe(400);
    // The creator owns the project, but purging needs ardentstudio:agents:admin.
    const owner = await ctx.token({ permissions: NOT_ADMIN });
    const forbidden = await purge(project.id, 'Keep Me', { token: owner });
    expect(forbidden.status).toBe(403);
    expect((await json(forbidden)).error).toMatchObject({ code: 'FORBIDDEN', details: { missing: ['ardentstudio:agents:admin'] } });
    expect((await ctx.call('POST', '/projects/prj_00000000000000000000000000/purge', { body: { confirm_name: 'x' } })).status).toBe(404);
    expect(ctx.store.projects.get(project.id)).toBeDefined();
    expect(ctx.store.audit.list({ targetId: project.id }).map(entry => entry.action)).not.toContain('project.purge');
  });

  it('removes every project record and unreferenced blob, retires its HiveMem sources and keeps the audit', async () => {
    const clock = new ManualClock();
    ctx = await createTestContext({ clock });
    const { project, reference, attachment, link } = await populated(clock);
    const kept = await createProject(ctx, { name: 'Other' });
    // The same bytes in another project stay.
    await upload(kept.id, PNG, 'image/png', 'name=same.png&purpose=attachment');
    const auditBefore = ctx.store.audit.list({ targetId: project.id }).length;
    await ctx.knowledge.idle();
    ctx.hivemem.syncs = [];

    const response = await purge(project.id, 'Old Campaign', { key: 'purge-key-0001' });
    expect(response.status).toBe(200);
    const result = purgeProjectResponseSchema.parse(await json(response));
    expect(result).toMatchObject({ project_id: project.id, name: 'Old Campaign', knowledge: { sources_retiring: 2 } });
    expect(result.removed).toMatchObject({ projects: 1, files: 2, links: 1, decisions: 1, team_assignments: 1 });
    expect(result.removed.events).toBeGreaterThan(3);

    expect(ctx.store.projects.get(project.id)).toBeUndefined();
    expect((await ctx.call('GET', `/projects/${project.id}`)).status).toBe(404);
    expect((await json(await ctx.call('GET', '/projects?status=all'))).projects.map((item: { id: string }) => item.id)).toEqual([kept.id]);
    for (const table of ['files', 'reference_links', 'decisions', 'events', 'project_event_cursors', 'team_assignments', 'requested_deliverables']) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'} = ?`, project.id), table).toBe(0);
    }
    // Bytes only this project used are gone; shared bytes stay.
    expect(ctx.blobs.get(reference.sha256)).toBeUndefined();
    expect(existsSync(join(ctx.dir, 'blobs', ctx.blobs.relativePath(reference.sha256)))).toBe(false);
    expect(ctx.blobs.get(attachment.sha256)).toBeDefined();

    // Audit rows stay, with the purge itself recorded.
    const audit = ctx.store.audit.list({ targetId: project.id });
    expect(audit).toHaveLength(auditBefore + 1);
    expect(audit.find(entry => entry.action === 'project.purge')).toMatchObject({ action: 'project.purge', actor_user_id: 'operator', detail: { name: 'Old Campaign', sources_retiring: 2 } });

    // The sources are retired with empty syncs; the workspace is left alone.
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    const retired = ctx.hivemem.syncs.filter(sync => sync.mode === 'apply');
    expect(retired.map(sync => [sync.source_id, sync.chunks.length, sync.workspace_id]).sort()).toEqual([
      [`ardentstudio:file:${reference.id}`, 0, project.hivemem.workspace_id],
      [`ardentstudio:link:${link.id}`, 0, project.hivemem.workspace_id],
    ]);
    expect(retired.every(sync => sync.revision.startsWith('retired:'))).toBe(true);
    expect(ctx.store.retirements.pending()).toBe(0);
    expect(ctx.hivemem.workspaces.has(project.hivemem.workspace_id)).toBe(true);

    // A replay answers the same; a new request finds nothing.
    const replay = await purge(project.id, 'Old Campaign', { key: 'purge-key-0001' });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await json(replay)).toEqual(result);
    expect((await purge(project.id, 'Old Campaign')).status).toBe(404);
  });

  it('keeps retrying a retirement HiveMem refuses', async () => {
    const clock = new ManualClock();
    ctx = await createTestContext({ clock });
    const { project } = await populated(clock);
    await ctx.knowledge.idle();
    // Each retirement makes one call (its preview), which fails.
    ctx.hivemem.failSync = 2;
    expect((await purge(project.id, 'Old Campaign')).status).toBe(200);
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    expect(ctx.store.retirements.pending(project.id)).toBe(2);
    expect(ctx.store.db.prepare('SELECT attempts, error FROM knowledge_retirements ORDER BY id').all()).toEqual([
      { attempts: 1, error: 'HiveMem answered HTTP 503' }, { attempts: 1, error: 'HiveMem answered HTTP 503' }]);
    await ctx.knowledge.runPass();
    expect(ctx.store.retirements.pending(project.id)).toBe(2);
    clock.advance(60_000);
    await ctx.knowledge.runPass();
    expect(ctx.store.retirements.pending(project.id)).toBe(0);
  });

  it('tells open streams and closes them, and refuses while tasks run or a portrait uses its file', async () => {
    const clock = new ManualClock();
    ctx = await createTestContext({ clock });
    const project = await createProject(ctx, { name: 'Streamed' });
    const avatar = await json(await upload(project.id, PNG, 'image/png', 'name=face.png&purpose=avatar'));
    ctx.store.agents.savePresentation({ agentRef: 'node1~lead', portrait: null, avatarFileId: avatar.id, displayName: 'Lead', updatedBy: 'operator' });
    expect((await ctx.call('POST', `/projects/${project.id}/archive`)).status).toBe(200);
    const inUse = await purge(project.id, 'Streamed');
    expect(inUse.status).toBe(409);
    expect((await json(inUse)).error).toMatchObject({ code: 'FILE_IN_USE', details: { agents: ['node1~lead'] } });
    ctx.store.agents.savePresentation({ agentRef: 'node1~lead', portrait: null, avatarFileId: null, displayName: 'Lead', updatedBy: 'operator' });

    const controller = new AbortController();
    const opened = await ctx.app.request(`${ARDENT_STUDIO_API_PREFIX}/projects/${project.id}/stream`, { headers: { authorization: `Bearer ${await ctx.token()}` }, signal: controller.signal });
    const iterator = parseSseStream(opened.body!, { requireData: true })[Symbol.asyncIterator]();
    expect((await purge(project.id, 'Streamed')).status).toBe(200);
    const message = await Promise.race([iterator.next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream timeout')), 3000))]);
    expect(message.value).toMatchObject({ event: 'project.purged' });
    expect(JSON.parse(message.value!.data)).toEqual({ project_id: project.id, at: clock.now().toISOString() });
    expect((await iterator.next()).done).toBe(true);
    controller.abort();
  });

  it('retires a source whose sync was in flight during the purge', async () => {
    const clock = new ManualClock();
    ctx = await createTestContext({ clock });
    const project = await createProject(ctx, { name: 'Racing' });
    await ctx.knowledge.idle();
    let release!: () => void;
    ctx.hivemem.gate = new Promise(resolve => { release = resolve; });
    const file = await json(await upload(project.id, '# Draft', 'text/markdown', 'name=draft.md'));
    const pass = ctx.knowledge.runPass();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ctx.store.files.get(file.id)!.knowledge.state).toBe('indexing');
    expect((await ctx.call('POST', `/projects/${project.id}/archive`)).status).toBe(200);
    expect(await json(await purge(project.id, 'Racing'))).toMatchObject({ knowledge: { sources_retiring: 1 } });
    ctx.hivemem.gate = undefined;
    release();
    await pass;
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    const last = ctx.hivemem.syncs.filter(sync => sync.source_id === `ardentstudio:file:${file.id}`).at(-1)!;
    expect(last).toMatchObject({ mode: 'apply', chunks: [] });
    expect(ctx.store.retirements.pending()).toBe(0);
  });
});
