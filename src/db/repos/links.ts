// Link references: a URL with a title and note, stored per project and synced to its HiveMem
// workspace as a knowledge source. The linked page is never fetched.
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { newId } from '../../ids.js';
import type { referenceLinkSchema } from '../../shared/browser.js';
import type { Db } from '../database.js';
import type { Clock } from '../json.js';
import type { KnowledgeState } from './files.js';

export type ReferenceLink = z.infer<typeof referenceLinkSchema>;

interface LinkRow {
  id: string; project_id: string; url: string; title: string; note_md: string; created_by: string; created_at: string; updated_at: string;
  deleted_at: string | null; knowledge_state: KnowledgeState; knowledge_source_id: string; knowledge_revision: string | null;
  knowledge_chunks: number | null; knowledge_error: string | null; knowledge_attempts: number; knowledge_next_attempt_at: string | null;
  knowledge_updated_at: string | null;
}

const toLink = (row: LinkRow): ReferenceLink => ({
  id: row.id, project_id: row.project_id, url: row.url, title: row.title, note_md: row.note_md, created_by: row.created_by,
  created_at: row.created_at, updated_at: row.updated_at, deleted_at: row.deleted_at,
  knowledge: { state: row.knowledge_state, source_id: row.knowledge_source_id, revision: row.knowledge_revision, chunks: row.knowledge_chunks,
    error: row.knowledge_error, attempts: row.knowledge_attempts, updated_at: row.knowledge_updated_at },
});

export function linkSourceId(linkId: string): string {
  return `ardentstudio:link:${linkId}`;
}

/** The text HiveMem holds for a link: what a person recorded about it, nothing fetched. */
export function linkKnowledgeText(link: Pick<ReferenceLink, 'title' | 'url' | 'note_md'>): string {
  return [`Reference link: ${link.title}`, link.url, link.note_md.trim()].filter(Boolean).join('\n\n');
}

export function linkRevision(link: Pick<ReferenceLink, 'title' | 'url' | 'note_md'>): string {
  return createHash('sha256').update(linkKnowledgeText(link)).digest('hex');
}

export class LinkRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  create(input: { projectId: string; url: string; title: string; noteMd: string; createdBy: string }): ReferenceLink {
    const id = newId('link');
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO reference_links (id, project_id, url, title, note_md, created_by, created_at, updated_at, knowledge_state, knowledge_source_id,
      knowledge_next_attempt_at, knowledge_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(id, input.projectId, input.url, input.title, input.noteMd, input.createdBy, now, now, linkSourceId(id), now, now);
    return this.get(id)!;
  }

  get(id: string): ReferenceLink | undefined {
    const row = this.db.prepare('SELECT * FROM reference_links WHERE id = ?').get(id) as LinkRow | undefined;
    return row ? toLink(row) : undefined;
  }

  /** Links that are not deleted, oldest first. */
  list(projectId: string): ReferenceLink[] {
    return (this.db.prepare('SELECT * FROM reference_links WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at, id').all(projectId) as LinkRow[]).map(toLink);
  }

  count(projectId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM reference_links WHERE project_id = ? AND deleted_at IS NULL').get(projectId) as { n: number }).n;
  }

  findByUrl(projectId: string, url: string): ReferenceLink | undefined {
    const row = this.db.prepare('SELECT * FROM reference_links WHERE project_id = ? AND url = ? AND deleted_at IS NULL').get(projectId, url) as LinkRow | undefined;
    return row ? toLink(row) : undefined;
  }

  /** Change the link and queue it for sync. */
  update(id: string, patch: { url?: string | undefined; title?: string | undefined; noteMd?: string | undefined }): ReferenceLink {
    const current = this.get(id);
    if (!current) throw new Error('Link not found');
    const now = this.clock.now().toISOString();
    this.db.prepare(`UPDATE reference_links SET url = ?, title = ?, note_md = ?, updated_at = ?, knowledge_state = 'pending', knowledge_error = NULL,
      knowledge_attempts = 0, knowledge_next_attempt_at = ?, knowledge_updated_at = ? WHERE id = ?`)
      .run(patch.url ?? current.url, patch.title ?? current.title, patch.noteMd ?? current.note_md, now, now, now, id);
    return this.get(id)!;
  }

  /** Mark the link deleted. A synced source is queued for retirement; one never synced needs none. */
  delete(id: string): ReferenceLink {
    const current = this.get(id);
    if (!current) throw new Error('Link not found');
    const now = this.clock.now().toISOString();
    const retire = current.knowledge.revision !== null;
    this.db.prepare(`UPDATE reference_links SET deleted_at = ?, updated_at = ?, knowledge_state = ?, knowledge_error = NULL, knowledge_attempts = 0,
      knowledge_next_attempt_at = ?, knowledge_updated_at = ? WHERE id = ?`).run(now, now, retire ? 'pending' : 'not_indexed', retire ? now : null, now, id);
    return this.get(id)!;
  }

  queueSync(id: string): ReferenceLink {
    const now = this.clock.now().toISOString();
    this.db.prepare(`UPDATE reference_links SET knowledge_state = 'pending', knowledge_error = NULL, knowledge_attempts = 0, knowledge_next_attempt_at = ?,
      knowledge_updated_at = ? WHERE id = ?`).run(now, now, id);
    return this.get(id)!;
  }

  /** Links (including deleted ones awaiting retirement) due for a sync attempt, oldest first. */
  dueForSync(limit: number): ReferenceLink[] {
    const now = this.clock.now().toISOString();
    return (this.db.prepare(`SELECT * FROM reference_links WHERE knowledge_state IN ('pending', 'failed')
      AND knowledge_next_attempt_at IS NOT NULL AND knowledge_next_attempt_at <= ? ORDER BY knowledge_next_attempt_at LIMIT ?`)
      .all(now, limit) as LinkRow[]).map(toLink);
  }

  resetInterrupted(): number {
    const now = this.clock.now().toISOString();
    return this.db.prepare("UPDATE reference_links SET knowledge_state = 'pending', knowledge_next_attempt_at = ?, knowledge_updated_at = ? WHERE knowledge_state = 'indexing'")
      .run(now, now).changes;
  }

  setKnowledge(id: string, update: { state: KnowledgeState; revision?: string | null; chunks?: number | null; error?: string | null;
    attempts?: number; nextAttemptAt?: Date | null }): ReferenceLink {
    const current = this.get(id);
    if (!current) throw new Error('Link not found');
    this.db.prepare(`UPDATE reference_links SET knowledge_state = ?, knowledge_revision = ?, knowledge_chunks = ?, knowledge_error = ?, knowledge_attempts = ?,
      knowledge_next_attempt_at = ?, knowledge_updated_at = ? WHERE id = ?`).run(
      update.state,
      update.revision === undefined ? current.knowledge.revision : update.revision,
      update.chunks === undefined ? current.knowledge.chunks : update.chunks,
      update.error === undefined ? current.knowledge.error : update.error,
      update.attempts ?? current.knowledge.attempts,
      update.nextAttemptAt === undefined ? null : update.nextAttemptAt?.toISOString() ?? null,
      this.clock.now().toISOString(), id);
    return this.get(id)!;
  }
}
