// Brings agent deliverables into review. When a followed task journals `artifact_registered`,
// the import is queued in the same transaction as the journal cursor. A worker then streams the
// bytes from Magnus into the blob store, checks them against the registered SHA-256, and records
// a deliverable revision that supersedes the previous one. A file that fails verification is never
// recorded; the room says so.
//
// From an agent with artifact transfer v2 (profile artifact_transfer >= 2, Magnus 3.3.0) the bytes are
// pulled from …/artifacts/{sha256}/content into <blobs>/.partial/<import id>. A transfer that stops (a
// restart, a dropped connection) resumes: the partial file is hashed again as a stream, and the rest is
// asked for with Range and If-Range. The whole-file digest is verified before the file is renamed into
// the blob store. The artifact's renditions (previews, model inputs) are imported with it. An older agent
// keeps the v1 whole download, which C4 limits to 2 MiB: a larger artifact fails with TRANSFER_REQUIRES_V2.
import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat, truncate } from 'node:fs/promises';
import { z } from 'zod';
import { BlobIntegrityError, BlobTooLargeError, type BlobRecord, type BlobStore } from '../blobs/store.js';
import { ARDENT_RUNTIME_LEVELS, ARDENT_UNSUPPORTED_CAPABILITY, MagnusError, type MagnusClient } from '../clients/magnus.js';
import { ServiceTokenError } from '../clients/service-token.js';
import type { Conductor } from '../conductor/conductor.js';
import type { ArtifactImport, Deliverable, DeliverableRendition } from '../db/repos/review.js';
import type { StudioTask } from '../db/repos/tasks.js';
import type { Store } from '../db/store.js';
import type { Logger } from '../logger.js';

export type ImporterMagnus = Pick<MagnusClient, 'artifactStream' | 'artifactContent' | 'artifactRenditions'>;

/** The largest artifact a v1 (whole) download takes; above it an agent needs artifact transfer v2 (C4). */
export const TRANSFER_V1_MAX_BYTES = 2 * 1024 * 1024;
/** How often a running transfer records its progress and announces artifact.import.progress. */
const PROGRESS_MS = 2_000;
/** At most this many renditions are imported per artifact. */
const MAX_RENDITIONS = 16;

/** A transfer failure with a machine-readable code. Permanent failures are not retried. */
export class TransferError extends Error {
  override name = 'TransferError';
  constructor(message: string, readonly code: string, readonly permanent: boolean) { super(message); }
}

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
  /** Aborts the transfer in progress when the importer stops. */
  private transfer = new AbortController();
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
    if (this.transfer.signal.aborted) this.transfer = new AbortController();
    // Partial files of imports that are no longer pending are left from a crash between settling and cleanup.
    for (const id of this.options.blobs.partialImports()) {
      if (this.store.review.importRecord(id)?.state !== 'pending') void this.options.blobs.removePartial(id);
    }
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // A transfer has no deadline of its own: end it rather than wait for a large or stalled file.
    this.transfer.abort();
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
      for (const row of due) {
        await this.importOne(row);
        if (this.store.review.importRecord(row.id)?.state !== 'pending') this.options.conductor.workflows.importsSettled(row.task_id);
      }
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
    if (!task) { this.settle(row, 'failed', 'The task that registered this file no longer exists', 'TASK_GONE'); return; }
    if (this.store.review.revisionByArtifact(row.artifact_id)) { this.store.tx(() => this.store.review.settleImport(row.id, { state: 'imported' })); return; }
    try {
      if (row.size > this.options.blobs.maxBytes) throw new BlobTooLargeError(this.options.blobs.maxBytes);
      const runtime = await this.options.conductor.runtimeOf(row.agent_ref);
      let blob: BlobRecord;
      let renditions: DeliverableRendition[] = [];
      if (runtime.artifact_transfer >= ARDENT_RUNTIME_LEVELS.artifact_transfer) {
        blob = await this.ranged(row);
        renditions = await this.renditions(row, blob);
      } else {
        if (row.size > TRANSFER_V1_MAX_BYTES) {
          throw new TransferError(`it is larger than ${TRANSFER_V1_MAX_BYTES} bytes and the agent does not support artifact transfer v2 (upgrade its Ardent to 3.2.0 or later and its Magnus agent)`,
            'TRANSFER_REQUIRES_V2', true);
        }
        this.store.review.importProgress(row.id, { receivedBytes: 0, transfer: 'whole' });
        const { body } = await this.options.magnus.artifactStream(row.agent_ref, row.sha256, { signal: this.transfer.signal });
        blob = await this.options.blobs.put(body as ReadableStream<Uint8Array>, row.mime, row.sha256);
        this.store.review.importProgress(row.id, { receivedBytes: blob.size, transfer: 'whole' });
      }
      this.record(row, task, blob.size, renditions);
      await this.options.blobs.removePartial(row.id);
    } catch (error) {
      // Interrupted by shutdown, not a failed attempt: the row stays due and is imported (resumed) after the restart.
      if (this.stopped) return;
      if (error instanceof MagnusError && error.code === ARDENT_UNSUPPORTED_CAPABILITY) this.options.conductor.forgetRuntime(row.agent_ref);
      const attempts = row.attempts + 1;
      const permanent = error instanceof BlobTooLargeError || (error instanceof TransferError && error.permanent)
        || (error instanceof MagnusError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429 && error.code !== ARDENT_UNSUPPORTED_CAPABILITY);
      const code = error instanceof TransferError ? error.code : error instanceof BlobIntegrityError ? 'DIGEST_MISMATCH' : error instanceof BlobTooLargeError ? 'TOO_LARGE'
        : error instanceof MagnusError ? 'MAGNUS_REFUSED' : 'TRANSFER_FAILED';
      const reason = error instanceof TransferError ? error.message
        : error instanceof BlobIntegrityError ? 'the received bytes do not match the registered SHA-256'
          : error instanceof BlobTooLargeError ? `it is larger than the ${this.options.blobs.maxBytes}-byte limit`
            : error instanceof MagnusError || error instanceof ServiceTokenError ? `Magnus answered: ${error.message.slice(0, 200)}`
              : `the transfer failed (${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'})`;
      if (permanent || attempts >= (this.options.maxAttempts ?? 5)) {
        await this.options.blobs.removePartial(row.id);
        this.settle(row, 'failed', reason, code, task);
      } else {
        const retryAt = new Date(this.store.clock.now().getTime() + (this.options.retryMs ?? 2_000) * 2 ** (attempts - 1));
        this.store.tx(() => {
          this.store.review.settleImport(row.id, { state: 'pending', error: reason, errorCode: code, retryAt });
          this.store.emit(row.project_id, 'artifact.import.updated', { import: this.publicImport(row.id) });
        });
        this.options.logger.warn('Artifact import failed; retrying', { artifact_id: row.artifact_id, attempts, error: reason });
      }
    }
  }

  /**
   * Artifact transfer v2: append to the import's partial file from where it stopped, then verify the
   * whole-file digest and move it into the blob store. The partial file is hashed again as a stream,
   * so memory stays bounded whatever the size.
   */
  private async ranged(row: ArtifactImport): Promise<BlobRecord> {
    const { blobs } = this.options;
    const path = blobs.partialPath(row.id);
    let have = await stat(path).then(info => info.size, () => 0);
    if (have > row.size) { await truncate(path, 0); have = 0; }
    let hash = createHash('sha256');
    if (have > 0) {
      await hashFile(path, have, hash);
      this.store.tx(() => {
        this.store.review.countResume(row.id);
        this.store.review.importProgress(row.id, { receivedBytes: have, transfer: 'range' });
        this.store.emit(row.project_id, 'artifact.import.updated', { import: this.publicImport(row.id), resumed_from: have });
      });
    } else {
      this.store.review.importProgress(row.id, { receivedBytes: 0, transfer: 'range' });
    }
    if (have < row.size || row.size === 0) {
      const content = await this.options.magnus.artifactContent(row.agent_ref, row.sha256, { from: have, ifRange: `"${row.sha256}"`, signal: this.transfer.signal });
      const refuse = async (error: Error) => { await content.body.cancel().catch(() => undefined); return error; };
      if (content.sha256 && content.sha256 !== row.sha256) throw await refuse(new BlobIntegrityError('Magnus served another artifact'));
      if (content.total !== undefined && content.total !== row.size) {
        throw await refuse(new TransferError(`Magnus reports ${content.total} bytes where the agent registered ${row.size}`, 'SIZE_MISMATCH', false));
      }
      if (content.status === 200 && have > 0) {
        // The range was not honoured (If-Range did not match, or the relay sent everything): start over.
        have = 0;
        hash = createHash('sha256');
      } else if (content.status === 206 && content.start !== have) {
        throw await refuse(new TransferError(`Magnus answered from byte ${content.start}, not ${have}`, 'RANGE_MISMATCH', false));
      }
      const handle = await open(path, have === 0 ? 'w' : 'a', 0o600);
      let recorded = Date.now();
      const progress = () => this.store.tx(() => {
        this.store.review.importProgress(row.id, { receivedBytes: have, transfer: 'range' });
        this.store.emit(row.project_id, 'artifact.import.progress', { import: this.publicImport(row.id) });
      });
      try {
        for await (const chunk of content.body as unknown as AsyncIterable<Uint8Array>) {
          have += chunk.byteLength;
          if (have > row.size) throw new BlobIntegrityError('Magnus sent more bytes than the agent registered');
          hash.update(chunk);
          await handle.write(chunk);
          if (Date.now() - recorded >= PROGRESS_MS) { await handle.datasync(); progress(); recorded = Date.now(); }
        }
        await handle.sync();
      } finally {
        await handle.close();
        // Whatever stopped the transfer, the bytes on disk are what a resume continues from.
        try { this.store.review.importProgress(row.id, { receivedBytes: have, transfer: 'range' }); } catch { /* the database closed during shutdown */ }
      }
    }
    if (have !== row.size) throw new TransferError(`the transfer ended after ${have} of ${row.size} bytes`, 'TRANSFER_INCOMPLETE', false);
    if (hash.digest('hex') !== row.sha256) {
      await blobs.removePartial(row.id);
      throw new BlobIntegrityError('Content does not match the expected SHA-256');
    }
    return blobs.adoptPartial(row.id, row.mime, row.sha256, row.size);
  }

  /**
   * The artifact's renditions (original first), each stored as a verified blob. Best effort: a rendition
   * that cannot be read or verified is left out, never the original.
   */
  private async renditions(row: ArtifactImport, original: BlobRecord): Promise<DeliverableRendition[]> {
    const own: DeliverableRendition = { role: 'original', sha256: original.sha256, mime: row.mime, size: original.size, purpose: 'download', width: null, height: null, has_alpha: null };
    let listed;
    try { listed = await this.options.magnus.artifactRenditions(row.agent_ref, row.sha256, { signal: this.transfer.signal }); } catch (error) {
      if (this.stopped) throw error;
      this.options.logger.warn('Artifact renditions could not be read', { artifact_id: row.artifact_id, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
      return [own];
    }
    const out: DeliverableRendition[] = [];
    for (const item of listed.slice(0, MAX_RENDITIONS)) {
      const entry: DeliverableRendition = { role: item.role, sha256: item.sha256, mime: item.mime, size: item.size, purpose: item.purpose ?? null,
        width: item.width ?? null, height: item.height ?? null, has_alpha: item.has_alpha ?? null };
      if (item.sha256 === row.sha256) { out.push({ ...entry, mime: row.mime, size: original.size }); continue; }
      if (out.some(existing => existing.sha256 === item.sha256) || item.size > this.options.blobs.maxBytes) continue;
      try {
        if (!this.options.blobs.get(item.sha256)) {
          const content = await this.options.magnus.artifactContent(row.agent_ref, item.sha256, { signal: this.transfer.signal });
          await this.options.blobs.put(content.body, item.mime, item.sha256);
        }
        out.push(entry);
      } catch (error) {
        if (this.stopped) throw error;
        this.options.logger.warn('An artifact rendition was not imported', { artifact_id: row.artifact_id, sha256: item.sha256, error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
      }
    }
    if (!out.some(item => item.sha256 === row.sha256)) out.unshift(own);
    return out;
  }

  private settle(row: ArtifactImport, state: 'failed', reason: string, code: string, task?: StudioTask): void {
    this.store.tx(() => {
      this.store.review.settleImport(row.id, { state, error: reason, errorCode: code });
      this.store.emit(row.project_id, 'artifact.import.updated', { import: this.publicImport(row.id) });
      const conversationId = task?.conversation_id ?? this.store.room.teamConversation(row.project_id)?.id;
      if (conversationId) {
        this.options.conductor.systemMessage(conversationId, `${row.name} from ${this.roleName(task)} was not added to review: ${reason}.`,
          { task_id: row.task_id, artifact_id: row.artifact_id, sha256: row.sha256, error_code: code });
      }
    });
  }

  private record(row: ArtifactImport, task: StudioTask, size: number, renditions: readonly DeliverableRendition[]): void {
    this.store.tx(() => {
      if (this.store.review.revisionByArtifact(row.artifact_id)) { this.store.review.settleImport(row.id, { state: 'imported' }); return; }
      const project = this.store.projects.get(row.project_id)!;
      const supersedes = typeof row.manifest.supersedes_sha256 === 'string' ? row.manifest.supersedes_sha256 : null;
      const format = MIME_FORMATS[row.mime];
      // A role produces a requested deliverable when the deliverable names it, or when the role lists
      // the deliverable in its team revision (how Team Assignment assigns producers).
      const listed = new Set(this.roleOf(task)?.deliverables ?? []);
      const requested = project.deliverables.filter(item => (item.producer_role_key === task.role_key || listed.has(item.name))
        && format && (item.formats as string[]).includes(format));
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
      if (renditions.length) this.store.review.addRenditions(revision.id, renditions);
      this.store.review.importProgress(row.id, { receivedBytes: size, transfer: row.transfer ?? this.store.review.importRecord(row.id)?.transfer ?? 'whole' });
      this.store.review.settleImport(row.id, { state: 'imported', revisionId: revision.id });
      this.store.emit(project.id, 'deliverable.revision.created', { deliverable_id: deliverable.id, revision: this.store.review.revision(revision.id) });
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
      // The verified revision is the record Delivering is derived from.
      this.options.conductor.refreshActivity(project.id, task.binding_id);
    });
  }

  private deliverableOf(id: string | undefined): Deliverable | undefined {
    return id ? this.store.review.deliverable(id) : undefined;
  }

  /** The task's role in the team revision it runs under, else in the current team. */
  private roleOf(task: StudioTask) {
    const revision = task.assignment_revision ? this.store.team.revision(task.project_id, task.assignment_revision) : this.store.team.current(task.project_id);
    return revision?.body.roles.find(role => role.key === task.role_key);
  }

  private roleName(task: StudioTask | undefined): string {
    if (!task) return 'an agent';
    return this.roleOf(task)?.name ?? task.role_key ?? 'an agent';
  }

  publicImport(id: number) {
    return toPublicImport(this.store.review.importRecord(id)!);
  }
}

export function toPublicImport(row: ArtifactImport) {
  return { artifact_id: row.artifact_id, task_id: row.task_id, agent_ref: row.agent_ref, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256,
    state: row.state, attempts: row.attempts, error: row.error, error_code: row.error_code, revision_id: row.revision_id, received_bytes: row.received_bytes,
    transfer: row.transfer, resumes: row.resumes, updated_at: row.updated_at };
}

/** Hash the first `length` bytes of a file into `hash`, streaming. */
async function hashFile(path: string, length: number, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path, { start: 0, end: length - 1 })) hash.update(chunk as Buffer);
}
