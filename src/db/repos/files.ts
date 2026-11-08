import type { z } from 'zod';
import { newId } from '../../ids.js';
import type { fileSchema, filePurposeSchema, knowledgeStateSchema } from '../../shared/browser.js';
import type { Db } from '../database.js';
import type { Clock } from '../json.js';

export type StudioFile = z.infer<typeof fileSchema>;
export type FilePurpose = z.infer<typeof filePurposeSchema>;
export type KnowledgeState = z.infer<typeof knowledgeStateSchema>;

interface FileRow {
  id: string; project_id: string; name: string; mime: string; size: number; sha256: string; purpose: FilePurpose;
  created_by: string; created_at: string; knowledge_state: KnowledgeState; knowledge_source_id: string | null;
  knowledge_revision: string | null; knowledge_chunks: number | null; knowledge_error: string | null; knowledge_attempts: number;
  knowledge_next_attempt_at: string | null; knowledge_updated_at: string | null;
}

const toFile = (row: FileRow): StudioFile => ({
  id: row.id, project_id: row.project_id, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256, purpose: row.purpose,
  created_by: row.created_by, created_at: row.created_at,
  knowledge: { state: row.knowledge_state, source_id: row.knowledge_source_id, revision: row.knowledge_revision, chunks: row.knowledge_chunks,
    error: row.knowledge_error, attempts: row.knowledge_attempts, updated_at: row.knowledge_updated_at },
});

/** The HiveMem source for a file: stable across revisions, so a new upload of the same file id supersedes chunks. */
export function knowledgeSourceId(fileId: string): string {
  return `ardentstudio:file:${fileId}`;
}

export class FileRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  create(input: { projectId: string; name: string; mime: string; size: number; sha256: string; purpose: FilePurpose; createdBy: string }): StudioFile {
    const id = newId('file');
    const now = this.clock.now().toISOString();
    const state: KnowledgeState = input.purpose === 'reference' ? 'pending' : 'not_indexed';
    this.db.prepare(`INSERT INTO files (id, project_id, name, mime, size, sha256, purpose, created_by, created_at, knowledge_state, knowledge_source_id, knowledge_next_attempt_at, knowledge_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.projectId, input.name, input.mime, input.size, input.sha256, input.purpose,
      input.createdBy, now, state, state === 'pending' ? knowledgeSourceId(id) : null, state === 'pending' ? now : null, now);
    return this.get(id)!;
  }

  get(id: string): StudioFile | undefined {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
    return row ? toFile(row) : undefined;
  }

  list(projectId: string, purpose?: FilePurpose): StudioFile[] {
    const rows = (purpose
      ? this.db.prepare('SELECT * FROM files WHERE project_id = ? AND purpose = ? ORDER BY created_at, id').all(projectId, purpose)
      : this.db.prepare('SELECT * FROM files WHERE project_id = ? ORDER BY created_at, id').all(projectId)) as FileRow[];
    return rows.map(toFile);
  }

  count(projectId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM files WHERE project_id = ?').get(projectId) as { n: number }).n;
  }

  /** Whether any project file references this blob. Only referenced blobs are served. */
  blobReferenced(sha256: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM files WHERE sha256 = ? LIMIT 1').get(sha256));
  }

  /** Files due for a knowledge sync attempt, oldest first. */
  dueForSync(limit: number): StudioFile[] {
    const now = this.clock.now().toISOString();
    return (this.db.prepare(`SELECT * FROM files WHERE knowledge_state IN ('pending', 'failed')
      AND knowledge_next_attempt_at IS NOT NULL AND knowledge_next_attempt_at <= ? ORDER BY knowledge_next_attempt_at LIMIT ?`)
      .all(now, limit) as FileRow[]).map(toFile);
  }

  /** Files left `indexing` by a crash go back to pending. */
  resetInterrupted(): number {
    const now = this.clock.now().toISOString();
    return this.db.prepare("UPDATE files SET knowledge_state = 'pending', knowledge_next_attempt_at = ?, knowledge_updated_at = ? WHERE knowledge_state = 'indexing'")
      .run(now, now).changes;
  }

  queueSync(id: string): StudioFile {
    const now = this.clock.now().toISOString();
    this.db.prepare(`UPDATE files SET knowledge_state = 'pending', knowledge_source_id = COALESCE(knowledge_source_id, ?), knowledge_error = NULL,
      knowledge_attempts = 0, knowledge_next_attempt_at = ?, knowledge_updated_at = ? WHERE id = ?`).run(knowledgeSourceId(id), now, now, id);
    return this.get(id)!;
  }

  setKnowledge(id: string, update: { state: KnowledgeState; revision?: string | null; chunks?: number | null; error?: string | null;
    attempts?: number; nextAttemptAt?: Date | null }): StudioFile {
    const now = this.clock.now().toISOString();
    const current = this.get(id);
    if (!current) throw new Error('File not found');
    this.db.prepare(`UPDATE files SET knowledge_state = ?, knowledge_revision = ?, knowledge_chunks = ?, knowledge_error = ?, knowledge_attempts = ?,
      knowledge_next_attempt_at = ?, knowledge_updated_at = ? WHERE id = ?`).run(
      update.state,
      update.revision === undefined ? current.knowledge.revision : update.revision,
      update.chunks === undefined ? current.knowledge.chunks : update.chunks,
      update.error === undefined ? current.knowledge.error : update.error,
      update.attempts ?? current.knowledge.attempts,
      update.nextAttemptAt === undefined ? null : update.nextAttemptAt?.toISOString() ?? null,
      now, id);
    return this.get(id)!;
  }
}
