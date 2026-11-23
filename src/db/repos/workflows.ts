// Workflow runs and their nodes. A run keeps the validated spec it was started with; a node keeps
// its state, its current attempt and task, and the result of the task that completed it. The
// tasks themselves are ordinary Studio tasks (tasks.workflow_*).
import { parseExecutionContext, type ExecutionContext } from '@hivemagnus/hive-common/execution';
import type { z } from 'zod';
import type { workflowNodeStateSchema, workflowRunStateSchema, workflowSourceTemplateSchema, workflowSpecSchema } from '../../shared/browser.js';
import type { Db } from '../database.js';
import { readJson, writeJson, type Clock } from '../json.js';

export type WorkflowSpec = z.output<typeof workflowSpecSchema>;
export type WorkflowRunState = z.infer<typeof workflowRunStateSchema>;
export type WorkflowNodeState = z.infer<typeof workflowNodeStateSchema>;
export type WorkflowSourceTemplate = z.infer<typeof workflowSourceTemplateSchema>;

/** Runs that can still change. */
export const ACTIVE_RUN_STATES: readonly WorkflowRunState[] = ['running', 'blocked'];

/** What a completed node keeps: its task's final reply. Artifacts are read from the task's imports. */
export interface WorkflowNodeResult { task_id: string; state: 'completed' | 'partial'; summary: string }

export interface WorkflowRun {
  id: string; project_id: string; name: string | null; spec: WorkflowSpec; spec_sha256: string; inputs: Record<string, string>;
  source_template: WorkflowSourceTemplate | null; state: WorkflowRunState; root_ref: string | null; execution: ExecutionContext | null;
  created_by: string; created_at: string; updated_at: string; finished_at: string | null;
}

export interface WorkflowNode {
  run_id: string; key: string; position: number; role: string; title: string; prompt: string; needs: string[]; required: boolean; join_rule: 'all';
  attempt: number; task_id: string | null; state: WorkflowNodeState; result: WorkflowNodeResult | null; error: string | null; updated_at: string;
}

interface RunRow {
  id: string; project_id: string; name: string | null; spec_json: string; spec_sha256: string; inputs_json: string; source_template_json: string | null;
  state: WorkflowRunState; root_ref: string | null; execution_json: string | null; created_by: string; created_at: string; updated_at: string; finished_at: string | null;
}

interface NodeRow {
  run_id: string; node_key: string; position: number; role: string; title: string; prompt: string; needs_json: string; required: number; join_rule: 'all';
  attempt: number; task_id: string | null; state: WorkflowNodeState; result_json: string | null; error: string | null; updated_at: string;
}

const toRun = (row: RunRow): WorkflowRun => ({
  id: row.id, project_id: row.project_id, name: row.name, spec: readJson<WorkflowSpec>(row.spec_json, { nodes: [], output: '' }), spec_sha256: row.spec_sha256,
  inputs: readJson<Record<string, string>>(row.inputs_json, {}), source_template: readJson<WorkflowSourceTemplate | null>(row.source_template_json, null),
  state: row.state, root_ref: row.root_ref, execution: parseExecutionContext(readJson<unknown>(row.execution_json, null)) ?? null,
  created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at, finished_at: row.finished_at,
});

const toNode = (row: NodeRow): WorkflowNode => ({
  run_id: row.run_id, key: row.node_key, position: row.position, role: row.role, title: row.title, prompt: row.prompt, needs: readJson<string[]>(row.needs_json, []),
  required: row.required === 1, join_rule: row.join_rule, attempt: row.attempt, task_id: row.task_id, state: row.state,
  result: readJson<WorkflowNodeResult | null>(row.result_json, null), error: row.error, updated_at: row.updated_at,
});

export class WorkflowRepository {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  /** Store a run and one waiting node per spec node. */
  create(input: { id: string; projectId: string; spec: WorkflowSpec; specSha256: string; inputs: Record<string, string>; sourceTemplate: WorkflowSourceTemplate | null;
    rootRef: string | null; execution: ExecutionContext | null; createdBy: string; titleOf: (node: WorkflowSpec['nodes'][number]) => string }): WorkflowRun {
    const now = this.clock.now().toISOString();
    this.db.prepare(`INSERT INTO workflow_runs (id, project_id, name, spec_json, spec_sha256, inputs_json, source_template_json, state, root_ref, execution_json,
      created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`).run(
      input.id, input.projectId, input.spec.name ?? null, writeJson(input.spec), input.specSha256, writeJson(input.inputs),
      input.sourceTemplate ? writeJson(input.sourceTemplate) : null, input.rootRef, input.execution ? writeJson(input.execution) : null, input.createdBy, now, now);
    const insert = this.db.prepare(`INSERT INTO workflow_nodes (run_id, node_key, position, role, title, prompt, needs_json, required, join_rule, state, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`);
    input.spec.nodes.forEach((node, position) => insert.run(input.id, node.key, position, node.role, input.titleOf(node), node.prompt, writeJson(node.needs),
      node.required ? 1 : 0, node.join, now));
    return this.run(input.id)!;
  }

  run(id: string): WorkflowRun | undefined {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  /** A project's runs, newest first. */
  runs(projectId: string, limit = 50): WorkflowRun[] {
    return (this.db.prepare('SELECT * FROM workflow_runs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(projectId, limit) as RunRow[]).map(toRun);
  }

  /** Runs that are running or blocked, across projects, oldest first. */
  active(): WorkflowRun[] {
    return (this.db.prepare("SELECT * FROM workflow_runs WHERE state IN ('running', 'blocked') ORDER BY created_at, id").all() as RunRow[]).map(toRun);
  }

  setRunState(id: string, state: WorkflowRunState): WorkflowRun {
    const now = this.clock.now().toISOString();
    const finished = !ACTIVE_RUN_STATES.includes(state);
    this.db.prepare('UPDATE workflow_runs SET state = ?, updated_at = ?, finished_at = CASE WHEN ? THEN COALESCE(finished_at, ?) ELSE NULL END WHERE id = ?')
      .run(state, now, finished ? 1 : 0, now, id);
    return this.run(id)!;
  }

  /** The run's nodes in spec order. */
  nodes(runId: string): WorkflowNode[] {
    return (this.db.prepare('SELECT * FROM workflow_nodes WHERE run_id = ? ORDER BY position').all(runId) as NodeRow[]).map(toNode);
  }

  node(runId: string, key: string): WorkflowNode | undefined {
    const row = this.db.prepare('SELECT * FROM workflow_nodes WHERE run_id = ? AND node_key = ?').get(runId, key) as NodeRow | undefined;
    return row ? toNode(row) : undefined;
  }

  /** The node whose current task this is. */
  nodeOfTask(taskId: string): WorkflowNode | undefined {
    const row = this.db.prepare('SELECT * FROM workflow_nodes WHERE task_id = ?').get(taskId) as NodeRow | undefined;
    return row ? toNode(row) : undefined;
  }

  updateNode(runId: string, key: string, patch: { state?: WorkflowNodeState; attempt?: number; task_id?: string | null; result?: WorkflowNodeResult | null; error?: string | null }): WorkflowNode {
    const current = this.node(runId, key);
    if (!current) throw new Error(`No workflow node ${runId}/${key}`);
    const next = { ...current, ...patch };
    this.db.prepare('UPDATE workflow_nodes SET state = ?, attempt = ?, task_id = ?, result_json = ?, error = ?, updated_at = ? WHERE run_id = ? AND node_key = ?')
      .run(next.state, next.attempt, next.task_id, next.result ? writeJson(next.result) : null, next.error, this.clock.now().toISOString(), runId, key);
    this.touch(runId);
    return this.node(runId, key)!;
  }

  private touch(runId: string): void {
    this.db.prepare('UPDATE workflow_runs SET updated_at = ? WHERE id = ?').run(this.clock.now().toISOString(), runId);
  }
}
