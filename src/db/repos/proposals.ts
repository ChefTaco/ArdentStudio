// Team proposals asked of an agent. Studio stores the request it sent, every attempt and the
// validated proposal; it never applies one.
import type { z } from 'zod';
import { newId } from '../../ids.js';
import type { teamDraftBodySchema, teamProposalAttemptSchema, teamProposalRecordSchema, teamProposalSchema, teamProposalStateSchema } from '../../shared/browser.js';
import type { Db } from '../database.js';
import { readJson, writeJson, type Clock } from '../json.js';

export type TeamProposalRecord = z.infer<typeof teamProposalRecordSchema>;
export type TeamProposal = z.infer<typeof teamProposalSchema>;
export type TeamProposalState = z.infer<typeof teamProposalStateSchema>;
export type TeamProposalAttempt = z.infer<typeof teamProposalAttemptSchema>;
export type TeamDraftBody = z.output<typeof teamDraftBodySchema>;

interface ProposalRow {
  id: string; project_id: string; agent_ref: string; role_key: string | null; state: TeamProposalState; progress: string | null; task_id: string | null;
  attempts_json: string; basis_json: string; request_json: string; proposal_json: string | null; draft_body_json: string | null; error: string | null;
  created_by: string; created_at: string; updated_at: string; finished_at: string | null;
}

export const FINISHED_PROPOSAL_STATES: readonly TeamProposalState[] = ['ready', 'failed', 'cancelled'];

/** A stored proposal with the request it was asked with (kept server-side). */
export interface StoredProposal { record: TeamProposalRecord; request: unknown }

const toRecord = (row: ProposalRow): TeamProposalRecord => ({
  id: row.id, project_id: row.project_id, agent_ref: row.agent_ref, role_key: row.role_key, state: row.state, progress: row.progress, task_id: row.task_id,
  attempts: readJson(row.attempts_json, []), basis: readJson(row.basis_json, { current_revision: null, draft_revision: null, source_template: null }),
  proposal: readJson<TeamProposal | null>(row.proposal_json, null), draft_body: readJson<TeamDraftBody | null>(row.draft_body_json, null),
  error: row.error, created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at, finished_at: row.finished_at,
});

export class TeamProposalRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  create(input: { projectId: string; agentRef: string; roleKey: string | null; basis: TeamProposalRecord['basis']; request: unknown; createdBy: string }): TeamProposalRecord {
    const id = newId('teamProposal');
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO team_proposals (id, project_id, agent_ref, role_key, state, progress, basis_json, request_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`).run(id, input.projectId, input.agentRef, input.roleKey, 'Waiting for the agent to start',
      writeJson(input.basis), writeJson(input.request), input.createdBy, now, now);
    return this.get(id)!;
  }

  get(id: string): TeamProposalRecord | undefined {
    const row = this.db.prepare('SELECT * FROM team_proposals WHERE id = ?').get(id) as ProposalRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  stored(id: string): StoredProposal | undefined {
    const row = this.db.prepare('SELECT * FROM team_proposals WHERE id = ?').get(id) as ProposalRow | undefined;
    return row ? { record: toRecord(row), request: readJson<unknown>(row.request_json, null) } : undefined;
  }

  /** Newest first. */
  list(projectId: string, limit = 20): TeamProposalRecord[] {
    return (this.db.prepare('SELECT * FROM team_proposals WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(projectId, limit) as ProposalRow[]).map(toRecord);
  }

  /** Proposals still queued or running. */
  open(projectId: string): TeamProposalRecord[] {
    return (this.db.prepare("SELECT * FROM team_proposals WHERE project_id = ? AND state IN ('queued', 'running') ORDER BY created_at, id").all(projectId) as ProposalRow[]).map(toRecord);
  }

  /** Start an attempt: its task becomes the current one. */
  addAttempt(id: string, taskId: string, progress: string): TeamProposalRecord {
    const current = this.get(id)!;
    const attempts: TeamProposalAttempt[] = [...current.attempts, { attempt: current.attempts.length + 1, task_id: taskId, outcome: 'pending', error: null }];
    this.db.prepare("UPDATE team_proposals SET state = 'queued', progress = ?, task_id = ?, attempts_json = ?, updated_at = ? WHERE id = ?")
      .run(progress, taskId, writeJson(attempts), this.clock.now().toISOString(), id);
    return this.get(id)!;
  }

  /** Settle the current attempt. */
  settleAttempt(id: string, outcome: TeamProposalAttempt['outcome'], error: string | null): TeamProposalRecord {
    const current = this.get(id)!;
    const attempts = current.attempts.map(item => item.task_id === current.task_id ? { ...item, outcome, error } : item);
    this.db.prepare('UPDATE team_proposals SET attempts_json = ?, updated_at = ? WHERE id = ?').run(writeJson(attempts), this.clock.now().toISOString(), id);
    return this.get(id)!;
  }

  setProgress(id: string, state: 'queued' | 'running', progress: string): TeamProposalRecord {
    this.db.prepare('UPDATE team_proposals SET state = ?, progress = ?, updated_at = ? WHERE id = ?').run(state, progress, this.clock.now().toISOString(), id);
    return this.get(id)!;
  }

  finish(id: string, input: { state: 'ready' | 'failed' | 'cancelled'; progress: string; error?: string | null; proposal?: TeamProposal; draftBody?: TeamDraftBody }): TeamProposalRecord {
    const now = this.clock.now().toISOString();
    this.db.prepare(`UPDATE team_proposals SET state = ?, progress = ?, error = ?, proposal_json = ?, draft_body_json = ?, updated_at = ?, finished_at = ? WHERE id = ?`)
      .run(input.state, input.progress, input.error ?? null, input.proposal ? writeJson(input.proposal) : null, input.draftBody ? writeJson(input.draftBody) : null, now, now, id);
    return this.get(id)!;
  }
}
