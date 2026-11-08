// The Studio task mirror. Ardent owns execution; these rows record what Studio asked for,
// under which team revision, and the Ardent state last observed. Routes and the conductor
// arrive with the conversation room.
import { newId } from '../../ids.js';
import type { Db } from '../database.js';
import { readJson, writeJson, type Clock } from '../json.js';

export const TASK_MODES = ['turn', 'assignment', 'discussion_turn', 'revision', 'review', 'team_proposal'] as const;
export type TaskMode = typeof TASK_MODES[number];
export const TASK_STATES = ['queued', 'running', 'input_required', 'pausing', 'paused', 'completed', 'partial', 'failed', 'cancelled', 'unknown'] as const;
export type TaskState = typeof TASK_STATES[number];
/** States in which a task may still act; archive waits for none of these. */
export const ACTIVE_TASK_STATES: readonly TaskState[] = ['queued', 'running', 'input_required', 'pausing', 'paused'];

export interface StudioTask {
  id: string; project_id: string; title: string; mode: TaskMode; role_key: string | null; binding_id: string | null;
  assignment_revision: number | null; source: Record<string, unknown>; mission: unknown;
  ardent: { agent_ref: string | null; task_id: string | null; session_id: string | null; event_cursor: number };
  state: TaskState; outcome: unknown; reassigned_from: string | null; created_by: string; created_at: string; updated_at: string;
}

interface TaskRow {
  id: string; project_id: string; title: string; mode: TaskMode; role_key: string | null; binding_id: string | null; assignment_revision: number | null;
  source_json: string; mission_json: string | null; ardent_agent_ref: string | null; ardent_task_id: string | null; ardent_session_id: string | null;
  ardent_event_cursor: number; state: TaskState; outcome_json: string | null; reassigned_from: string | null; created_by: string; created_at: string; updated_at: string;
}

const toTask = (row: TaskRow): StudioTask => ({
  id: row.id, project_id: row.project_id, title: row.title, mode: row.mode, role_key: row.role_key, binding_id: row.binding_id,
  assignment_revision: row.assignment_revision, source: readJson(row.source_json, {}), mission: readJson<unknown>(row.mission_json, null),
  ardent: { agent_ref: row.ardent_agent_ref, task_id: row.ardent_task_id, session_id: row.ardent_session_id, event_cursor: row.ardent_event_cursor },
  state: row.state, outcome: readJson<unknown>(row.outcome_json, null), reassigned_from: row.reassigned_from, created_by: row.created_by,
  created_at: row.created_at, updated_at: row.updated_at,
});

export class TaskRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  create(input: { projectId: string; title: string; mode: TaskMode; roleKey?: string | null; bindingId?: string | null; assignmentRevision?: number | null;
    source?: Record<string, unknown>; mission?: unknown; agentRef?: string | null; reassignedFrom?: string | null; createdBy: string }): StudioTask {
    const id = newId('task');
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO tasks (id, project_id, title, mode, role_key, binding_id, assignment_revision, source_json, mission_json, ardent_agent_ref,
      state, reassigned_from, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`).run(
      id, input.projectId, input.title, input.mode, input.roleKey ?? null, input.bindingId ?? null, input.assignmentRevision ?? null,
      writeJson(input.source ?? {}), input.mission === undefined ? null : writeJson(input.mission), input.agentRef ?? null,
      input.reassignedFrom ?? null, input.createdBy, now, now);
    return this.get(id)!;
  }

  get(id: string): StudioTask | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  }

  list(projectId: string, states?: readonly TaskState[]): StudioTask[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, id').all(projectId) as TaskRow[];
    return rows.map(toTask).filter(task => !states || states.includes(task.state));
  }

  active(projectId: string): StudioTask[] {
    return this.list(projectId, ACTIVE_TASK_STATES);
  }

  /** Record the Ardent task once it is accepted. Idempotent for the same Ardent task. */
  attachArdent(id: string, ardent: { agentRef: string; taskId: string; sessionId: string | null }): StudioTask {
    this.db.prepare('UPDATE tasks SET ardent_agent_ref = ?, ardent_task_id = ?, ardent_session_id = ?, updated_at = ? WHERE id = ? AND (ardent_task_id IS NULL OR ardent_task_id = ?)')
      .run(ardent.agentRef, ardent.taskId, ardent.sessionId, this.clock.now().toISOString(), id, ardent.taskId);
    return this.get(id)!;
  }

  byArdentTask(agentRef: string, taskId: string): StudioTask | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE ardent_agent_ref = ? AND ardent_task_id = ?').get(agentRef, taskId) as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  }

  setState(id: string, state: TaskState, outcome?: unknown): StudioTask {
    this.db.prepare('UPDATE tasks SET state = ?, outcome_json = COALESCE(?, outcome_json), updated_at = ? WHERE id = ?')
      .run(state, outcome === undefined ? null : writeJson(outcome), this.clock.now().toISOString(), id);
    return this.get(id)!;
  }

  /** Cursors only move forward, so a replayed journal page cannot rewind the follower. */
  advanceCursor(id: string, cursor: number): void {
    this.db.prepare('UPDATE tasks SET ardent_event_cursor = MAX(ardent_event_cursor, ?), updated_at = ? WHERE id = ?').run(cursor, this.clock.now().toISOString(), id);
  }
}
