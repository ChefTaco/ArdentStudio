// Brings agent deliverables into review. When a followed task journals `artifact_registered`,
// the import is queued in the same transaction as the journal cursor. A worker then streams the
// bytes from Magnus into the blob store, checks them against the registered SHA-256, and records
// a deliverable revision that supersedes the previous one. A file that fails verification is never
// recorded; the room says so.
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { z } from 'zod';
import { BlobIntegrityError, BlobTooLargeError, type BlobStore } from '../blobs/store.js';
import { MagnusError, type MagnusClient } from '../clients/magnus.js';
import { ServiceTokenError } from '../clients/service-token.js';
import type { Conductor } from '../conductor/conductor.js';
import type { ArtifactImport, Deliverable } from '../db/repos/review.js';
import type { StudioTask } from '../db/repos/tasks.js';
import type { Store } from '../db/store.js';
import type { Logger } from '../logger.js';

export type ImporterMagnus = Pick<MagnusClient, 'artifactStream'>;

const registered = z.object({
  artifact_id: z.string().min(1).max(128), name: z.string().min(1).max(256), mime: z.string().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(0), revision: z.number().int().optional(),
  supersedes_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), manifest: z.record(z.string(), z.unknown()).optional(),
});

export const MIME_FORMATS: Record<string, string> = {
  'text/markdown': 'md', 'text/plain': 'txt', 'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'text/csv': 'csv', 'application/json': 'json',
};

function kindOf(mime: string): string {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'text/csv' || mime === 'application/json') return 'data';
  return 'document';
}

export interface ImporterOptions {
  store: Store;
  blobs: BlobStore;
  magnus: ImporterMagnus;
  conductor: Conductor;
  logger: Logger;
  /** First retry delay; doubles per attempt. Default 2 s. */
  retryMs?: number;
  maxAttempts?: number;
}

export class ArtifactImporter {
  private running: Promise<void> | undefined;
  private again = false;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly store: Store;

  constructor(private readonly options: ImporterOptions) {
    this.store = options.store;
    options.conductor.onJournalEvent((task, event) => {
      if (event.kind !== 'artifact_registered' || !task.ardent.agent_ref) return;
      const detail = registered.safeParse(event.detail);
      if (!detail.success) { this.options.logger.warn('Ignored an unreadable artifact registration', { task_id: task.id }); return; }
      this.store.review.queueImport({
        project_id: task.project_id, task_id: task.id, agent_ref: task.ardent.agent_ref, artifact_id: detail.data.artifact_id, sha256: detail.data.sha256,
        name: detail.data.name, mime: detail.data.mime, size: detail.data.size, ardent_event_seq: event.sequence,
        // Ardent 2.2.0 journals the full manifest; an older registration keeps its key fields.
        manifest: detail.data.manifest ?? { name: detail.data.name, mime: detail.data.mime, sha256: detail.data.sha256, size: detail.data.size,
          revision: detail.data.revision ?? 1, supersedes_sha256: detail.data.supersedes_sha256 ?? null },
      });
      // The registration commits with the journal cursor; import it right after.
      queueMicrotask(() => this.kick());
    });
  }

  start(): void {
    this.stopped = false;
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  kick(): void {
    if (this.stopped) return;
    if (this.running) { this.again = true; return; }
    this.running = this.drain().finally(() => {
      this.running = undefined;
      if (this.again) { this.again = false; this.kick(); }
    });
  }

  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const due = this.store.review.dueImports();
      if (!due.length || this.stopped) break;
      for (const row of due) await this.importOne(row);
    }
    this.schedule();
  }

  private schedule(): void {
    const next = this.store.db.prepare("SELECT MIN(next_attempt_at) AS at FROM artifact_imports WHERE state = 'pending' AND next_attempt_at IS NOT NULL").get() as { at: string | null };
    if (!next.at || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.kick(); }, Math.max(10, Date.parse(next.at) - this.store.clock.now().getTime()));
    this.timer.unref();
  }

  private async importOne(row: ArtifactImport): Promise<void> {
    const task = this.store.tasks.get(row.task_id);
    if (!task) { this.settle(row, 'failed', 'The task that registered this file no longer exists'); return; }
    if (this.store.review.revisionByArtifact(row.artifact_id)) { this.store.tx(() => this.store.review.settleImport(row.id, { state: 'imported' })); return; }
    try {
      const { body } = await this.options.magnus.artifactStream(row.agent_ref, row.sha256);
      const blob = await this.options.blobs.put(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), row.mime, row.sha256);
      this.record(row, task, blob.size);
    } catch (error) {
      const attempts = row.attempts + 1;
      const permanent = error instanceof BlobTooLargeError
        || (error instanceof MagnusError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429);
      const reason = error instanceof BlobIntegrityError ? 'the received bytes do not match the registered SHA-256'
        : error instanceof BlobTooLargeError ? `it is larger than the ${this.options.blobs.maxBytes}-byte limit`
          : error instanceof MagnusError || error instanceof ServiceTokenError ? `Magnus answered: ${error.message.slice(0, 200)}`
            : `the transfer failed (${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'})`;
      if (permanent || attempts >= (this.options.maxAttempts ?? 5)) {
        this.settle(row, 'failed', reason, task);
      } else {
        const retryAt = new Date(this.store.clock.now().getTime() + (this.options.retryMs ?? 2_000) * 2 ** (attempts - 1));
        this.store.tx(() => {
          this.store.review.settleImport(row.id, { state: 'pending', error: reason, retryAt });
          this.store.emit(row.project_id, 'artifact.import.updated', { import: this.publicImport(row.id) });
        });
        this.options.logger.warn('Artifact import failed; retrying', { artifact_id: row.artifact_id, attempts, error: reason });
      }
    }
  }

  private settle(row: ArtifactImport, state: 'failed', reason: string, task?: StudioTask): void {
    this.store.tx(() => {
      this.store.review.settleImport(row.id, { state, error: reason });
      this.store.emit(row.project_id, 'artifact.import.updated', { import: this.publicImport(row.id) });
      const conversationId = task?.conversation_id ?? this.store.room.teamConversation(row.project_id)?.id;
      if (conversationId) {
        this.options.conductor.systemMessage(conversationId, `${row.name} from ${this.roleName(task)} was not added to review: ${reason}.`,
          { task_id: row.task_id, artifact_id: row.artifact_id, sha256: row.sha256 });
      }
    });
  }

  private record(row: ArtifactImport, task: StudioTask, size: number): void {
    this.store.tx(() => {
      if (this.store.review.revisionByArtifact(row.artifact_id)) { this.store.review.settleImport(row.id, { state: 'imported' }); return; }
      const project = this.store.projects.get(row.project_id)!;
      const supersedes = typeof row.manifest.supersedes_sha256 === 'string' ? row.manifest.supersedes_sha256 : null;
      const format = MIME_FORMATS[row.mime];
      const requested = project.deliverables.filter(item => item.producer_role_key === task.role_key && format && (item.formats as string[]).includes(format));
      const existing = (supersedes ? this.deliverableOf(this.store.review.revisionByBlob(project.id, supersedes)?.deliverable_id) : undefined)
        ?? this.deliverableOf(typeof task.source.deliverable_id === 'string' ? task.source.deliverable_id : undefined)
        ?? this.store.review.deliverableByName(project.id, row.name)
        ?? (requested.length === 1 ? this.store.review.deliverables(project.id).find(item => item.requested_deliverable_id === requested[0]!.id) : undefined);
      const deliverable = existing ?? this.store.review.createDeliverable({
        projectId: project.id, requestedDeliverableId: requested.length === 1 ? requested[0]!.id : null,
        name: requested.length === 1 ? requested[0]!.name : row.name, kind: requested.length === 1 ? requested[0]!.kind : kindOf(row.mime), producerRole: task.role_key,
      });
      const revision = this.store.review.addRevision({
        deliverableId: deliverable.id, blobSha256: row.sha256, mime: row.mime, size, producerBindingId: task.binding_id, sourceTaskId: task.id,
        sourceMessageId: task.trigger_message_id, ardentArtifactId: row.artifact_id,
        ardent: { agent_ref: row.agent_ref, artifact_id: row.artifact_id, task_id: task.ardent.task_id, sha256: row.sha256, manifest: row.manifest },
      });
      this.store.review.settleImport(row.id, { state: 'imported', revisionId: revision.id });
      this.store.emit(project.id, 'deliverable.revision.created', { deliverable_id: deliverable.id, revision });
      this.store.emit(project.id, 'artifact.import.updated', { import: this.publicImport(row.id) });
      if (task.mode === 'revision' && this.store.review.markAddressed(task.id, revision.id)) {
        for (const comment of this.store.review.commentsForTask(task.id)) this.store.emit(project.id, 'review.comment.updated', { comment });
      }
      const conversationId = task.conversation_id ?? this.store.room.teamConversation(project.id)?.id;
      if (conversationId && task.binding_id) {
        const message = this.store.room.addMessage({ conversationId, author: { kind: 'agent', binding_id: task.binding_id, role_key: task.role_key }, kind: 'delivery',
          bodyMd: `Delivered ${deliverable.name} (revision ${revision.revision})`, replyTo: task.trigger_message_id,
          links: { task_id: task.id, deliverable_id: deliverable.id, revision_id: revision.id }, state: 'complete' });
        this.store.emit(project.id, 'message.created', { message });
      }
      this.options.conductor.noteActivity(task, 'delivering', `Delivered ${deliverable.name} r${revision.revision}`,
        { task_id: task.id, ardent_event_seq: row.ardent_event_seq, kind: 'artifact_registered' });
    });
  }

  private deliverableOf(id: string | undefined): Deliverable | undefined {
    return id ? this.store.review.deliverable(id) : undefined;
  }

  private roleName(task: StudioTask | undefined): string {
    if (!task) return 'an agent';
    const revision = task.assignment_revision ? this.store.team.revision(task.project_id, task.assignment_revision) : undefined;
    return revision?.body.roles.find(role => role.key === task.role_key)?.name ?? task.role_key ?? 'an agent';
  }

  publicImport(id: number) {
    return toPublicImport(this.store.review.importRecord(id)!);
  }
}

export function toPublicImport(row: ArtifactImport) {
  return { artifact_id: row.artifact_id, task_id: row.task_id, agent_ref: row.agent_ref, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256,
    state: row.state, attempts: row.attempts, error: row.error, revision_id: row.revision_id, updated_at: row.updated_at };
}
