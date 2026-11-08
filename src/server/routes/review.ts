// Deliverable Review: deliverables and their revisions, anchored comments, review decisions,
// final revisions, revision requests to the producer role, and export packages.
import type { z } from 'zod';
import { publicTask } from '../../conductor/conductor.js';
import type { Deliverable, DeliverableRevision } from '../../db/repos/review.js';
import type { Store } from '../../db/store.js';
import { AnchorError, checkAnchor } from '../../review/anchors.js';
import { DOCX_MIME, docxDocument, DocxUnavailableError } from '../../review/docx.js';
import { buildExport, ExportError } from '../../review/export.js';
import { toPublicImport } from '../../review/importer.js';
import {
  commentIdSchema, deliverableIdSchema, fileIdSchema, revisionIdSchema,
  type createCommentRequestSchema, type createExportRequestSchema, type createReviewDecisionRequestSchema, type revisionRequestSchema, type setFinalRequestSchema,
} from '../../shared/browser.js';
import { actorOf, requireActive, requireProject, type AppDeps } from '../deps.js';
import { ApiError, notFound } from '../errors.js';
import type { createRouter } from '../routing.js';
import { requireTeam } from './room.js';

function requireDeliverable(store: Store, id: string | undefined): Deliverable {
  const parsed = deliverableIdSchema.safeParse(id);
  const deliverable = parsed.success ? store.review.deliverable(parsed.data) : undefined;
  if (!deliverable) throw notFound('Deliverable');
  return deliverable;
}

function requireRevision(store: Store, id: string | undefined): { revision: DeliverableRevision; deliverable: Deliverable } {
  const parsed = revisionIdSchema.safeParse(id);
  const revision = parsed.success ? store.review.revision(parsed.data) : undefined;
  if (!revision) throw notFound('Revision');
  return { revision, deliverable: store.review.deliverable(revision.deliverable_id)! };
}

export function reviewRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  const { store, blobs, conductor } = deps;

  const deliverableView = (deliverable: Deliverable) => {
    const comments = store.review.deliverableComments(deliverable.id);
    return { ...deliverable, revisions: store.review.revisions(deliverable.id),
      comments: { open: comments.filter(item => item.state === 'open').length, resolved: comments.filter(item => item.state === 'resolved').length } };
  };

  register('GET', '/projects/{projectId}/deliverables', (_c, { params }) => {
    const project = requireProject(store, params.projectId);
    return { body: {
      deliverables: store.review.deliverables(project.id).map(deliverableView),
      imports: store.review.imports(project.id).filter(item => item.state !== 'imported').map(toPublicImport),
    } };
  });

  register('GET', '/deliverables/{deliverableId}', (_c, { params }) => ({ body: deliverableView(requireDeliverable(store, params.deliverableId)) }));

  register('GET', '/revisions/{revisionId}', (_c, { params }) => {
    const { revision, deliverable } = requireRevision(store, params.revisionId);
    return { body: { revision, deliverable: deliverableView(deliverable), comments: store.review.comments(revision.id), decisions: store.review.decisions(revision.id) } };
  });

  register('GET', '/revisions/{revisionId}/comments', (_c, { params }) => ({ body: { comments: store.review.comments(requireRevision(store, params.revisionId).revision.id) } }));

  register('POST', '/revisions/{revisionId}/comments', async (_c, { params, body, principal, idempotencyKey }) => {
    const { revision, deliverable } = requireRevision(store, params.revisionId);
    requireActive(requireProject(store, deliverable.project_id));
    const input = body as z.infer<typeof createCommentRequestSchema>;
    try { await checkAnchor(store, blobs, revision, input.anchor); } catch (error) {
      if (error instanceof AnchorError) throw new ApiError(error.status, error.code, error.message);
      throw error;
    }
    const actor = actorOf(principal);
    const comment = store.tx(() => {
      const created = store.review.addComment({ projectId: deliverable.project_id, revisionId: revision.id, anchor: input.anchor, bodyMd: input.body_md, author: actor.userId });
      store.emit(deliverable.project_id, 'review.comment.created', { comment: created });
      store.record(actor, 'review.comment', { type: 'comment', id: created.id }, { revision_id: revision.id, anchor: input.anchor.kind }, idempotencyKey);
      return created;
    });
    return { status: 201, body: comment };
  });

  register('POST', '/comments/{commentId}/resolve', (_c, { params, principal, idempotencyKey }) => {
    const parsed = commentIdSchema.safeParse(params.commentId);
    const comment = parsed.success ? store.review.comment(parsed.data) : undefined;
    if (!comment) throw notFound('Comment');
    requireActive(requireProject(store, comment.project_id));
    if (comment.state === 'resolved') return { body: comment };
    const actor = actorOf(principal);
    return { body: store.tx(() => {
      const resolved = store.review.resolveComment(comment.id);
      store.emit(comment.project_id, 'review.comment.updated', { comment: resolved });
      store.record(actor, 'review.comment.resolve', { type: 'comment', id: comment.id }, {}, idempotencyKey);
      return resolved;
    }) };
  });

  register('POST', '/revisions/{revisionId}/decisions', (_c, { params, body, principal, idempotencyKey }) => {
    const { revision, deliverable } = requireRevision(store, params.revisionId);
    requireActive(requireProject(store, deliverable.project_id));
    const input = body as z.infer<typeof createReviewDecisionRequestSchema>;
    if (input.decision === 'changes_requested' && !input.note_md.trim() && !store.review.comments(revision.id).some(item => item.state === 'open')) {
      throw new ApiError(422, 'NOTE_REQUIRED', 'Requesting changes needs a note or an open comment');
    }
    const actor = actorOf(principal);
    const decision = store.tx(() => {
      const created = store.review.decide({ projectId: deliverable.project_id, revisionId: revision.id, decision: input.decision, noteMd: input.note_md, decidedBy: actor.userId });
      store.emit(deliverable.project_id, 'review.decision.created', { decision: created, revision: store.review.revision(revision.id) });
      store.record(actor, 'review.decide', { type: 'revision', id: revision.id }, { decision: input.decision }, idempotencyKey);
      return created;
    });
    return { status: 201, body: decision };
  });

  register('POST', '/deliverables/{deliverableId}/final', (_c, { params, body, principal, idempotencyKey }) => {
    const deliverable = requireDeliverable(store, params.deliverableId);
    requireActive(requireProject(store, deliverable.project_id));
    const input = body as z.infer<typeof setFinalRequestSchema>;
    const revision = store.review.revision(input.revision_id);
    if (!revision || revision.deliverable_id !== deliverable.id) throw new ApiError(422, 'UNKNOWN_REVISION', 'The revision is not a revision of this deliverable');
    if (revision.review_status === 'rejected') throw new ApiError(409, 'REVISION_REJECTED', 'A rejected revision cannot be final');
    const actor = actorOf(principal);
    return { body: store.tx(() => {
      const updated = deliverableView(store.review.setFinal(deliverable.id, revision.id));
      store.emit(deliverable.project_id, 'deliverable.updated', { deliverable_id: deliverable.id, final_revision_id: revision.id });
      store.record(actor, 'review.final', { type: 'deliverable', id: deliverable.id }, { revision_id: revision.id }, idempotencyKey);
      return updated;
    }) };
  });

  register('POST', '/projects/{projectId}/revision-requests', (_c, { params, body, principal, idempotencyKey }) => {
    const project = requireActive(requireProject(store, params.projectId));
    const input = body as z.infer<typeof revisionRequestSchema>;
    const comments = input.comment_ids.map(id => store.review.comment(id));
    if (comments.some(item => !item || item.project_id !== project.id)) throw new ApiError(422, 'UNKNOWN_COMMENT', 'Every comment must belong to this project');
    const deliverableIds = new Set(comments.map(item => store.review.revision(item!.revision_id)!.deliverable_id));
    if (deliverableIds.size !== 1) throw new ApiError(422, 'MIXED_DELIVERABLES', 'A revision request covers comments on one deliverable');
    const deliverable = store.review.deliverable([...deliverableIds][0]!)!;
    const latest = store.review.latestRevision(deliverable.id)!;
    const revision = requireTeam(store, project.id);
    const roleKey = input.role_key ?? deliverable.producer_role;
    const role = roleKey ? revision.body.roles.find(item => item.key === roleKey) : undefined;
    if (!role?.agent_ref) throw new ApiError(409, 'TEAM_NOT_READY', roleKey ? `Role "${roleKey}" has no bound agent in team r${revision.revision}` : 'Name the role that should revise it');
    const actor = actorOf(principal);
    const result = store.tx(() => {
      const conversation = conductor.ensureTeamConversation(project.id, actor.userId);
      const ask = input.instructions_md.trim() || 'Please address the comments.';
      const message = store.room.addMessage({ conversationId: conversation.id, author: { kind: 'user', user_id: actor.userId }, kind: 'revision_request', addressees: [role.key],
        bodyMd: `Revision requested for ${deliverable.name} r${latest.revision}: ${ask}`, links: { deliverable_id: deliverable.id, revision_id: latest.id, comment_ids: input.comment_ids },
        state: 'complete' });
      store.emit(project.id, 'message.created', { message });
      const format = latest.mime === DOCX_MIME ? 'DOCX (use document_render with format docx, or artifact_write)' : latest.mime;
      const task = conductor.queueTask({
        projectId: project.id, title: `Revise ${deliverable.name}`, mode: 'revision', roleKey: role.key,
        bindingId: role.binding_id ?? store.team.ensureBinding(role.agent_ref!).id, assignmentRevision: revision.revision,
        source: { deliverable_id: deliverable.id, deliverable_name: deliverable.name, revision_id: latest.id, comment_ids: input.comment_ids, revises_sha256: latest.blob_sha256 },
        createdBy: actor.userId, conversationId: conversation.id, triggerMessageId: message.id,
        instructionsMd: `${ask}\n\nRevise ${deliverable.name} (revision ${latest.revision}, ${latest.mime}) to address the ${input.comment_ids.length} review comment(s) in the context items. `
          + `Save the result as ${format} with revises_sha256 ${latest.blob_sha256}.`,
      });
      store.review.linkCommentsToRevisionTask(input.comment_ids, task.id);
      const linked = input.comment_ids.map(id => store.review.comment(id)!);
      for (const comment of linked) store.emit(project.id, 'review.comment.updated', { comment });
      store.record(actor, 'review.revision_request', { type: 'deliverable', id: deliverable.id }, { task_id: task.id, comments: input.comment_ids.length }, idempotencyKey);
      return { message, task: publicTask(task), comments: linked };
    });
    conductor.kick();
    return { status: 201, body: result };
  });

  register('GET', '/projects/{projectId}/exports', (_c, { params }) => ({ body: { exports: store.review.exports(requireProject(store, params.projectId).id) } }));

  register('POST', '/projects/{projectId}/exports', async (_c, { params, body, principal, idempotencyKey }) => {
    const project = requireProject(store, params.projectId);
    const input = body as z.infer<typeof createExportRequestSchema>;
    const actor = actorOf(principal);
    try {
      const record = await buildExport(store, blobs, project, { deliverableIds: input.deliverable_ids, userId: actor.userId,
        audit: created => store.record(actor, 'review.export', { type: 'export', id: created.id }, { revisions: created.revision_ids.length, sha256: created.blob_sha256 }, idempotencyKey) });
      return { status: 201, body: record };
    } catch (error) {
      if (error instanceof ExportError) throw new ApiError(error.code === 'UNKNOWN_DELIVERABLE' ? 422 : 409, error.code, error.message);
      throw error;
    }
  });

  const docx = async (kind: 'file' | 'revision', id: string, sha256: string, mime: string) => {
    if (mime !== DOCX_MIME) throw new ApiError(409, 'NOT_DOCX', 'This file is not a DOCX');
    try {
      const { record, document } = await docxDocument(store, blobs, deps.docx, { kind, id, sha256 });
      return { body: { source: { kind, id }, blob_sha256: record.blob_sha256, codec: record.codec, codec_version: record.codec_version,
        document_sha256: record.document_sha256, paragraphs: record.paragraphs, document } };
    } catch (error) {
      if (error instanceof DocxUnavailableError) throw new ApiError(501, 'DOCX_CONVERTER_UNAVAILABLE', error.message);
      throw error;
    }
  };

  register('GET', '/files/{fileId}/docx', (_c, { params }) => {
    const parsed = fileIdSchema.safeParse(params.fileId);
    const file = parsed.success ? store.files.get(parsed.data) : undefined;
    if (!file) throw notFound('File');
    return docx('file', file.id, file.sha256, file.mime);
  });

  register('GET', '/revisions/{revisionId}/docx', (_c, { params }) => {
    const { revision } = requireRevision(store, params.revisionId);
    return docx('revision', revision.id, revision.blob_sha256, revision.mime);
  });
}
