// Studio-side agent records: presentation, server-side Preview drafts and comments on
// Ardent development records. The agent itself (identity, skills, model) lives in Ardent
// and is changed only through Magnus.
import { newId } from '../../ids.js';
import type { Db } from '../database.js';
import { readJson, writeJson, type Clock } from '../json.js';

export interface Portrait { preset: string; accent: string; emblem: string }
export interface AgentPresentation { agent_ref: string; portrait: Portrait | null; avatar_file_id: string | null; display_name: string | null; updated_by: string; updated_at: string }
export interface AgentDraft { id: string; agent_ref: string; user_id: string; base: Record<string, unknown>; draft: Record<string, unknown>; created_at: string; updated_at: string }
export interface DevelopmentComment { id: string; agent_ref: string; record_ref: string; body_md: string; author: string; created_at: string }
export interface AgentOperationRecord {
  id: string; agent_ref: string; project_id: string | null; role_key: string | null; status: 'running' | 'succeeded' | 'failed';
  operation: Record<string, unknown> | null; created_by: string; created_at: string; updated_at: string;
}
type OperationRow = Omit<AgentOperationRecord, 'operation'> & { operation_json: string | null };
const toOperation = ({ operation_json, ...row }: OperationRow): AgentOperationRecord => ({ ...row, operation: readJson<Record<string, unknown> | null>(operation_json, null) });

export class AgentRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  presentation(agentRef: string): AgentPresentation | undefined {
    const row = this.db.prepare('SELECT * FROM agent_presentation WHERE agent_ref = ?').get(agentRef) as (Omit<AgentPresentation, 'portrait'> & { portrait_json: string | null }) | undefined;
    if (!row) return undefined;
    const { portrait_json, ...rest } = row;
    return { ...rest, portrait: readJson<Portrait | null>(portrait_json, null) };
  }

  presentations(): AgentPresentation[] {
    return (this.db.prepare('SELECT agent_ref FROM agent_presentation').all() as Array<{ agent_ref: string }>).map(row => this.presentation(row.agent_ref)!);
  }

  savePresentation(input: { agentRef: string; portrait: Portrait | null; avatarFileId: string | null; displayName: string | null; updatedBy: string }): AgentPresentation {
    this.db.prepare(`INSERT INTO agent_presentation (agent_ref, portrait_json, avatar_file_id, display_name, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (agent_ref) DO UPDATE SET portrait_json = excluded.portrait_json, avatar_file_id = excluded.avatar_file_id,
      display_name = excluded.display_name, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(input.agentRef, input.portrait ? writeJson(input.portrait) : null, input.avatarFileId, input.displayName, input.updatedBy, this.clock.now().toISOString());
    return this.presentation(input.agentRef)!;
  }

  /** One draft per agent and person. */
  saveDraft(input: { agentRef: string; userId: string; base: Record<string, unknown>; draft: Record<string, unknown> }): AgentDraft {
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO agent_drafts (id, agent_ref, user_id, base_json, draft_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (agent_ref, user_id) DO UPDATE SET base_json = excluded.base_json, draft_json = excluded.draft_json, updated_at = excluded.updated_at`)
      .run(newId('draft'), input.agentRef, input.userId, writeJson(input.base), writeJson(input.draft), now, now);
    return this.draft(input.agentRef, input.userId)!;
  }

  draft(agentRef: string, userId: string): AgentDraft | undefined {
    const row = this.db.prepare('SELECT * FROM agent_drafts WHERE agent_ref = ? AND user_id = ?').get(agentRef, userId) as
      (Omit<AgentDraft, 'base' | 'draft'> & { base_json: string; draft_json: string }) | undefined;
    if (!row) return undefined;
    const { base_json, draft_json, ...rest } = row;
    return { ...rest, base: readJson(base_json, {}), draft: readJson(draft_json, {}) };
  }

  deleteDraft(agentRef: string, userId: string): boolean {
    return this.db.prepare('DELETE FROM agent_drafts WHERE agent_ref = ? AND user_id = ?').run(agentRef, userId).changes > 0;
  }

  addDevelopmentComment(input: { agentRef: string; recordRef: string; bodyMd: string; author: string }): DevelopmentComment {
    const id = newId('developmentComment');
    this.db.prepare('INSERT INTO development_comments (id, agent_ref, record_ref, body_md, author, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.agentRef, input.recordRef, input.bodyMd, input.author, this.clock.now().toISOString());
    return this.db.prepare('SELECT * FROM development_comments WHERE id = ?').get(id) as DevelopmentComment;
  }

  /** Comments on several records at once, grouped by record. */
  developmentCommentsFor(agentRef: string, recordRefs: readonly string[]): Map<string, DevelopmentComment[]> {
    const wanted = new Set(recordRefs);
    const grouped = new Map<string, DevelopmentComment[]>();
    for (const comment of this.developmentComments(agentRef)) {
      if (!wanted.has(comment.record_ref)) continue;
      grouped.set(comment.record_ref, [...grouped.get(comment.record_ref) ?? [], comment]);
    }
    return grouped;
  }

  // ── New Agent operations ──

  recordOperation(input: { id: string; agentRef: string; projectId: string | null; roleKey: string | null; createdBy: string }): AgentOperationRecord {
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO agent_operations (id, agent_ref, project_id, role_key, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
      ON CONFLICT (id) DO NOTHING`).run(input.id, input.agentRef, input.projectId, input.roleKey, input.createdBy, now, now);
    return this.operation(input.id)!;
  }

  operation(id: string): AgentOperationRecord | undefined {
    const row = this.db.prepare('SELECT * FROM agent_operations WHERE id = ?').get(id) as OperationRow | undefined;
    return row ? toOperation(row) : undefined;
  }

  runningOperations(): AgentOperationRecord[] {
    return (this.db.prepare("SELECT * FROM agent_operations WHERE status = 'running' ORDER BY created_at").all() as OperationRow[]).map(toOperation);
  }

  /** Store Magnus's latest view. Returns false when nothing changed. */
  updateOperation(id: string, status: AgentOperationRecord['status'], operation: Record<string, unknown>): boolean {
    const text = writeJson(operation);
    const changes = this.db.prepare('UPDATE agent_operations SET status = ?, operation_json = ?, updated_at = ? WHERE id = ? AND (operation_json IS NOT ? OR status <> ?)')
      .run(status, text, this.clock.now().toISOString(), id, text, status).changes;
    return changes > 0;
  }

  developmentComments(agentRef: string, recordRef?: string): DevelopmentComment[] {
    return (recordRef
      ? this.db.prepare('SELECT * FROM development_comments WHERE agent_ref = ? AND record_ref = ? ORDER BY created_at, id').all(agentRef, recordRef)
      : this.db.prepare('SELECT * FROM development_comments WHERE agent_ref = ? ORDER BY created_at, id').all(agentRef)) as DevelopmentComment[];
  }
}
