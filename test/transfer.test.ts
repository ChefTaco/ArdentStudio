import { createHash, randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRange } from '../src/server/routes/files.js';
import { createProject, createTestContext, json, publishTeam, waitFor, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => { await ctx?.close(); });

const MIB = 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function followed(options: { runtime?: boolean } = {}) {
  ctx = await createTestContext();
  const project = await createProject(ctx);
  await publishTeam(ctx, project.id);
  if (options.runtime !== false) ctx.magnus.enableRuntime('node1~lead');
  const team = await json(await ctx.call('POST', `/projects/${project.id}/conversations`, { body: { kind: 'team' } }));
  const posted = await json(await ctx.call('POST', `/conversations/${team.id}/messages`, { body: { body_md: 'Draw the valley map.' } }));
  const taskId = posted.tasks[0].id as string;
  const ardentId = await waitFor(() => ctx.store.tasks.get(taskId)?.ardent.task_id);
  await waitFor(() => ctx.magnus.openStreams(ardentId) > 0);
  return { project, taskId, ardentId };
}

function register(ardentId: string, name: string, mime: string, bytes: Uint8Array): string {
  const sha = ctx.magnus.addArtifact(bytes, mime);
  ctx.magnus.event(ardentId, 'artifact_registered', { artifact_id: `art-${sha.slice(0, 12)}`, name, mime, sha256: sha, size: bytes.byteLength });
  return sha;
}

const importOf = (sha: string) => ctx.store.db.prepare('SELECT * FROM artifact_imports WHERE sha256 = ?').get(sha) as Record<string, any> | undefined;
const contentCalls = (sha: string) => ctx.magnus.calls.filter(call => call.path.endsWith(`/artifacts/${sha}/content`));

describe('artifact transfer v2', () => {
  it('resumes a 20 MiB import after a restart at half way with Range and If-Range, verifies it and imports its renditions', async () => {
    const { project, ardentId } = await followed();
    const bytes = new Uint8Array(randomBytes(20 * MIB));
    const preview = new Uint8Array(randomBytes(4096));
    const previewSha = ctx.magnus.addArtifact(preview, 'image/webp');
    const sha = digest(bytes);
    ctx.magnus.renditions.set(sha, [
      { sha256: sha, role: 'original', mime: 'image/png', size: bytes.byteLength, purpose: 'download', width: 8000, height: 6000, has_alpha: true },
      { sha256: previewSha, role: 'preview', mime: 'image/webp', size: preview.byteLength, purpose: 'display', width: 1600, height: 1200, has_alpha: true },
    ]);
    ctx.magnus.contentStall.set(sha, 10 * MIB);
    register(ardentId, 'Valley Map.png', 'image/png', bytes);

    const row = await waitFor(() => importOf(sha));
    const partial = ctx.blobs.partialPath(row.id);
    await waitFor(() => existsSync(partial) && statSync(partial).size === 10 * MIB, 5000);
    // Studio stops half way: the transfer is aborted, the partial file and the pending row stay.
    await ctx.importer.stop();
    expect(importOf(sha)).toMatchObject({ state: 'pending', transfer: 'range', received_bytes: 10 * MIB, resumes: 0, revision_id: null });
    expect(ctx.blobs.get(sha)).toBeUndefined();

    ctx.magnus.contentStall.delete(sha);
    ctx.importer.start();
    await waitFor(() => importOf(sha)?.state === 'imported', 10_000);
    const calls = contentCalls(sha);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.range).toBeUndefined();
    expect(calls[1]!.headers).toMatchObject({ range: `bytes=${10 * MIB}-`, 'if-range': `"${sha}"` });
    expect(importOf(sha)).toMatchObject({ received_bytes: 20 * MIB, resumes: 1, transfer: 'range', error_code: null });
    expect(existsSync(partial)).toBe(false);
    expect(Buffer.from(await ctx.blobs.readBytes(sha)).equals(Buffer.from(bytes))).toBe(true);

    const [deliverable] = (await json(await ctx.call('GET', `/projects/${project.id}/deliverables`))).deliverables;
    expect(deliverable.revisions[0]).toMatchObject({ blob_sha256: sha, size: 20 * MIB, renditions: [
      { role: 'original', sha256: sha, mime: 'image/png', size: 20 * MIB, purpose: 'download', width: 8000, height: 6000, has_alpha: true },
      { role: 'preview', sha256: previewSha, mime: 'image/webp', size: 4096, purpose: 'display', width: 1600, height: 1200, has_alpha: true },
    ] });
    const rows = ctx.store.db.prepare('SELECT role, sha256 FROM deliverable_renditions WHERE deliverable_revision_id = ? ORDER BY position').all(deliverable.revisions[0].id);
    expect(rows).toEqual([{ role: 'original', sha256: sha }, { role: 'preview', sha256: previewSha }]);
    const types = ctx.store.events.after(project.id, 0).filter(event => event.type === 'artifact.import.updated').map(event => event.payload);
    expect(types.some(payload => payload.resumed_from === 10 * MIB)).toBe(true);

    // The preview is served inline with its real type; the original stays an attachment.
    const shown = await ctx.call('GET', `/blobs/${previewSha}?disposition=inline`);
    expect(shown.status).toBe(200);
    expect(shown.headers.get('content-type')).toBe('image/webp');
    expect(shown.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(shown.headers.get('x-content-sha256')).toBe(previewSha);
    expect(Buffer.from(await shown.arrayBuffer()).equals(Buffer.from(preview))).toBe(true);
  });

  it('marks a rendition it already stores as reused, so the sweep keeps it while the rows are written', async () => {
    const { project, ardentId } = await followed();
    const bytes = new Uint8Array(randomBytes(64 * 1024));
    const preview = new Uint8Array(randomBytes(2048));
    const previewSha = ctx.magnus.addArtifact(preview, 'image/webp');
    // The preview's bytes are already stored, unreferenced and old enough to be swept.
    await ctx.blobs.putBytes(preview, 'image/webp');
    ctx.store.db.prepare('UPDATE blobs SET created_at = ?, used_at = ? WHERE sha256 = ?').run(new Date(0).toISOString(), new Date(0).toISOString(), previewSha);
    const sha = digest(bytes);
    ctx.magnus.renditions.set(sha, [
      { sha256: sha, role: 'original', mime: 'image/png', size: bytes.byteLength, purpose: 'download', width: 64, height: 64, has_alpha: false },
      { sha256: previewSha, role: 'preview', mime: 'image/webp', size: preview.byteLength, purpose: 'display', width: 32, height: 32, has_alpha: false },
    ]);
    const started = Date.now();
    register(ardentId, 'Tile.png', 'image/png', bytes);
    await waitFor(() => importOf(sha)?.state === 'imported', 5000);
    expect(contentCalls(previewSha)).toEqual([]);
    const usedAt = (ctx.store.db.prepare('SELECT used_at FROM blobs WHERE sha256 = ?').get(previewSha) as { used_at: string }).used_at;
    expect(Date.parse(usedAt)).toBeGreaterThanOrEqual(started - 1000);
    const [deliverable] = (await json(await ctx.call('GET', `/projects/${project.id}/deliverables`))).deliverables;
    expect(deliverable.revisions[0].renditions.map((item: { sha256: string }) => item.sha256)).toEqual([sha, previewSha]);
    expect(ctx.blobs.reuse('0'.repeat(64))).toBeUndefined();
  });

  it('starts over when the relay ignores the range, and still verifies the digest', async () => {
    const { ardentId } = await followed();
    const bytes = new Uint8Array(randomBytes(3 * MIB));
    const sha = digest(bytes);
    ctx.magnus.contentStall.set(sha, MIB);
    register(ardentId, 'Atlas.pdf', 'application/pdf', bytes);
    const row = await waitFor(() => importOf(sha));
    await waitFor(() => existsSync(ctx.blobs.partialPath(row.id)) && statSync(ctx.blobs.partialPath(row.id)).size === MIB);
    await ctx.importer.stop();
    ctx.magnus.contentStall.delete(sha);
    ctx.magnus.ignoreRanges = true;
    ctx.importer.start();
    await waitFor(() => importOf(sha)?.state === 'imported', 5000);
    expect(contentCalls(sha)[1]!.headers.range).toBe(`bytes=${MIB}-`);
    expect(Buffer.from(await ctx.blobs.readBytes(sha)).equals(Buffer.from(bytes))).toBe(true);
  });

  it('never records bytes that fail the digest', async () => {
    const { project, ardentId } = await followed();
    const bytes = new Uint8Array(randomBytes(64 * 1024));
    const sha = register(ardentId, 'Notes.md', 'text/markdown', bytes);
    ctx.magnus.artifactOverride.set(sha, new Uint8Array(randomBytes(64 * 1024)));
    await waitFor(() => importOf(sha)?.state === 'failed', 5000);
    expect(importOf(sha)).toMatchObject({ error_code: 'DIGEST_MISMATCH', revision_id: null });
    expect(ctx.blobs.get(sha)).toBeUndefined();
    expect(existsSync(ctx.blobs.partialPath(importOf(sha)!.id))).toBe(false);
    expect(ctx.store.review.deliverables(project.id)).toEqual([]);
  });
});

describe('artifacts from agents without transfer v2', () => {
  it('keep the whole download through the Magnus relay up to the blob limit, verified, without renditions', async () => {
    const { project, ardentId } = await followed({ runtime: false });
    const bytes = new Uint8Array(randomBytes(20 * MIB));
    const sha = register(ardentId, 'Poster.png', 'image/png', bytes);
    await waitFor(() => importOf(sha)?.state === 'imported', 10_000);
    expect(importOf(sha)).toMatchObject({ transfer: 'whole', received_bytes: 20 * MIB, resumes: 0, error_code: null });
    expect(contentCalls(sha)).toEqual([]);
    expect(ctx.magnus.calls.filter(call => call.path.endsWith(`/artifacts/${sha}`))).toHaveLength(1);
    expect(Buffer.from(await ctx.blobs.readBytes(sha)).equals(Buffer.from(bytes))).toBe(true);
    const [deliverable] = (await json(await ctx.call('GET', `/projects/${project.id}/deliverables`))).deliverables;
    expect(deliverable.revisions[0]).toMatchObject({ blob_sha256: sha, size: 20 * MIB, renditions: [] });
  });

  it('fall back to the whole download when a profile reported as v2 answers unsupported_capability', async () => {
    const { ardentId } = await followed();
    // Studio read the profile as v2; it was downgraded since, so Magnus refuses the content read.
    expect((await ctx.conductor.runtimeOf('node1~lead')).artifact_transfer).toBe(2);
    ctx.magnus.runtime.set('node1~lead', { recovery: 0, lineage: 0, artifact_transfer: 1, version: '3.1.4' });
    const bytes = new Uint8Array(randomBytes(3 * MIB));
    const sha = register(ardentId, 'Atlas.png', 'image/png', bytes);
    await waitFor(() => importOf(sha)?.state === 'imported', 5000);
    expect(importOf(sha)).toMatchObject({ transfer: 'whole', attempts: 1, error_code: null });
    expect(contentCalls(sha)).toHaveLength(1);
    expect(Buffer.from(await ctx.blobs.readBytes(sha)).equals(Buffer.from(bytes))).toBe(true);
    expect(existsSync(ctx.blobs.partialPath(importOf(sha)!.id))).toBe(false);
  });
});

describe('blob ranges', () => {
  it('serves one byte range with Content-Range and the digest, and 416 past the end', async () => {
    const { ardentId } = await followed({ runtime: false });
    const bytes = new TextEncoder().encode('0123456789abcdefghij');
    const sha = register(ardentId, 'Range.txt', 'text/plain', bytes);
    await waitFor(() => importOf(sha)?.state === 'imported');
    const part = await ctx.call('GET', `/blobs/${sha}`, { headers: { range: 'bytes=5-9' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 5-9/${bytes.byteLength}`);
    expect(part.headers.get('accept-ranges')).toBe('bytes');
    expect(part.headers.get('x-content-sha256')).toBe(sha);
    expect(part.headers.get('content-type')).toBe('application/octet-stream');
    expect(await part.text()).toBe('56789');
    const tail = await ctx.call('GET', `/blobs/${sha}`, { headers: { range: 'bytes=-3' } });
    expect(await tail.text()).toBe('hij');
    const open = await ctx.call('GET', `/blobs/${sha}`, { headers: { range: 'bytes=15-' } });
    expect(await open.text()).toBe('fghij');
    const past = await ctx.call('GET', `/blobs/${sha}`, { headers: { range: 'bytes=20-' } });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe(`bytes */${bytes.byteLength}`);
    const stale = await ctx.call('GET', `/blobs/${sha}`, { headers: { range: 'bytes=0-1', 'if-range': `"${'0'.repeat(64)}"` } });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe('0123456789abcdefghij');
    // Text is never given its type, even inline.
    const inline = await ctx.call('GET', `/blobs/${sha}?disposition=inline`);
    expect(inline.headers.get('content-type')).toBe('application/octet-stream');
    expect(inline.headers.get('content-disposition')).toMatch(/^inline;/);
  });

  it('parses single byte ranges', () => {
    expect(parseRange('bytes=0-0', 10)).toEqual({ start: 0, end: 0 });
    expect(parseRange('bytes=8-100', 10)).toEqual({ start: 8, end: 9 });
    expect(parseRange('bytes=-20', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-2', 10)).toBeUndefined();
    expect(parseRange('bytes=0-1,4-5', 10)).toBeUndefined();
    expect(parseRange('items=0-1', 10)).toBeUndefined();
  });
});
