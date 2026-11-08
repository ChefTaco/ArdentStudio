// Export package: a zip of each deliverable's final revision plus manifest.json, which carries
// the Ardent manifest fields, Studio's review status and decisions, and the project decisions.
// The zip is stored as a blob and recorded, so it can be downloaded again.
import { zipSync, type Zippable } from 'fflate';
import type { BlobStore } from '../blobs/store.js';
import type { Project } from '../db/repos/projects.js';
import type { Deliverable, ReviewStatus, StudioExport } from '../db/repos/review.js';
import type { Store } from '../db/store.js';
import { MIME_FORMATS } from './importer.js';

export class ExportError extends Error {
  override name = 'ExportError';
  constructor(readonly code: 'NOTHING_FINAL' | 'EXPORT_TOO_LARGE' | 'UNKNOWN_DELIVERABLE', message: string) { super(message); }
}

/** Studio review status as an Ardent manifest acceptance status. */
export function acceptanceStatus(status: ReviewStatus): 'approved' | 'partial' | 'rejected' | 'unreviewed' {
  return status === 'accepted' ? 'approved' : status === 'rejected' ? 'rejected' : status === 'changes_requested' ? 'partial' : 'unreviewed';
}

const slug = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'deliverable';

export async function buildExport(store: Store, blobs: BlobStore, project: Project, input: { deliverableIds?: string[] | undefined; userId: string; audit: (record: StudioExport) => void }): Promise<StudioExport> {
  const all = store.review.deliverables(project.id);
  const unknown = (input.deliverableIds ?? []).filter(id => !all.some(item => item.id === id));
  if (unknown.length) throw new ExportError('UNKNOWN_DELIVERABLE', `Not deliverables of this project: ${unknown.join(', ')}`);
  const chosen = input.deliverableIds ? all.filter(item => input.deliverableIds!.includes(item.id)) : all;
  const included = chosen.filter((item): item is Deliverable & { final_revision_id: string } => Boolean(item.final_revision_id));
  if (!included.length) throw new ExportError('NOTHING_FINAL', 'No deliverable has a final revision to export');

  const exportedAt = store.clock.now();
  const files: Zippable = {};
  const used = new Set<string>();
  let total = 0;
  const entries: Array<Record<string, unknown> & { revision_id: string }> = [];
  for (const deliverable of included) {
    const revision = store.review.revision(deliverable.final_revision_id)!;
    const manifest = (revision.ardent?.manifest ?? {}) as Record<string, unknown>;
    const original = typeof manifest.name === 'string' ? manifest.name : `${slug(deliverable.name)}.${MIME_FORMATS[revision.mime] ?? 'bin'}`;
    let path = `deliverables/${slug(deliverable.name)}/r${revision.revision}-${slug(original)}`;
    for (let index = 2; used.has(path); index++) path = `deliverables/${slug(deliverable.name)}-${index}/r${revision.revision}-${slug(original)}`;
    used.add(path);
    const bytes = await blobs.readBytes(revision.blob_sha256);
    total += bytes.byteLength;
    if (total > blobs.maxBytes) throw new ExportError('EXPORT_TOO_LARGE', `The final revisions exceed the ${blobs.maxBytes}-byte limit for one stored file`);
    files[path] = [bytes, { level: revision.mime.startsWith('image/') && revision.mime !== 'image/svg+xml' ? 0 : 6 }];
    const comments = store.review.comments(revision.id);
    const binding = revision.producer_binding_id ? store.team.bindings().find(item => item.id === revision.producer_binding_id) : undefined;
    const supersedes = revision.supersedes_revision_id ? store.review.revision(revision.supersedes_revision_id) : undefined;
    entries.push({
      deliverable_id: deliverable.id, name: deliverable.name, kind: deliverable.kind, path, revision_id: revision.id, revision: revision.revision,
      mime: revision.mime, size: revision.size, sha256: revision.blob_sha256, supersedes_sha256: supersedes?.blob_sha256 ?? null,
      producer: { role: deliverable.producer_role, agent_ref: binding?.agent_ref ?? null }, source_task_id: revision.source_task_id,
      acceptance_status: acceptanceStatus(revision.review_status),
      ardent: revision.ardent ? { artifact_id: revision.ardent.artifact_id ?? null, task_id: revision.ardent.task_id ?? null, manifest } : null,
      review: {
        status: revision.review_status,
        decisions: store.review.decisions(revision.id).map(item => ({ decision: item.decision, note_md: item.note_md, decided_by: item.decided_by, at: item.created_at })),
        comments: { open: comments.filter(item => item.state === 'open').length, resolved: comments.filter(item => item.state === 'resolved').length },
      },
    });
  }
  const manifest = {
    schema_version: '1.0',
    generator: 'ardentstudio',
    project: { id: project.id, name: project.name },
    exported_at: exportedAt.toISOString(),
    exported_by: input.userId,
    deliverables: entries,
    excluded: chosen.filter(item => !item.final_revision_id).map(item => ({ deliverable_id: item.id, name: item.name, reason: 'no final revision' })),
    decisions: store.room.decisions(project.id).filter(item => !item.superseded_by)
      .map(item => ({ id: item.id, title: item.title, statement_md: item.statement_md, rationale_md: item.rationale_md, decided_by: item.decided_by, created_at: item.created_at })),
  };
  files['manifest.json'] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const zip = zipSync(files, { mtime: exportedAt });
  if (zip.byteLength > blobs.maxBytes) throw new ExportError('EXPORT_TOO_LARGE', `The export exceeds the ${blobs.maxBytes}-byte limit for one stored file`);
  const blob = await blobs.putBytes(zip, 'application/zip');
  return store.tx(() => {
    const record = store.review.createExport({ projectId: project.id, revisionIds: entries.map(entry => entry.revision_id), blobSha256: blob.sha256, manifest, createdBy: input.userId });
    store.emit(project.id, 'export.created', { export: record });
    input.audit(record);
    return record;
  });
}
