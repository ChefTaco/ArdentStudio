import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { chunkText, extractText, KnowledgeTooLargeError } from '../src/knowledge/extract.js';
import { retryDelayMs } from '../src/knowledge/sync.js';
import { createProject, createTestContext, json, ManualClock, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(() => ctx?.close());

function pdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const upload = (ctx: TestContext, projectId: string, body: BodyInit, type: string, query = 'name=style-guide.md', key?: string) =>
  ctx.call('POST', `/projects/${projectId}/files?${query}`, { raw: body, headers: { 'content-type': type }, ...(key ? { key } : {}) });

describe('files', () => {
  it('stores an upload, indexes it into the project workspace and serves the bytes', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const text = '# Tone\n\nHopeful and strange.\n\n## Names\n\nFenmarch, Ollow Ford.';
    const response = await upload(ctx, project.id, text, 'text/markdown; charset=utf-8');
    expect(response.status).toBe(201);
    const file = await json(response);
    expect(file).toMatchObject({ name: 'style-guide.md', mime: 'text/markdown', purpose: 'reference', size: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'), knowledge: { state: 'pending' } });

    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    const indexed = ctx.store.files.get(file.id)!;
    expect(indexed.knowledge).toMatchObject({ state: 'indexed', revision: file.sha256, chunks: 2, error: null });
    const [preview, apply] = ctx.hivemem.syncs;
    expect(preview).toMatchObject({ mode: 'preview', workspace_id: project.hivemem.workspace_id, project_id: project.id.toLowerCase(), source_id: `ardentstudio:file:${file.id}`, revision: file.sha256 });
    expect(apply!.mode).toBe('apply');
    expect(apply!.chunks.map(chunk => chunk.heading)).toEqual(['Tone', 'Names']);

    const list = await json(await ctx.call('GET', `/projects/${project.id}/files`));
    expect(list.files.map((item: { id: string }) => item.id)).toEqual([file.id]);
    const download = await ctx.call('GET', `/blobs/${file.sha256}`);
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect(download.headers.get('x-blob-mime')).toBe('text/markdown');
    expect(download.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(await download.text()).toBe(text);
    const types = ctx.store.events.after(project.id, 0).map(event => event.type);
    expect(types).toContain('file.created');
    expect(types.filter(type => type === 'file.updated').length).toBeGreaterThanOrEqual(2);
  });

  it('refuses unknown types, empty and oversized bodies, and archived projects', async () => {
    ctx = await createTestContext({ maxBlobBytes: 2048 });
    const project = await createProject(ctx);
    expect((await upload(ctx, project.id, 'x', 'application/x-msdownload')).status).toBe(415);
    expect((await upload(ctx, project.id, 'a'.repeat(4096), 'text/plain')).status).toBe(413);
    expect((await upload(ctx, project.id, '', 'text/plain')).status).toBe(400);
    expect((await upload(ctx, project.id, 'x', 'text/plain', 'name=../../escape')).status).toBe(400);
    await ctx.call('POST', `/projects/${project.id}/archive`);
    expect((await upload(ctx, project.id, 'x', 'text/plain')).status).toBe(409);
  });

  it('serves only blobs that a project file references', async () => {
    ctx = await createTestContext();
    const orphan = await ctx.blobs.putBytes(Buffer.from('orphan'), 'text/plain');
    expect((await ctx.call('GET', `/blobs/${orphan.sha256}`)).status).toBe(404);
    expect((await ctx.call('GET', '/blobs/not-a-sha')).status).toBe(404);
  });

  it('replays an upload with the same key instead of creating a second file', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const first = await json(await upload(ctx, project.id, 'same bytes', 'text/plain', 'name=a.txt', 'fixture-upload-1'));
    const again = await upload(ctx, project.id, 'same bytes', 'text/plain', 'name=a.txt', 'fixture-upload-1');
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect((await json(again)).id).toBe(first.id);
    expect((await upload(ctx, project.id, 'other bytes', 'text/plain', 'name=a.txt', 'fixture-upload-1')).status).toBe(409);
  });

  it('marks failures with backoff, retries them, and reindexes on request', async () => {
    const clock = new ManualClock();
    ctx = await createTestContext({ clock });
    const project = await createProject(ctx);
    ctx.hivemem.failSync = 1;
    const file = await json(await upload(ctx, project.id, 'Some reference text.', 'text/plain', 'name=notes.txt'));
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    expect(ctx.store.files.get(file.id)!.knowledge).toMatchObject({ state: 'failed', attempts: 1, error: 'HiveMem answered HTTP 503' });
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    expect(ctx.store.files.get(file.id)!.knowledge.state).toBe('failed');
    clock.advance(retryDelayMs(1));
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    expect(ctx.store.files.get(file.id)!.knowledge).toMatchObject({ state: 'indexed', attempts: 2, error: null });
    const reindexed = await json(await ctx.call('POST', `/files/${file.id}/reindex`));
    expect(reindexed.knowledge).toMatchObject({ state: 'pending', attempts: 0 });
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    expect(ctx.store.files.get(file.id)!.knowledge.state).toBe('indexed');
  });

  it('stores images and attachments without indexing them, and says why DOCX is not indexed', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const image = await json(await upload(ctx, project.id, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png', 'name=map.png'));
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    expect(ctx.store.files.get(image.id)!.knowledge).toMatchObject({ state: 'unsupported', error: expect.stringMatching(/no text/) });
    const attachment = await json(await upload(ctx, project.id, 'notes', 'text/plain', 'name=a.txt&purpose=attachment'));
    expect(attachment.knowledge.state).toBe('not_indexed');
    expect((await ctx.call('POST', `/files/${attachment.id}/reindex`)).status).toBe(409);
    const docx = await extractText('application/vnd.openxmlformats-officedocument.wordprocessingml.document', new Uint8Array([1]));
    expect(docx).toMatchObject({ kind: 'unsupported', reason: expect.stringMatching(/DOCX/) });
  });

  it('extracts PDF text with page markers', async () => {
    const result = await extractText('application/pdf', pdf('Hello Fenmarch'));
    expect(result).toEqual({ kind: 'text', text: '[Page 1]\nHello Fenmarch' });
  });

  it('chunks along headings with stable positional keys and enforces HiveMem limits', () => {
    const chunks = chunkText('# One\n\nAlpha.\n\n# Two\n\nBeta.');
    expect(chunks.map(chunk => [chunk.chunk_key, chunk.heading, chunk.content])).toEqual([['c0001', 'One', '# One\n\nAlpha.'], ['c0002', 'Two', '# Two\n\nBeta.']]);
    expect(chunks[0]!.content_hash).toBe(createHash('sha256').update('# One\n\nAlpha.').digest('hex'));
    expect(chunkText('x'.repeat(9000)).map(chunk => chunk.content.length)).toEqual([4000, 4000, 1000]);
    expect(() => chunkText(Array.from({ length: 600 }, (_, index) => `# H${index}\n\nBody`).join('\n\n'))).toThrow(KnowledgeTooLargeError);
    expect(chunkText('')).toEqual([]);
  });
});
