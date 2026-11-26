import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, createTestContext, json, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(() => ctx?.close());

const upload = (projectId: string, body: BodyInit, type: string, query = 'name=style-guide.md') =>
  ctx.call('POST', `/projects/${projectId}/files?${query}`, { raw: body, headers: { 'content-type': type } });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const blobPath = (sha256: string) => join(ctx.dir, 'blobs', ctx.blobs.relativePath(sha256));

describe('uploads are checked against their type before anything is stored', () => {
  it('refuses bytes that are not what Content-Type says, and keeps no blob of them', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const blobs = () => (ctx.store.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n;
    const before = blobs();
    for (const [body, type] of [
      ['<html>not an image</html>', 'image/png'], ['GIF00a', 'image/gif'], ['plain text', 'application/pdf'], ['not a zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['{"open": ', 'application/json'], [Buffer.from([0x7b, 0xff, 0x7d]), 'application/json'], ['<html></html>', 'image/svg+xml'], [Buffer.from('a\u0000b'), 'text/plain'],
    ] as const) {
      const response = await upload(project.id, body, type, 'name=bad');
      expect(response.status, type).toBe(422);
      expect((await json(response)).error.code).toBe('CONTENT_MISMATCH');
    }
    expect(blobs()).toBe(before);
    expect(ctx.store.files.list(project.id)).toEqual([]);
  });

  it('accepts real content, including text in a legacy encoding', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    for (const [body, type] of [
      [PNG, 'image/png'], [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'], ['GIF89a....', 'image/gif'], ['RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'image/webp'],
      ['%PDF-1.7', 'application/pdf'], ['{"ok": [1, 2]}', 'application/json'], ['<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'],
      [Buffer.from('café;crème\n', 'latin1'), 'text/csv'], ['# Notes', 'text/markdown'],
    ] as const) {
      expect((await upload(project.id, body, type, `name=ok&purpose=attachment`)).status, type).toBe(201);
    }
  });
});

describe('file deletion', () => {
  it('deletes an unindexed file at once: gone from the project, not served, audited and announced', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const file = await json(await upload(project.id, PNG, 'image/png', 'name=map.png&purpose=attachment'));
    expect((await ctx.call('GET', `/blobs/${file.sha256}`)).status).toBe(200);

    const response = await ctx.call('DELETE', `/files/${file.id}`);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ file: { id: file.id, name: 'map.png' }, knowledge: 'none', deleted_at: expect.any(String) });
    expect(ctx.store.files.stored(file.id)).toBeUndefined();
    expect((await json(await ctx.call('GET', `/projects/${project.id}/files`))).files).toEqual([]);
    expect((await ctx.call('GET', `/blobs/${file.sha256}`)).status).toBe(404);
    expect((await ctx.call('DELETE', `/files/${file.id}`)).status).toBe(404);
    expect((await ctx.call('POST', `/files/${file.id}/reindex`)).status).toBe(404);
    expect(ctx.store.events.after(project.id, 0).at(-1)).toMatchObject({ type: 'file.deleted', payload: { file_id: file.id, knowledge: 'none' } });
    expect(ctx.store.db.prepare("SELECT action, target_id FROM audit WHERE action = 'file.delete'").get()).toEqual({ action: 'file.delete', target_id: file.id });

    // Fresh bytes stay for the grace period; then the sweep removes them.
    expect(existsSync(blobPath(file.sha256))).toBe(true);
    expect(ctx.blobs.sweepUnreferenced()).toBe(0);
    expect(ctx.blobs.sweepUnreferenced(0)).toBe(1);
    expect(existsSync(blobPath(file.sha256))).toBe(false);
    expect(ctx.blobs.get(file.sha256)).toBeUndefined();
  });

  it('retires an indexed reference from HiveMem before the file and its bytes are removed', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const file = await json(await upload(project.id, '# Tone\n\nHopeful.', 'text/markdown'));
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    expect(ctx.store.files.get(file.id)!.knowledge.state).toBe('indexed');

    ctx.hivemem.failSync = 1;
    const deleted = await json(await ctx.call('DELETE', `/files/${file.id}`));
    expect(deleted.knowledge).toBe('retiring');
    expect(ctx.store.files.get(file.id)).toBeUndefined();
    expect((await json(await ctx.call('GET', `/projects/${project.id}/snapshot`))).files).toEqual([]);
    expect((await ctx.call('GET', `/blobs/${file.sha256}`)).status).toBe(404);
    await ctx.knowledge.idle();
    // HiveMem refused once: the file stays hidden and the retirement is retried.
    expect(ctx.store.files.stored(file.id)).toMatchObject({ deleted_at: expect.any(String), knowledge: { state: 'failed' } });
    ctx.store.db.prepare('UPDATE files SET knowledge_next_attempt_at = ? WHERE id = ?').run(new Date(0).toISOString(), file.id);
    await ctx.knowledge.runPass();

    const retirement = ctx.hivemem.syncs.at(-1)!;
    expect(retirement).toMatchObject({ mode: 'apply', source_id: `ardentstudio:file:${file.id}`, chunks: [], revision: `retired:${file.sha256}` });
    expect(ctx.store.files.stored(file.id)).toBeUndefined();
    // No file.updated is announced for a deleted file.
    const after = ctx.store.events.after(project.id, 0);
    expect(after.slice(after.findIndex(event => event.type === 'file.deleted') + 1).filter(event => event.type === 'file.updated')).toEqual([]);
    expect(ctx.blobs.sweepUnreferenced(0)).toBe(1);
  });

  it('retires a source that a sync in flight was still writing when the file was deleted', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    let release!: () => void;
    ctx.hivemem.gate = new Promise(resolve => { release = resolve; });
    const file = await json(await upload(project.id, '# Brief', 'text/markdown'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ctx.store.files.get(file.id)!.knowledge.state).toBe('indexing');
    expect((await json(await ctx.call('DELETE', `/files/${file.id}`))).knowledge).toBe('retiring');
    ctx.hivemem.gate = undefined;
    release();
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    expect(ctx.hivemem.syncs.filter(sync => sync.mode === 'apply').map(sync => sync.chunks.length)).toEqual([1, 0]);
    expect(ctx.store.files.stored(file.id)).toBeUndefined();
  });

  it('retires a reference whose earlier sync may have reached HiveMem, even after a reindex reset its attempts', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    // The sync's answer is lost: HiveMem may hold the chunks, but the file records only a failure.
    ctx.hivemem.failSync = 1;
    const file = await json(await upload(project.id, '# Brief', 'text/markdown'));
    await ctx.knowledge.idle();
    expect(ctx.store.files.get(file.id)!.knowledge).toMatchObject({ state: 'failed', revision: null, attempts: 1 });
    // What POST /files/{id}/reindex leaves until the next sync pass picks the file up.
    ctx.store.tx(() => ctx.store.files.queueSync(file.id));
    expect(ctx.store.files.get(file.id)!.knowledge).toMatchObject({ state: 'pending', revision: null, attempts: 0 });

    expect((await json(await ctx.call('DELETE', `/files/${file.id}`))).knowledge).toBe('retiring');
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    expect(ctx.hivemem.syncs.at(-1)).toMatchObject({ mode: 'apply', source_id: `ardentstudio:file:${file.id}`, chunks: [] });
    expect(ctx.store.files.stored(file.id)).toBeUndefined();
  });

  it('removes a reference that never syncs at once', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const file = await json(await upload(project.id, PNG, 'image/png', 'name=map.png'));
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    expect(ctx.store.files.get(file.id)!.knowledge.state).toBe('unsupported');
    const syncs = ctx.hivemem.syncs.length;
    expect((await json(await ctx.call('DELETE', `/files/${file.id}`))).knowledge).toBe('none');
    expect(ctx.store.files.stored(file.id)).toBeUndefined();
    expect(ctx.hivemem.syncs.length).toBe(syncs);
  });

  it('refuses while an agent portrait or a team role names the file, and on an archived project', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const avatar = await json(await upload(project.id, PNG, 'image/png', 'name=face.png&purpose=avatar'));
    ctx.store.tx(() => ctx.store.agents.savePresentation({ agentRef: 'node1~lead', portrait: null, avatarFileId: avatar.id, displayName: null, updatedBy: 'operator' }));
    const inUse = await ctx.call('DELETE', `/files/${avatar.id}`);
    expect(inUse.status).toBe(409);
    expect((await json(inUse)).error).toMatchObject({ code: 'FILE_IN_USE', details: { agents: ['node1~lead'], roles: [] } });

    const reference = await json(await upload(project.id, '# Brief', 'text/markdown'));
    const research = (await json(await ctx.call('GET', '/templates?kind=team'))).templates.find((item: { slug: string }) => item.slug === 'research-team');
    const applied = await json(await ctx.call('POST', `/projects/${project.id}/team/apply-template`, { body: { template_id: research.id, version: 1 } }));
    const roles = applied.draft.body.roles.map((role: any, index: number) => {
      const { binding_id: _binding, ...rest } = role;
      return { ...rest, agent_ref: null, knowledge: index === 0 ? [reference.id] : rest.knowledge };
    });
    const saved = await ctx.call('PUT', `/projects/${project.id}/team/draft`, { body: { base_revision: null, body: { roles, relationships: applied.draft.body.relationships, stages: applied.draft.body.stages } } });
    expect(saved.status).toBe(200);
    const roleInUse = await ctx.call('DELETE', `/files/${reference.id}`);
    expect((await json(roleInUse)).error).toMatchObject({ code: 'FILE_IN_USE', details: { roles: [roles[0].key] } });

    const loose = await json(await upload(project.id, '# Loose', 'text/markdown', 'name=loose.md&purpose=attachment'));
    expect((await ctx.call('POST', `/projects/${project.id}/archive`, { body: {} })).status).toBe(200);
    expect((await json(await ctx.call('DELETE', `/files/${loose.id}`))).error.code).toBe('PROJECT_ARCHIVED');
  });

  it('keeps bytes another file or a deliverable still references', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const first = await json(await upload(project.id, PNG, 'image/png', 'name=a.png&purpose=attachment'));
    const second = await json(await upload(project.id, PNG, 'image/png', 'name=b.png&purpose=attachment'));
    expect(second.sha256).toBe(first.sha256);
    await ctx.call('DELETE', `/files/${first.id}`);
    expect(ctx.blobs.sweepUnreferenced(0)).toBe(0);
    expect((await ctx.call('GET', `/blobs/${first.sha256}`)).status).toBe(200);
    await ctx.call('DELETE', `/files/${second.id}`);
    expect(ctx.blobs.sweepUnreferenced(0)).toBe(1);
  });
});

describe('project reindex', () => {
  it('queues every reference file and link of the project again', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    await upload(project.id, '# One', 'text/markdown', 'name=one.md');
    await upload(project.id, '# Two', 'text/markdown', 'name=two.md');
    await upload(project.id, PNG, 'image/png', 'name=map.png&purpose=attachment');
    expect((await ctx.call('POST', `/projects/${project.id}/links`, { body: { url: 'https://example.com/atlas', title: 'Atlas' } })).status).toBe(201);
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    const before = ctx.hivemem.syncs.length;

    const response = await ctx.call('POST', `/projects/${project.id}/reindex`);
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ files: 2, links: 1 });
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    expect(ctx.hivemem.syncs.length - before).toBe(6);
    expect(ctx.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'project.reindex'").get()).toEqual({ n: 1 });
  });
});
