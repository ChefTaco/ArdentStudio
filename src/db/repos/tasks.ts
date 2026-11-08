// The Studio task mirror. Ardent owns execution; these rows record what Studio asked for,
// under which team revision, where the reply goes, and the Ardent state last observed.
import { newId } from '../../ids.js';
import type { Db } from '../database.js';
import { readJson, writeJson, type Clock } from '../json.js';

export const TASK_MODES = ['turn', 'assignment', 'discussion_turn', 'revision', 'review', 'team_proposal'] as const;
export type TaskMode = typeof TASK_MODES[number];
export const TASK_STATES = ['queued', 'running', 'input_required', 'pausing', 'paused', 'completed', 'partial', 'failed', 'cancelled', 'unknown'] as const;
export type TaskState = typeof TASK_STATES[number];
/** States in which a task may still act; archive waits for none of these. */
export const ACTIVE_TASK_STATES: readonly TaskState[] = ['queued', 'running', 'input_required', 'pausing', 'paused'];
/** Finished states. `input_required` is finished for Ardent; Studio keeps it open until a person answers. */
export const TERMINAL_TASK_STATES: readonly TaskState[] = ['completed', 'partial', 'failed', 'cancelled', 'unknown'];
export type TaskDispatch = 'mission' | 'turn';
/** What the Ardent journal showed of a running task: the model started, and the last tool it tried. */
export interface TaskProgress { model_started: boolean; tool: string | null }

export interface StudioTask {
  id: string; project_id: string; title: string; mode: TaskMode; role_key: string | null; binding_id: string | null;
  assignment_revision: number | null; source: Record<string, unknown>; mission: unknown;
  ardent: { agent_ref: string | null; task_id: string | null; session_id: string | null; event_cursor: number };
  state: TaskState; outcome: unknown; reassigned_from: string | null; created_by: string; created_at: string; updated_at: string;
  conversation_id: string | null; trigger_message_id: string | null; instructions_md: string;
  group_id: string | null; group_position: number; dispatch: TaskDispatch | null; submit_attempts: number; finished_at: string | null;
  progress: TaskProgress;
}

interface TaskRow {
  id: string; project_id: string; title: string; mode: TaskMode; role_key: string | null; binding_id: string | null; assignment_revision: number | null;
  source_json: string; mission_json: string | null; ardent_agent_ref: string | null; ardent_task_id: string | null; ardent_session_id: string | null;
  ardent_event_cursor: number; state: TaskState; outcome_json: string | null; reassigned_from: string | null; created_by: string; created_at: string; updated_at: string;
  conversation_id: string | null; trigger_message_id: string | null; instructions_md: string; group_id: string | null; group_position: number;
  dispatch: TaskDispatch | null; submit_attempts: number; finished_at: string | null; progress_json: string | null;
}

const NO_PROGRESS: TaskProgress = { model_started: false, tool: null };

const toTask = (row: TaskRow): StudioTask => ({
  id: row.id, project_id: row.project_id, title: row.title, mode: row.mode, role_key: row.role_key, binding_id: row.binding_id,
  assignment_revision: row.assignment_revision, source: readJson(row.source_json, {}), mission: readJson<unknown>(row.mission_json, null),
  ardent: { agent_ref: row.ardent_agent_ref, task_id: row.ardent_task_id, session_id: row.ardent_session_id, event_cursor: row.ardent_event_cursor },
  state: row.state, outcome: readJson<unknown>(row.outcome_json, null), reassigned_from: row.reassigned_from, created_by: row.created_by,
  created_at: row.created_at, updated_at: row.updated_at, conversation_id: row.conversation_id, trigger_message_id: row.trigger_message_id,
  instructions_md: row.instructions_md, group_id: row.group_id, group_position: row.group_position, dispatch: row.dispatch,
  submit_attempts: row.submit_attempts, finished_at: row.finished_at, progress: { ...NO_PROGRESS, ...readJson<Partial<TaskProgress>>(row.progress_json, {}) },
});

export class TaskRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  create(input: { projectId: string; title: string; mode: TaskMode; roleKey?: string | null; bindingId?: string | null; assignmentRevision?: number | null;
    source?: Record<string, unknown>; mission?: unknown; agentRef?: string | null; reassignedFrom?: string | null; createdBy: string;
    conversationId?: string | null; triggerMessageId?: string | null; instructionsMd?: string; groupId?: string | null; groupPosition?: number; state?: 'queued' | 'paused' }): StudioTask {
    const id = newId('task');
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO tasks (id, project_id, title, mode, role_key, binding_id, assignment_revision, source_json, mission_json, ardent_agent_ref,
      state, reassigned_from, created_by, created_at, updated_at, conversation_id, trigger_message_id, instructions_md, group_id, group_position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.projectId, input.title, input.mode, input.roleKey ?? null, input.bindingId ?? null, input.assignmentRevision ?? null,
      writeJson(input.source ?? {}), input.mission === undefined ? null : writeJson(input.mission), input.agentRef ?? null,
      input.state ?? 'queued', input.reassignedFrom ?? null, input.createdBy, now, now, input.conversationId ?? null, input.triggerMessageId ?? null,
      input.instructionsMd ?? '', input.groupId ?? null, input.groupPosition ?? 0);
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

  /** Queued tasks Ardent has not accepted yet, across projects, oldest first. */
  unsubmitted(): StudioTask[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE state = 'queued' AND ardent_task_id IS NULL ORDER BY created_at, id").all() as TaskRow[]).map(toTask);
  }

  /** Tasks Ardent accepted that have not finished: the conductor follows each of them. */
  following(): StudioTask[] {
    return (this.db.prepare(`SELECT * FROM tasks WHERE ardent_task_id IS NOT NULL AND state IN ('queued', 'running', 'pausing', 'paused')
      ORDER BY created_at, id`).all() as TaskRow[]).map(toTask);
  }

  /** Tasks ahead of this one in its ordering group. */
  groupBefore(task: StudioTask): StudioTask[] {
    if (!task.group_id) return [];
    return (this.db.prepare('SELECT * FROM tasks WHERE group_id = ? AND group_position < ? ORDER BY group_position, created_at')
      .all(task.group_id, task.group_position) as TaskRow[]).map(toTask);
  }

  inGroup(groupId: string): StudioTask[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE group_id = ? ORDER BY group_position, created_at').all(groupId) as TaskRow[]).map(toTask);
  }

  inConversation(conversationId: string): StudioTask[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE conversation_id = ? ORDER BY created_at, id').all(conversationId) as TaskRow[]).map(toTask);
  }

  /** Active tasks of one agent binding in a project. */
  activeForBinding(projectId: string, bindingId: string): StudioTask[] {
    return this.list(projectId, ACTIVE_TASK_STATES).filter(task => task.binding_id === bindingId && task.state !== 'input_required');
  }

  /** Record the Ardent task once it is accepted. Idempotent for the same Ardent task. */
  attachArdent(id: string, ardent: { agentRef: string; taskId: string; sessionId: string | null; dispatch?: TaskDispatch; mission?: unknown }): StudioTask {
    this.db.prepare(`UPDATE tasks SET ardent_agent_ref = ?, ardent_task_id = ?, ardent_session_id = ?, dispatch = COALESCE(?, dispatch),
      mission_json = COALESCE(?, mission_json), updated_at = ? WHERE id = ? AND (ardent_task_id IS NULL OR ardent_task_id = ?)`)
      .run(ardent.agentRef, ardent.taskId, ardent.sessionId, ardent.dispatch ?? null, ardent.mission === undefined ? null : writeJson(ardent.mission),
        this.clock.now().toISOString(), id, ardent.taskId);
    return this.get(id)!;
  }

  byArdentTask(agentRef: string, taskId: string): StudioTask | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE ardent_agent_ref = ? AND ardent_task_id = ?').get(agentRef, taskId) as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  }

  setState(id: string, state: TaskState, outcome?: unknown): StudioTask {
    const now = this.clock.now().toISOString();
    const finished = TERMINAL_TASK_STATES.includes(state) || state === 'input_required';
    this.db.prepare('UPDATE tasks SET state = ?, outcome_json = COALESCE(?, outcome_json), finished_at = CASE WHEN ? THEN COALESCE(finished_at, ?) ELSE NULL END, updated_at = ? WHERE id = ?')
      .run(state, outcome === undefined ? null : writeJson(outcome), finished ? 1 : 0, now, now, id);
    return this.get(id)!;
  }

  /** Count a failed submission attempt; returns the new count. */
  countAttempt(id: string): number {
    return (this.db.prepare('UPDATE tasks SET submit_attempts = submit_attempts + 1, updated_at = ? WHERE id = ? RETURNING submit_attempts')
      .get(this.clock.now().toISOString(), id) as { submit_attempts: number }).submit_attempts;
  }

  /** Record what the journal showed of the task's progress. Returns the task. */
  noteProgress(id: string, progress: Partial<TaskProgress>): StudioTask {
    const current = this.get(id);
    if (!current) throw new Error(`No task ${id}`);
    this.db.prepare('UPDATE tasks SET progress_json = ?, updated_at = ? WHERE id = ?').run(writeJson({ ...current.progress, ...progress }), this.clock.now().toISOString(), id);
    return this.get(id)!;
  }

  /** Active tasks started by a hand-off from one of these tasks. */
  handedOffFrom(projectId: string, taskIds: ReadonlySet<string>): StudioTask[] {
    return this.active(projectId).filter(task => typeof task.source.from_task === 'string' && taskIds.has(task.source.from_task));
  }

  /** Cursors only move forward, so a replayed journal page cannot rewind the follower. */
  advanceCursor(id: string, cursor: number): void {
    this.db.prepare('UPDATE tasks SET ardent_event_cursor = MAX(ardent_event_cursor, ?), updated_at = ? WHERE id = ?').run(cursor, this.clock.now().toISOString(), id);
  }
}
