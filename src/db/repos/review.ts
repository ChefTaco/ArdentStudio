// Deliverables, their immutable revisions, anchored comments, review decisions and exports.
// Routes arrive with Deliverable Review; storage rules are fixed now.
import { newId } from '../../ids.js';
import type { Db } from '../database.js';
import { readJson, writeJson, type Clock } from '../json.js';

export type ReviewStatus = 'unreviewed' | 'changes_requested' | 'accepted' | 'rejected' | 'superseded';
export type ReviewDecisionKind = 'accepted' | 'changes_requested' | 'rejected';

export interface Deliverable {
  id: string; project_id: string; requested_deliverable_id: string | null; name: string; kind: string; producer_role: string | null;
  final_revision_id: string | null; created_at: string; updated_at: string;
}
export interface DeliverableRevision {
  id: string; deliverable_id: string; revision: number; blob_sha256: string; mime: string; size: number; producer_binding_id: string | null;
  source_task_id: string | null; source_message_id: string | null; ardent: Record<string, unknown> | null; supersedes_revision_id: string | null;
  received_at: string; review_status: ReviewStatus;
}
/** Text {start,end,quote,source_sha256}, DOCX {paragraph_id,start,end,quote}, PDF {page,rect?,quote?}, image {x,y,w,h}, or whole file. */
export type CommentAnchor = { kind: string } & Record<string, unknown>;
export interface ReviewComment {
  id: string; project_id: string; revision_id: string; anchor: CommentAnchor; body_md: string; author: string; state: 'open' | 'resolved';
  revision_task_id: string | null; addressed_in_revision_id: string | null; created_at: string; resolved_at: string | null;
}
export interface ReviewDecision { id: string; project_id: string; revision_id: string; decision: ReviewDecisionKind; note_md: string; decided_by: string; created_at: string }
export interface StudioExport { id: string; project_id: string; revision_ids: string[]; blob_sha256: string; manifest: Record<string, unknown>; created_by: string; created_at: string }

type RevisionRow = Omit<DeliverableRevision, 'ardent'> & { ardent_json: string | null };
const toRevision = ({ ardent_json, ...row }: RevisionRow): DeliverableRevision => ({ ...row, ardent: readJson<Record<string, unknown> | null>(ardent_json, null) });

export class ReviewRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  createDeliverable(input: { projectId: string; requestedDeliverableId?: string | null; name: string; kind: string; producerRole?: string | null }): Deliverable {
    const id = newId('deliverable');
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO deliverables (id, project_id, requested_deliverable_id, name, kind, producer_role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.projectId, input.requestedDeliverableId ?? null, input.name, input.kind, input.producerRole ?? null, now, now);
    return this.deliverable(id)!;
  }

  deliverable(id: string): Deliverable | undefined {
    return this.db.prepare('SELECT * FROM deliverables WHERE id = ?').get(id) as Deliverable | undefined;
  }

  deliverables(projectId: string): Deliverable[] {
    return this.db.prepare('SELECT * FROM deliverables WHERE project_id = ? ORDER BY created_at, id').all(projectId) as Deliverable[];
  }

  /** A received file becomes revision n+1; the previous revision is marked superseded. */
  addRevision(input: { deliverableId: string; blobSha256: string; mime: string; size: number; producerBindingId?: string | null; sourceTaskId?: string | null;
    sourceMessageId?: string | null; ardent?: Record<string, unknown> | null }): DeliverableRevision {
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM deliverable_revisions WHERE deliverable_id = ? ORDER BY revision DESC LIMIT 1').get(input.deliverableId) as RevisionRow | undefined;
      const id = newId('deliverableRevision');
      const now = this.clock.now().toISOString();
      this.db.prepare(`INSERT INTO deliverable_revisions (id, deliverable_id, revision, blob_sha256, mime, size, producer_binding_id, source_task_id, source_message_id,
        ardent_json, supersedes_revision_id, received_at, review_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unreviewed')`).run(
        id, input.deliverableId, (previous?.revision ?? 0) + 1, input.blobSha256, input.mime, input.size, input.producerBindingId ?? null,
        input.sourceTaskId ?? null, input.sourceMessageId ?? null, input.ardent ? writeJson(input.ardent) : null, previous?.id ?? null, now);
      if (previous && previous.review_status !== 'accepted' && previous.review_status !== 'rejected') {
        this.db.prepare("UPDATE deliverable_revisions SET review_status = 'superseded' WHERE id = ?").run(previous.id);
      }
      this.db.prepare('UPDATE deliverables SET updated_at = ? WHERE id = ?').run(now, input.deliverableId);
      return this.revision(id)!;
    })();
  }

  revision(id: string): DeliverableRevision | undefined {
    const row = this.db.prepare('SELECT * FROM deliverable_revisions WHERE id = ?').get(id) as RevisionRow | undefined;
    return row ? toRevision(row) : undefined;
  }

  revisions(deliverableId: string): DeliverableRevision[] {
    return (this.db.prepare('SELECT * FROM deliverable_revisions WHERE deliverable_id = ? ORDER BY revision').all(deliverableId) as RevisionRow[]).map(toRevision);
  }

  setFinal(deliverableId: string, revisionId: string): Deliverable {
    const revision = this.revision(revisionId);
    if (!revision || revision.deliverable_id !== deliverableId) throw new Error('Revision does not belong to this deliverable');
    this.db.prepare('UPDATE deliverables SET final_revision_id = ?, updated_at = ? WHERE id = ?').run(revisionId, this.clock.now().toISOString(), deliverableId);
    return this.deliverable(deliverableId)!;
  }

  addComment(input: { projectId: string; revisionId: string; anchor: CommentAnchor; bodyMd: string; author: string }): ReviewComment {
    const id = newId('comment');
    this.db.prepare(`INSERT INTO review_comments (id, project_id, revision_id, anchor_json, body_md, author, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`)
      .run(id, input.projectId, input.revisionId, writeJson(input.anchor), input.bodyMd, input.author, this.clock.now().toISOString());
    return this.comment(id)!;
  }

  linkCommentsToRevisionTask(commentIds: string[], taskId: string): void {
    const update = this.db.prepare('UPDATE review_comments SET revision_task_id = ? WHERE id = ?');
    for (const id of commentIds) update.run(taskId, id);
  }

  markAddressed(taskId: string, revisionId: string): number {
    return this.db.prepare('UPDATE review_comments SET addressed_in_revision_id = ? WHERE revision_task_id = ? AND addressed_in_revision_id IS NULL').run(revisionId, taskId).changes;
  }

  /** Resolution is always a person's choice. */
  resolveComment(id: string): ReviewComment {
    this.db.prepare("UPDATE review_comments SET state = 'resolved', resolved_at = ? WHERE id = ? AND state = 'open'").run(this.clock.now().toISOString(), id);
    return this.comment(id)!;
  }

  comment(id: string): ReviewComment | undefined {
    const row = this.db.prepare('SELECT * FROM review_comments WHERE id = ?').get(id) as (Omit<ReviewComment, 'anchor'> & { anchor_json: string }) | undefined;
    if (!row) return undefined;
    const { anchor_json, ...rest } = row;
    return { ...rest, anchor: readJson<CommentAnchor>(anchor_json, { kind: 'file' }) };
  }

  comments(revisionId: string): ReviewComment[] {
    return (this.db.prepare('SELECT id FROM review_comments WHERE revision_id = ? ORDER BY created_at, id').all(revisionId) as Array<{ id: string }>).map(row => this.comment(row.id)!);
  }

  decide(input: { projectId: string; revisionId: string; decision: ReviewDecisionKind; noteMd?: string; decidedBy: string }): ReviewDecision {
    return this.db.transaction(() => {
      const id = newId('reviewDecision');
      this.db.prepare('INSERT INTO review_decisions (id, project_id, revision_id, decision, note_md, decided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.projectId, input.revisionId, input.decision, input.noteMd ?? '', input.decidedBy, this.clock.now().toISOString());
      this.db.prepare('UPDATE deliverable_revisions SET review_status = ? WHERE id = ?').run(input.decision, input.revisionId);
      return this.db.prepare('SELECT * FROM review_decisions WHERE id = ?').get(id) as ReviewDecision;
    })();
  }

  decisions(revisionId: string): ReviewDecision[] {
    return this.db.prepare('SELECT * FROM review_decisions WHERE revision_id = ? ORDER BY created_at, id').all(revisionId) as ReviewDecision[];
  }

  createExport(input: { projectId: string; revisionIds: string[]; blobSha256: string; manifest: Record<string, unknown>; createdBy: string }): StudioExport {
    const id = newId('export');
    this.db.prepare('INSERT INTO exports (id, project_id, revision_ids_json, blob_sha256, manifest_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.projectId, writeJson(input.revisionIds), input.blobSha256, writeJson(input.manifest), input.createdBy, this.clock.now().toISOString());
    return this.exports(input.projectId).find(item => item.id === id)!;
  }

  exports(projectId: string): StudioExport[] {
    return (this.db.prepare('SELECT * FROM exports WHERE project_id = ? ORDER BY created_at, id').all(projectId) as
      Array<Omit<StudioExport, 'revision_ids' | 'manifest'> & { revision_ids_json: string; manifest_json: string }>)
      .map(({ revision_ids_json, manifest_json, ...rest }) => ({ ...rest, revision_ids: readJson(revision_ids_json, []), manifest: readJson(manifest_json, {}) }));
  }

  /** Open review work per project, for project cards. */
  openReviewCount(projectId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM deliverable_revisions r JOIN deliverables d ON d.id = r.deliverable_id
      WHERE d.project_id = ? AND r.review_status = 'unreviewed'`).get(projectId) as { n: number }).n;
  }
}
