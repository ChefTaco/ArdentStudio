import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocxConverter } from '../src/review/docx.js';
import { createProject, createTestContext, json, publishTeam, waitFor, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => { await ctx?.close(); });

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (text: string) => new TextEncoder().encode(text);

async function setup(options: Parameters<typeof createTestContext>[0] = {}) {
  ctx = await createTestContext(options);
  const project = await createProject(ctx, { deliverables: [{ name: 'Region Map', kind: 'map', formats: ['svg'], producer_role_key: 'mapper' }] });
  await publishTeam(ctx, project.id);
  const team = await json(await ctx.call('POST', `/projects/${project.id}/conversations`, { body: { kind: 'team' } }));
  const posted = await json(await ctx.call('POST', `/conversations/${team.id}/messages`, { body: { body_md: '@mapper draw the valley' } }));
  const [ardent] = await ctx.magnus.submitted(1);
  await waitFor(() => ctx.store.tasks.get(posted.tasks[0].id)!.ardent.task_id && ctx.magnus.openStreams(ardent!.id));
  return { project, team, task: posted.tasks[0] as { id: string }, ardentTaskId: ardent!.id };
}

/** The agent registers an artifact on a running Ardent task. */
function register(ardentTaskId: string, name: string, mime: string, bytes: Uint8Array, supersedes: string | null = null) {
  const digest = ctx.magnus.addArtifact(bytes, mime);
  const artifactId = createHash('sha256').update(`${name}:${digest}`).digest('hex').slice(0, 32);
  ctx.magnus.event(ardentTaskId, 'artifact_registered', { artifact_id: artifactId, name, mime, sha256: digest, size: bytes.byteLength, revision: supersedes ? 2 : 1,
    supersedes_sha256: supersedes, manifest: { schema_version: '1.0', name, mime, sha256: digest, size: bytes.byteLength, revision: supersedes ? 2 : 1,
      supersedes_sha256: supersedes, acceptance_status: 'unreviewed', created_at: 1_762_560_000, artifact_id: artifactId } });
  return { digest, artifactId };
}

const SVG = encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M0 0L100 100"/></svg>');

describe('artifact importer', () => {
  it('streams a registered artifact into the blob store and records a verified revision', async () => {
    const { project, team, task, ardentTaskId } = await setup();
    const { digest, artifactId } = register(ardentTaskId, 'region-map.svg', 'image/svg+xml', SVG);
    const deliverables = await waitFor(async () => { const list = await json(await ctx.call('GET', `/projects/${project.id}/deliverables`)); return list.deliverables.length ? list : undefined; });
    const [deliverable] = deliverables.deliverables;
    expect(deliverable).toMatchObject({ name: 'Region Map', kind: 'map', producer_role: 'mapper', requested_deliverable_id: project.deliverables[0].id, final_revision_id: null });
    expect(deliverable.revisions).toMatchObject([{ revision: 1, blob_sha256: digest, mime: 'image/svg+xml', size: SVG.byteLength, source_task_id: task.id,
      supersedes_revision_id: null, review_status: 'unreviewed', ardent: { agent_ref: 'node2~mapper', artifact_id: artifactId, manifest: { acceptance_status: 'unreviewed' } } }]);
    expect(deliverables.imports).toEqual([]);
    expect(await ctx.blobs.verify(digest)).toBe(true);
    const download = await ctx.call('GET', `/blobs/${digest}`);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(SVG);
    expect(ctx.store.room.messages(team.id).at(-1)).toMatchObject({ kind: 'delivery', author: { role_key: 'mapper' }, body_md: 'Delivered Region Map (revision 1)' });
    expect(ctx.store.room.activity(project.id).find(item => item.binding_id === deliverable.revisions[0].producer_binding_id)).toMatchObject({ state: 'delivering', label: 'Delivered Region Map r1' });
    expect(ctx.store.events.after(project.id, 0).map(event => event.type)).toContain('deliverable.revision.created');
    // A replayed registration (a reconnect) does not import twice.
    ctx.store.review.queueImport({ project_id: project.id, task_id: task.id, agent_ref: 'node2~mapper', artifact_id: artifactId, sha256: digest, name: 'region-map.svg',
      mime: 'image/svg+xml', size: SVG.byteLength, manifest: {}, ardent_event_seq: 1 });
    ctx.importer.kick();
    await ctx.importer.settled();
    expect(ctx.store.review.revisions(deliverable.id)).toHaveLength(1);
  });

  it('refuses bytes that do not match the registered SHA-256 and says so in the room', async () => {
    const { project, team, ardentTaskId } = await setup();
    const { digest } = register(ardentTaskId, 'region-map.svg', 'image/svg+xml', SVG);
    ctx.magnus.artifactOverride.set(digest, encode('<svg>tampered</svg>'));
    const failed = await waitFor(() => ctx.store.review.imports(project.id).find(item => item.state === 'failed'));
    expect(failed.error).toBe('the received bytes do not match the registered SHA-256');
    expect(failed.attempts).toBe(2);
    expect(ctx.store.review.deliverables(project.id)).toEqual([]);
    expect(ctx.blobs.get(digest)).toBeUndefined();
    expect(ctx.store.room.messages(team.id).at(-1)!.body_md).toBe('region-map.svg from Cartographer was not added to review: the received bytes do not match the registered SHA-256.');
    const listed = await json(await ctx.call('GET', `/projects/${project.id}/deliverables`));
    expect(listed.imports).toMatchObject([{ name: 'region-map.svg', state: 'failed', sha256: digest }]);
  });
});

describe('review', () => {
  it('validates every anchor kind against the revision', async () => {
    const { project, ardentTaskId } = await setup();
    const text = 'Regions: Fenmarch, Saltreach. ✦ The Drowned Steps.';
    const md = register(ardentTaskId, 'regions.md', 'text/markdown', encode(text));
    register(ardentTaskId, 'region-map.svg', 'image/svg+xml', SVG);
    register(ardentTaskId, 'handout.pdf', 'application/pdf', encode('%PDF-1.7 fixture'));
    const deliverables = await waitFor(() => { const list = ctx.store.review.deliverables(project.id); return list.length === 3 ? list : undefined; });
    const revisionOf = (name: string) => ctx.store.review.revisions(deliverables.find(item => item.name === name || (name === 'Region Map' && item.name === 'Region Map'))!.id)[0]!;
    const markdown = revisionOf('regions.md');
    const map = revisionOf('Region Map');
    const pdf = revisionOf('handout.pdf');
    const comment = (revisionId: string, anchor: unknown) => ctx.call('POST', `/revisions/${revisionId}/comments`, { body: { anchor, body_md: 'Note' } });
    const start = text.indexOf('Saltreach');
    expect((await comment(markdown.id, { kind: 'text', start, end: start + 9, quote: 'Saltreach', source_sha256: md.digest })).status).toBe(201);
    const after = text.indexOf('The Drowned');
    expect((await comment(markdown.id, { kind: 'text', start: after, end: after + 11, quote: 'The Drowned', source_sha256: md.digest })).status).toBe(201);
    const mismatch = await comment(markdown.id, { kind: 'text', start: 0, end: 5, quote: 'Wrong', source_sha256: md.digest });
    expect([mismatch.status, (await json(mismatch)).error.code]).toEqual([422, 'ANCHOR_MISMATCH']);
    const stale = await comment(markdown.id, { kind: 'text', start: 0, end: 7, quote: 'Regions', source_sha256: 'a'.repeat(64) });
    expect([stale.status, (await json(stale)).error.code]).toEqual([409, 'ANCHOR_STALE']);
    const kind = await comment(markdown.id, { kind: 'pdf', page: 1 });
    expect([kind.status, (await json(kind)).error.code]).toEqual([422, 'ANCHOR_KIND']);
    expect((await comment(map.id, { kind: 'image', x: 0.1, y: 0.2, w: 0.3, h: 0.3, viewbox: { x: 10, y: 20, w: 30, h: 30 } })).status).toBe(201);
    expect((await comment(map.id, { kind: 'image', x: 0.9, y: 0.2, w: 0.3, h: 0.3 })).status).toBe(422);
    expect((await comment(map.id, { kind: 'text', start: 0, end: 4, quote: '<svg', source_sha256: map.blob_sha256 })).status).toBe(201);
    expect((await comment(pdf.id, { kind: 'pdf', page: 2, rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, quote: 'Steps' })).status).toBe(201);
    expect((await comment(pdf.id, { kind: 'file' })).status).toBe(201);
    const docx = await comment(pdf.id, { kind: 'docx', paragraph_id: 'p1', start: 0, end: 1, quote: 'x' });
    expect(docx.status).toBe(422);
    const listed = await json(await ctx.call('GET', `/revisions/${markdown.id}/comments`));
    expect(listed.comments.map((item: { anchor: { quote: string } }) => item.anchor.quote)).toEqual(['Saltreach', 'The Drowned']);
  });

  it('runs a revision request: anchored comments go to the producer, the new revision supersedes the old and the comments point at it', async () => {
    const { project, ardentTaskId } = await setup();
    const first = register(ardentTaskId, 'region-map.svg', 'image/svg+xml', SVG);
    const deliverable = await waitFor(() => ctx.store.review.deliverables(project.id)[0]);
    const r1 = ctx.store.review.revisions(deliverable.id)[0]!;
    const region = await json(await ctx.call('POST', `/revisions/${r1.id}/comments`, { body: { anchor: { kind: 'image', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, body_md: 'Add a ford across the swamp.' } }));
    const whole = await json(await ctx.call('POST', `/revisions/${r1.id}/comments`, { body: { anchor: { kind: 'file' }, body_md: 'Label every region.' } }));
    const requested = await ctx.call('POST', `/projects/${project.id}/revision-requests`, { body: { comment_ids: [region.id, whole.id], instructions_md: 'Keep the style.' } });
    expect(requested.status).toBe(201);
    const request = await json(requested);
    expect(request.task).toMatchObject({ mode: 'revision', role_key: 'mapper', title: 'Revise Region Map', source: { deliverable_id: deliverable.id, revision_id: r1.id, revises_sha256: first.digest } });
    expect(request.comments.map((item: { revision_task_id: string }) => item.revision_task_id)).toEqual([request.task.id, request.task.id]);
    expect(request.message).toMatchObject({ kind: 'revision_request', addressees: ['mapper'], body_md: 'Revision requested for Region Map r1: Keep the style.' });

    ctx.magnus.finish(ardentTaskId, { state: 'completed', result: '{"outcome":"partial","summary":"Drew it."}' });
    const submitted = await waitFor(() => [...ctx.magnus.tasks.values()].find(item => item.idempotency_key === request.task.id));
    const body = submitted.body as { objective: string; mission: { expected_artifacts: string[] }; context_items: Array<{ title: string; text: string }> };
    expect(body.objective).toContain(`revises_sha256 ${first.digest}`);
    expect(body.mission.expected_artifacts).toEqual(['Region Map']);
    expect(body.context_items.map(item => item.title)).toEqual(['Comment 1 on Region Map r1', 'Comment 2 on Region Map r1', 'Current Region Map r1']);
    expect(body.context_items[0]!.text).toBe('Region at x 0.1, y 0.1, width 0.2, height 0.2 (fractions of the image)\n\nComment by operator:\nAdd a ford across the swamp.');
    const revisionTaskId = request.task.id as string;
    await waitFor(() => ctx.store.tasks.get(revisionTaskId)!.ardent.task_id && ctx.magnus.openStreams(ctx.store.tasks.get(revisionTaskId)!.ardent.task_id!));
    const revised = encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M0 0L100 100"/><text>Ford</text></svg>');
    register(ctx.store.tasks.get(revisionTaskId)!.ardent.task_id!, 'region-map.svg', 'image/svg+xml', revised, first.digest);
    const r2 = await waitFor(() => ctx.store.review.revisions(deliverable.id)[1]);
    expect(r2).toMatchObject({ revision: 2, supersedes_revision_id: r1.id, blob_sha256: sha(revised), source_task_id: revisionTaskId });
    expect(ctx.store.review.revision(r1.id)!.review_status).toBe('superseded');
    expect(ctx.store.review.comment(region.id)).toMatchObject({ addressed_in_revision_id: r2.id, state: 'open' });
    const resolved = await json(await ctx.call('POST', `/comments/${region.id}/resolve`));
    expect(resolved).toMatchObject({ state: 'resolved' });
  });

  it('records decisions, a final revision and an export whose manifest matches the records', async () => {
    const { project, ardentTaskId } = await setup();
    const map = register(ardentTaskId, 'region-map.svg', 'image/svg+xml', SVG);
    const notes = encode('# Notes\nThe valley floods.');
    register(ardentTaskId, 'notes.md', 'text/markdown', notes);
    const deliverables = await waitFor(() => { const list = ctx.store.review.deliverables(project.id); return list.length === 2 ? list : undefined; });
    const mapDeliverable = deliverables.find(item => item.name === 'Region Map')!;
    const r1 = ctx.store.review.revisions(mapDeliverable.id)[0]!;
    expect((await ctx.call('POST', `/revisions/${r1.id}/decisions`, { body: { decision: 'changes_requested' } })).status).toBe(422);
    expect((await ctx.call('POST', `/projects/${project.id}/exports`, { body: {} })).status).toBe(409);
    const accepted = await json(await ctx.call('POST', `/revisions/${r1.id}/decisions`, { body: { decision: 'accepted', note_md: 'Clear.' } }));
    expect(accepted).toMatchObject({ decision: 'accepted', decided_by: 'operator' });
    const final = await json(await ctx.call('POST', `/deliverables/${mapDeliverable.id}/final`, { body: { revision_id: r1.id } }));
    expect(final.final_revision_id).toBe(r1.id);
    await ctx.call('POST', `/projects/${project.id}/decisions`, { body: { title: 'Scale', statement_md: 'One inch to one mile.' } });

    const created = await ctx.call('POST', `/projects/${project.id}/exports`, { body: {} });
    expect(created.status).toBe(201);
    const record = await json(created);
    expect(record.revision_ids).toEqual([r1.id]);
    const zip = new Uint8Array(await (await ctx.call('GET', `/blobs/${record.blob_sha256}`)).arrayBuffer());
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(['deliverables/region-map/r1-region-map.svg', 'manifest.json']);
    expect(files['deliverables/region-map/r1-region-map.svg']).toEqual(SVG);
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    expect(manifest).toEqual(record.manifest);
    expect(manifest).toMatchObject({
      schema_version: '1.0', generator: 'ardentstudio', project: { id: project.id }, exported_by: 'operator',
      deliverables: [{ name: 'Region Map', path: 'deliverables/region-map/r1-region-map.svg', sha256: map.digest, size: SVG.byteLength, revision: 1, mime: 'image/svg+xml',
        acceptance_status: 'approved', producer: { role: 'mapper', agent_ref: 'node2~mapper' }, supersedes_sha256: null,
        ardent: { manifest: { sha256: map.digest, name: 'region-map.svg' } },
        review: { status: 'accepted', decisions: [{ decision: 'accepted', note_md: 'Clear.' }], comments: { open: 0, resolved: 0 } } }],
      excluded: [{ name: 'notes.md', reason: 'no final revision' }],
      decisions: [{ title: 'Scale', statement_md: 'One inch to one mile.' }],
    });
    expect((await json(await ctx.call('GET', `/projects/${project.id}/exports`))).exports.map((item: { id: string }) => item.id)).toEqual([record.id]);
    const rejected = ctx.store.review.revisions(deliverables.find(item => item.name === 'notes.md')!.id)[0]!;
    await ctx.call('POST', `/revisions/${rejected.id}/decisions`, { body: { decision: 'rejected', note_md: 'Off topic' } });
    expect((await ctx.call('POST', `/deliverables/${rejected.deliverable_id}/final`, { body: { revision_id: rejected.id } })).status).toBe(409);
  });

  it('answers 501 for DOCX conversion without the codec, and stores one conversion per revision with it', async () => {
    let calls = 0;
    const converter: DocxConverter = { name: 'fixture-codec', version: '0.0.0', convert: async () => {
      calls++;
      const id = `p${Math.random().toString(36).slice(2, 10)}`;
      return { document: { paragraphs: [{ id, text: 'The bridge holds.' }] }, paragraphs: [{ id, text: 'The bridge holds.' }] };
    } };
    const { project, ardentTaskId } = await setup({ docx: converter });
    register(ardentTaskId, 'adventure.docx', DOCX, encode('PK fixture docx bytes'));
    const deliverable = await waitFor(() => ctx.store.review.deliverables(project.id)[0]);
    const revision = ctx.store.review.revisions(deliverable.id)[0]!;
    const before = await ctx.call('POST', `/revisions/${revision.id}/comments`, { body: { anchor: { kind: 'docx', paragraph_id: 'p1', start: 0, end: 3, quote: 'The' }, body_md: 'x' } });
    expect((await json(before)).error.code).toBe('DOCX_NOT_CONVERTED');
    const first = await json(await ctx.call('GET', `/revisions/${revision.id}/docx`));
    const second = await json(await ctx.call('GET', `/revisions/${revision.id}/docx`));
    expect(calls).toBe(1);
    expect(second.paragraphs).toEqual(first.paragraphs);
    expect(first).toMatchObject({ source: { kind: 'revision', id: revision.id }, codec: 'fixture-codec', document: { paragraphs: first.paragraphs } });
    const paragraph = first.paragraphs[0].id;
    expect((await ctx.call('POST', `/revisions/${revision.id}/comments`, { body: { anchor: { kind: 'docx', paragraph_id: paragraph, start: 4, end: 10, quote: 'bridge' }, body_md: 'Shorten' } })).status).toBe(201);
    expect((await ctx.call('POST', `/revisions/${revision.id}/comments`, { body: { anchor: { kind: 'docx', paragraph_id: paragraph, start: 0, end: 3, quote: 'Bad' }, body_md: 'x' } })).status).toBe(422);
    // The stored conversion itself is not downloadable as a blob.
    expect((await ctx.call('GET', `/blobs/${first.document_sha256}`)).status).toBe(404);
    await ctx.close();

    ctx = await createTestContext();
    const other = await createProject(ctx);
    const file = await json(await ctx.call('POST', `/projects/${other.id}/files?name=brief.docx`, { raw: 'PK fixture', headers: { 'content-type': DOCX } }));
    const unavailable = await ctx.call('GET', `/files/${file.id}/docx`);
    expect(unavailable.status).toBe(501);
    expect((await json(unavailable)).error.code).toBe('DOCX_CONVERTER_UNAVAILABLE');
    const text = await json(await ctx.call('POST', `/projects/${other.id}/files?name=a.md`, { raw: '# A', headers: { 'content-type': 'text/markdown' } }));
    expect((await ctx.call('GET', `/files/${text.id}/docx`)).status).toBe(409);
  });
});
