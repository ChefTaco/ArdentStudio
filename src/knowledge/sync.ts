// Background sync of reference files and links into each project's HiveMem workspace. State
// lives on the file or link row (pending → indexing → indexed | failed | unsupported), so a
// restart resumes and the UI always shows the real state. Failures retry with backoff; reindex
// starts over. A link is synced as its own text (title, URL, note): the page is never fetched.
// A deleted link's source is retired with an empty sync, and so is a deleted reference file's, which
// is then removed with its bytes (when nothing else references them). The sources of a purged
// project are retired from knowledge_retirements, since their file and link rows are gone.
import type { BlobStore } from '../blobs/store.js';
import { chunkHash, type HiveMemClient } from '../clients/hivemem.js';
import type { Store } from '../db/store.js';
import type { StudioFile } from '../db/repos/files.js';
import type { KnowledgeRetirement } from '../db/repos/retirements.js';
import { linkKnowledgeText, linkRevision, type ReferenceLink } from '../db/repos/links.js';
import { hivememProjectId, type Project } from '../db/repos/projects.js';
import type { Logger } from '../logger.js';
import { chunkText, extractText, KnowledgeTooLargeError } from './extract.js';

export interface KnowledgeSyncOptions {
  intervalMs?: number;
  batchSize?: number;
  /** Failed attempts before a file stays failed until someone asks to reindex it. */
  maxAttempts?: number;
}

export function retryDelayMs(attempts: number): number {
  return Math.min(3600_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : 'Knowledge sync failed').slice(0, 300);
}

export class KnowledgeSync {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private readonly maxAttempts: number;

  constructor(private readonly store: Store, private readonly blobs: BlobStore, private readonly hivemem: Pick<HiveMemClient, 'ensureWorkspace' | 'syncKnowledgeSourceChecked'>,
    private readonly logger: Logger, private readonly options: KnowledgeSyncOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 8;
  }

  start(): void {
    this.store.files.resetInterrupted();
    this.store.links.resetInterrupted();
    this.timer = setInterval(() => this.kick(), this.options.intervalMs ?? 15_000);
    this.timer.unref();
    this.kick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Run a pass now, or right after the one in progress. */
  kick(): void {
    if (this.running) { this.again = true; return; }
    this.running = this.runPass().catch((error: unknown) => {
      this.logger.error('Knowledge sync pass failed', { error: error instanceof Error ? error.message : 'unknown' });
    }).finally(() => {
      this.running = undefined;
      if (this.again) { this.again = false; this.kick(); }
    });
  }

  /** Resolves once no pass is running or queued. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** One pass, awaited: used by tests and by kick(). */
  async runPass(): Promise<void> {
    for (const project of this.store.projects.pendingWorkspaces()) await this.ensureWorkspace(project);
    for (const file of this.store.files.dueForSync(this.options.batchSize ?? 10)) await this.syncFile(file);
    for (const link of this.store.links.dueForSync(this.options.batchSize ?? 10)) await this.syncLink(link);
    for (const retirement of this.store.retirements.due(this.options.batchSize ?? 10)) await this.retireSource(retirement);
  }

  /** Retire one source of a purged project (an empty sync); retried with backoff until HiveMem takes it. */
  async retireSource(retirement: KnowledgeRetirement): Promise<boolean> {
    try {
      await this.hivemem.syncKnowledgeSourceChecked({
        workspace_id: retirement.workspace_id,
        project_id: retirement.hivemem_project_id,
        source_id: retirement.source_id,
        source_uri: retirement.source_uri,
        revision: retirement.revision,
        observed_at: this.store.clock.now().toISOString(),
        chunks: [],
      });
      this.store.retirements.done(retirement.id);
      this.logger.info('Purged project source retired', { project_id: retirement.studio_project_id, source_id: retirement.source_id });
      return true;
    } catch (error) {
      const attempts = retirement.attempts + 1;
      this.store.retirements.failed(retirement.id, attempts, reason(error), new Date(this.store.clock.now().getTime() + retryDelayMs(attempts)));
      this.logger.warn('Purged project source retirement failed', { project_id: retirement.studio_project_id, source_id: retirement.source_id, attempts, error: reason(error) });
      return false;
    }
  }

  async ensureWorkspace(project: Project): Promise<boolean> {
    try {
      await this.hivemem.ensureWorkspace({ workspace_id: project.hivemem.workspace_id, title: project.name,
        description: 'Ardent Project Studio project knowledge', metadata: { product: 'ardentstudio', project_id: project.id } });
      if (project.hivemem.state !== 'ready') this.setWorkspaceState(project.id, 'ready', null);
      return true;
    } catch (error) {
      this.setWorkspaceState(project.id, 'failed', reason(error));
      this.logger.warn('HiveMem workspace unavailable', { project_id: project.id, error: reason(error) });
      return false;
    }
  }

  private setWorkspaceState(projectId: string, state: 'ready' | 'failed', error: string | null): void {
    this.store.tx(() => {
      // Purged while HiveMem was being asked.
      if (!this.store.projects.get(projectId)) return;
      this.store.projects.setHiveMemState(projectId, state, error);
      this.store.emit(projectId, 'project.updated', { hivemem: { state, error } });
    });
  }

  private update(file: StudioFile, change: Parameters<Store['files']['setKnowledge']>[1]): StudioFile {
    return this.store.tx(() => {
      // Its project was purged while HiveMem was being called: the purge queued the retirement.
      if (!this.store.files.stored(file.id)) return file;
      const updated = this.store.files.setKnowledge(file.id, change);
      // A deleted file is gone for everyone; its retirement is not announced as a file change.
      if (!this.store.files.stored(file.id)?.deleted_at) this.store.emit(file.project_id, 'file.updated', { file_id: file.id, knowledge: updated.knowledge });
      return updated;
    });
  }

  async syncFile(queued: StudioFile): Promise<StudioFile> {
    // Re-read: the file may have been deleted (or removed) since the pass listed it.
    const stored = this.store.files.stored(queued.id);
    if (!stored) return queued;
    const { deleted_at: deletedAt, ...file } = stored;
    const project = this.store.projects.get(file.project_id);
    if (!project) return file;
    if (deletedAt !== null) return this.retireFile(file, project);
    const attempts = file.knowledge.attempts + 1;
    this.update(file, { state: 'indexing', attempts, error: null });
    // Deleted while this sync ran: whatever it reached, the source is retired next (an empty sync is harmless).
    const deletedMeanwhile = () => this.store.files.stored(file.id)?.deleted_at
      ? this.update(file, { state: 'pending', error: null, attempts: 0, nextAttemptAt: this.store.clock.now() }) : undefined;
    try {
      const extraction = await extractText(file.mime, await this.blobs.readBytes(file.sha256));
      if (extraction.kind === 'unsupported') return deletedMeanwhile() ?? this.update(file, { state: 'unsupported', error: extraction.reason, chunks: null, nextAttemptAt: null });
      const chunks = chunkText(extraction.text);
      if (project.hivemem.state !== 'ready' && !await this.ensureWorkspace(project)) throw new Error('HiveMem workspace is unavailable');
      const { applied } = await this.hivemem.syncKnowledgeSourceChecked({
        workspace_id: project.hivemem.workspace_id,
        project_id: hivememProjectId(project.id),
        source_id: file.knowledge.source_id ?? `ardentstudio:file:${file.id}`,
        source_uri: `ardentstudio://projects/${project.id}/files/${file.id}`,
        revision: file.sha256,
        observed_at: this.store.clock.now().toISOString(),
        chunks: chunks.map(chunk => ({ ...chunk, tags: ['ardentstudio', `file:${file.id}`] })),
      });
      this.logger.info('Reference indexed', { file_id: file.id, created: applied.created, superseded: applied.superseded, retired: applied.retired });
      if (this.store.files.stored(file.id)?.deleted_at) {
        return this.update(file, { state: 'pending', revision: file.sha256, chunks: chunks.length, error: null, attempts: 0, nextAttemptAt: this.store.clock.now() });
      }
      return this.update(file, { state: 'indexed', revision: file.sha256, chunks: chunks.length, error: null, nextAttemptAt: null });
    } catch (error) {
      const deleted = deletedMeanwhile();
      if (deleted) return deleted;
      if (error instanceof KnowledgeTooLargeError) return this.update(file, { state: 'failed', error: reason(error), nextAttemptAt: null });
      const retry = attempts < this.maxAttempts ? new Date(this.store.clock.now().getTime() + retryDelayMs(attempts)) : null;
      this.logger.warn('Reference sync failed', { file_id: file.id, attempts, error: reason(error) });
      return this.update(file, { state: 'failed', error: reason(error), nextAttemptAt: retry });
    }
  }

  /**
   * Retire a deleted reference file's HiveMem source (an empty sync), then remove the file and, when
   * nothing else references them, its bytes. Retried with backoff until HiveMem takes it: the chunks
   * must not outlive the file.
   */
  private async retireFile(file: StudioFile, project: Project): Promise<StudioFile> {
    const attempts = file.knowledge.attempts + 1;
    this.update(file, { state: 'indexing', attempts, error: null });
    try {
      if (project.hivemem.state !== 'ready' && !await this.ensureWorkspace(project)) throw new Error('HiveMem workspace is unavailable');
      await this.hivemem.syncKnowledgeSourceChecked({
        workspace_id: project.hivemem.workspace_id,
        project_id: hivememProjectId(project.id),
        source_id: file.knowledge.source_id ?? `ardentstudio:file:${file.id}`,
        source_uri: `ardentstudio://projects/${project.id}/files/${file.id}`,
        revision: `retired:${file.knowledge.revision ?? file.sha256}`,
        observed_at: this.store.clock.now().toISOString(),
        chunks: [],
      });
      this.store.tx(() => this.store.files.purge(file.id));
      this.blobs.removeIfUnreferenced(file.sha256);
      this.logger.info('Deleted reference retired', { file_id: file.id });
      return { ...file, knowledge: { ...file.knowledge, state: 'not_indexed', revision: null, chunks: null, error: null, attempts,
        updated_at: this.store.clock.now().toISOString() } };
    } catch (error) {
      this.logger.warn('Deleted reference retirement failed', { file_id: file.id, attempts, error: reason(error) });
      return this.update(file, { state: 'failed', error: reason(error), nextAttemptAt: new Date(this.store.clock.now().getTime() + retryDelayMs(attempts)) });
    }
  }

  private updateLink(link: ReferenceLink, change: Parameters<Store['links']['setKnowledge']>[1]): ReferenceLink {
    return this.store.tx(() => {
      if (!this.store.links.get(link.id)) return link;
      const updated = this.store.links.setKnowledge(link.id, change);
      this.store.emit(link.project_id, 'link.updated', { link: updated });
      return updated;
    });
  }

  async syncLink(link: ReferenceLink): Promise<ReferenceLink> {
    const project = this.store.projects.get(link.project_id);
    if (!project) return link;
    const attempts = link.knowledge.attempts + 1;
    const retiring = link.deleted_at !== null;
    this.updateLink(link, { state: 'indexing', attempts, error: null });
    try {
      if (project.hivemem.state !== 'ready' && !await this.ensureWorkspace(project)) throw new Error('HiveMem workspace is unavailable');
      const content = linkKnowledgeText(link);
      const revision = retiring ? `retired:${link.knowledge.revision ?? 'none'}` : linkRevision(link);
      await this.hivemem.syncKnowledgeSourceChecked({
        workspace_id: project.hivemem.workspace_id,
        project_id: hivememProjectId(project.id),
        source_id: link.knowledge.source_id ?? `ardentstudio:link:${link.id}`,
        source_uri: link.url,
        revision,
        observed_at: this.store.clock.now().toISOString(),
        // An empty chunk list retires the source.
        chunks: retiring ? [] : [{ chunk_key: 'link', content, content_hash: chunkHash(content), heading: link.title, tags: ['ardentstudio', `link:${link.id}`] }],
      });
      this.logger.info(retiring ? 'Link source retired' : 'Link indexed', { link_id: link.id });
      // The link was edited or deleted while HiveMem was being called: what was just synced is
      // already stale. Record its revision (a delete then knows there is a source to retire) and
      // sync again instead of overwriting the queued state.
      const latest = retiring ? undefined : this.store.links.get(link.id);
      if (latest && (latest.deleted_at !== null || linkRevision(latest) !== revision)) {
        return this.updateLink(link, { state: 'pending', revision, chunks: 1, error: null, attempts: 0, nextAttemptAt: this.store.clock.now() });
      }
      return retiring
        ? this.updateLink(link, { state: 'not_indexed', revision: null, chunks: null, error: null, nextAttemptAt: null })
        : this.updateLink(link, { state: 'indexed', revision, chunks: 1, error: null, nextAttemptAt: null });
    } catch (error) {
      const retry = attempts < this.maxAttempts ? new Date(this.store.clock.now().getTime() + retryDelayMs(attempts)) : null;
      this.logger.warn('Link sync failed', { link_id: link.id, attempts, error: reason(error) });
      return this.updateLink(link, { state: 'failed', error: reason(error), nextAttemptAt: retry });
    }
  }
}
