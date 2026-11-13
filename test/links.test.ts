import { afterEach, describe, expect, it } from 'vitest';
import { chunkHash } from '../src/clients/hivemem.js';
import { createProject, createTestContext, json, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => { await ctx?.close(); });

describe('reference links', () => {
  it('validates, stores and syncs a link as a HiveMem knowledge source without fetching it', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    for (const url of ['ftp://example.com/map', 'javascript:alert(1)', 'https://user:secret@example.com/', 'not a url', `https://example.com/${'a'.repeat(2100)}`]) {
      const refused = await ctx.call('POST', `/projects/${project.id}/links`, { body: { url, title: 'Bad' } });
      expect(refused.status, url).toBe(400);
    }
    expect((await ctx.call('POST', `/projects/${project.id}/links`, { body: { url: 'https://example.com/a', title: '' } })).status).toBe(400);

    const created = await ctx.call('POST', `/projects/${project.id}/links`, { body: { url: 'HTTPS://Example.com/maps/valley?scale=1#top', title: 'Valley map notes', note_md: 'Use for scale.' } });
    expect(created.status).toBe(201);
    const link = await json(created);
    expect(link).toMatchObject({ url: 'https://example.com/maps/valley?scale=1#top', title: 'Valley map notes', note_md: 'Use for scale.', created_by: 'operator', deleted_at: null,
      knowledge: { state: 'pending', source_id: `ardentstudio:link:${link.id}` } });
    expect((await ctx.call('POST', `/projects/${project.id}/links`, { body: { url: 'https://example.com/maps/valley?scale=1#top', title: 'Again' } })).status).toBe(409);

    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    const sync = ctx.hivemem.syncs.find(item => item.source_id === `ardentstudio:link:${link.id}` && item.mode === 'apply')!;
    const content = 'Reference link: Valley map notes\n\nhttps://example.com/maps/valley?scale=1#top\n\nUse for scale.';
    expect(sync).toMatchObject({ workspace_id: project.hivemem.workspace_id, source_uri: 'https://example.com/maps/valley?scale=1#top', revision: chunkHash(content),
      chunks: [{ chunk_key: 'link', content, content_hash: chunkHash(content), heading: 'Valley map notes' }] });
    const indexed = ctx.store.links.get(link.id)!;
    expect(indexed.knowledge).toMatchObject({ state: 'indexed', chunks: 1, revision: chunkHash(content), attempts: 1 });

    const snapshot = await json(await ctx.call('GET', `/projects/${project.id}/snapshot`));
    expect(snapshot.links.map((item: { id: string }) => item.id)).toEqual([link.id]);
    expect(snapshot.summary).toMatchObject({ link_count: 1, last_activity: { type: 'link.created', text: 'operator added the link Valley map notes' } });
    expect(ctx.store.events.after(project.id, 0).map(event => event.type)).toEqual(expect.arrayContaining(['link.created', 'link.updated']));
    expect(ctx.store.audit.list({ targetId: link.id }).map(entry => entry.action)).toEqual(['link.create']);
  });

  it('resyncs an edited link, retries failures and retires the source when the link is deleted', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    ctx.hivemem.failSync = 1;
    const link = await json(await ctx.call('POST', `/projects/${project.id}/links`, { body: { url: 'https://example.com/a', title: 'First' } }));
    await ctx.knowledge.idle();
    expect(ctx.store.links.get(link.id)!.knowledge).toMatchObject({ state: 'failed', error: 'HiveMem answered HTTP 503', attempts: 1 });
    const reindexed = await json(await ctx.call('POST', `/links/${link.id}/reindex`));
    expect(reindexed.knowledge).toMatchObject({ state: 'pending', attempts: 0, error: null });
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    expect(ctx.store.links.get(link.id)!.knowledge.state).toBe('indexed');

    const edited = await json(await ctx.call('PATCH', `/links/${link.id}`, { body: { title: 'Renamed', note_md: 'Newer notes.' } }));
    expect(edited).toMatchObject({ title: 'Renamed', url: 'https://example.com/a', knowledge: { state: 'pending' } });
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    expect(ctx.hivemem.syncs.at(-1)!.chunks[0]!.content).toBe('Reference link: Renamed\n\nhttps://example.com/a\n\nNewer notes.');

    const deleted = await json(await ctx.call('DELETE', `/links/${link.id}`));
    expect(deleted.deleted_at).not.toBeNull();
    expect((await json(await ctx.call('GET', `/projects/${project.id}/links`))).links).toEqual([]);
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    const retired = ctx.hivemem.syncs.at(-1)!;
    expect(retired).toMatchObject({ source_id: `ardentstudio:link:${link.id}`, chunks: [] });
    expect(ctx.store.links.get(link.id)!.knowledge).toMatchObject({ state: 'not_indexed', revision: null });
    expect((await ctx.call('PATCH', `/links/${link.id}`, { body: { title: 'Gone' } })).status).toBe(404);
    // The address can be added again once the old link is deleted.
    expect((await ctx.call('POST', `/projects/${project.id}/links`, { body: { url: 'https://example.com/a', title: 'Again' } })).status).toBe(201);
  });

  it('syncs again when a link is edited or deleted while HiveMem is being called', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const sync = ctx.hivemem.syncKnowledgeSourceChecked;
    let during: (() => Promise<unknown>) | undefined;
    ctx.hivemem.syncKnowledgeSourceChecked = async body => {
      const answer = await sync(body);
      const act = during;
      during = undefined;
      await act?.();
      return answer;
    };
    const settle = async () => { await ctx.knowledge.idle(); await ctx.knowledge.runPass(); };

    const edited = await json(await ctx.call('POST', `/projects/${project.id}/links`, { body: { url: 'https://example.com/a', title: 'First' } }));
    await ctx.knowledge.idle();
    during = () => ctx.call('PATCH', `/links/${edited.id}`, { body: { title: 'Renamed' } });
    await ctx.call('POST', `/links/${edited.id}/reindex`);
    await settle();
    expect(during).toBeUndefined();
    expect(ctx.hivemem.syncs.at(-1)!.chunks[0]!.content).toBe('Reference link: Renamed\n\nhttps://example.com/a');
    expect(ctx.store.links.get(edited.id)!.knowledge.state).toBe('indexed');

    // Deleted during its first sync: the source HiveMem just received is retired.
    during = async () => {
      const created = ctx.store.links.list(project.id).find(item => item.url === 'https://example.com/b')!;
      await ctx.call('DELETE', `/links/${created.id}`);
    };
    const removed = await json(await ctx.call('POST', `/projects/${project.id}/links`, { body: { url: 'https://example.com/b', title: 'Second' } }));
    await settle();
    expect(during).toBeUndefined();
    expect(ctx.hivemem.syncs.at(-1)).toMatchObject({ source_id: `ardentstudio:link:${removed.id}`, chunks: [] });
    expect(ctx.store.links.get(removed.id)!.knowledge).toMatchObject({ state: 'not_indexed', revision: null });
  });

  it('refuses link changes on an archived project', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    expect((await ctx.call('POST', `/projects/${project.id}/archive`)).status).toBe(200);
    expect((await ctx.call('POST', `/projects/${project.id}/links`, { body: { url: 'https://example.com/a', title: 'Late' } })).status).toBe(409);
  });
});
