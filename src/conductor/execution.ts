// Execution references: how a Studio task is placed in the suite-wide causal tree (HiveCommon
// execution context v1), so its Ardent task, model attempts and provider calls can be traced back
// to the person's request. This is attribution only: nothing in Studio, Magnus or Ardent reads it
// to choose tools, memory, missions or artifacts, or to grant anything. See docs/CONDUCTOR.md.
import { childExecution, formatExecutionRef, MAX_EXECUTION_INPUTS, rootExecution, type ExecutionContext } from '@hivemagnus/hive-common/execution';
import type { StudioTask } from '../db/repos/tasks.js';

export const STUDIO_PRODUCT = 'studio';
export const ARDENT_PRODUCT = 'ardent';

const INSTANCE = /^[A-Za-z0-9._-]{1,96}$/;
const LOCAL_ID = /^[A-Za-z0-9._:/-]{1,128}$/;
/** A chain of causes (hand-offs of hand-offs) is followed at most this far when a parent has no stored context. */
const MAX_DEPTH = 32;

/** `hx1:studio:<instance>:<kind>:<id>`, or undefined when the id cannot be one. */
export function studioRef(instance: string, kind: 'request' | 'task' | 'workflow', id: string): string | undefined {
  if (!INSTANCE.test(instance) || !LOCAL_ID.test(id)) return undefined;
  try { return formatExecutionRef({ product: STUDIO_PRODUCT, instance, kind, id }); } catch { return undefined; }
}

/** The Ardent instance of a Magnus agent reference (`<node>~<profile>`): `<node>.<profile>`, as Magnus sets ARDENT_INSTANCE_REF. */
export function ardentInstance(agentRef: string): string | undefined {
  const [nodeId, profile, extra] = agentRef.split('~');
  if (extra !== undefined || !nodeId || !profile) return undefined;
  const instance = `${nodeId}.${profile}`;
  return INSTANCE.test(instance) ? instance : undefined;
}

/** `hx1:ardent:<node>.<profile>:task:<ardent task id>`, or undefined when either part is unknown. */
export function ardentTaskRef(agentRef: string | null, ardentTaskId: string | null): string | undefined {
  if (!agentRef || !ardentTaskId || !LOCAL_ID.test(ardentTaskId)) return undefined;
  const instance = ardentInstance(agentRef);
  if (!instance) return undefined;
  try { return formatExecutionRef({ product: ARDENT_PRODUCT, instance, kind: 'task', id: ardentTaskId }); } catch { return undefined; }
}

/** What the mapping reads besides the task itself. */
export interface ExecutionLookup {
  task(id: string): StudioTask | undefined;
  /** The other turns of a discussion conversation. */
  discussionTurns(conversationId: string): StudioTask[];
  /**
   * A workflow node task's run context (the run's root) and its causal inputs: the tasks of the
   * nodes it needs. Undefined when the run is unknown.
   */
  workflow?(task: StudioTask): { run: ExecutionContext; inputs: string[] } | undefined;
}

export interface ExecutionOptions {
  instance: string;
  lookup: ExecutionLookup;
  /** The request ID where the tree starts (the person's HTTP request), when the task starts a tree. */
  requestId?: string | undefined;
}

export type CauseKind = 'reassign' | 'handoff' | 'discussion';

/** The Studio task that caused this one, and how, or undefined when a request or group started it. */
export function causeOf(task: StudioTask, lookup: ExecutionLookup): { kind: CauseKind; task: StudioTask } | undefined {
  if (task.reassigned_from) {
    const from = lookup.task(task.reassigned_from);
    if (from) return { kind: 'reassign', task: from };
  }
  if (typeof task.source.from_task === 'string') {
    const from = lookup.task(task.source.from_task);
    if (from) return { kind: 'handoff', task: from };
  }
  if (task.mode === 'discussion_turn' && task.conversation_id) {
    const previous = previousDiscussionTurn(task, lookup.discussionTurns(task.conversation_id));
    if (previous) return { kind: 'discussion', task: previous };
  }
  return undefined;
}

/** Order of a discussion turn: by round (the summary last), then position in the round. */
const turnOrder = (task: StudioTask): [number, number, string] => [
  task.source.summary === true ? Number.MAX_SAFE_INTEGER : typeof task.source.round === 'number' ? task.source.round : 0, task.group_position, task.created_at,
];

/** The discussion turn just before this one: earlier in its round, or the last turn of the previous round. */
export function previousDiscussionTurn(task: StudioTask, turns: readonly StudioTask[]): StudioTask | undefined {
  const compare = (a: StudioTask, b: StudioTask) => {
    const [ra, pa, ca] = turnOrder(a);
    const [rb, pb, cb] = turnOrder(b);
    return ra - rb || pa - pb || ca.localeCompare(cb) || a.id.localeCompare(b.id);
  };
  const ordered = turns.filter(item => item.mode === 'discussion_turn').sort(compare);
  const index = ordered.findIndex(item => item.id === task.id);
  return index > 0 ? ordered[index - 1] : undefined;
}

/**
 * The root a task starts when nothing in Studio caused it: the person's request (the trigger
 * message), else its group (a discussion, a team proposal, an ordering group), else the task itself.
 */
function rootRefOf(task: StudioTask, instance: string): string | undefined {
  if (task.trigger_message_id) return studioRef(instance, 'request', task.trigger_message_id);
  if (task.mode === 'discussion_turn' && typeof task.source.discussion === 'string') return studioRef(instance, 'request', task.source.discussion);
  if (typeof task.source.proposal_id === 'string') return studioRef(instance, 'request', task.source.proposal_id);
  if (task.group_id) return studioRef(instance, 'request', task.group_id);
  return undefined;
}

/** `attempt`: the team proposal's attempt, otherwise the assignment (team) revision the task runs under. */
function attemptOf(task: StudioTask): number | undefined {
  const value = task.mode === 'team_proposal' ? task.source.attempt : task.assignment_revision;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/**
 * The execution context of a Studio task:
 *
 * | Relationship | Context |
 * |---|---|
 * | Request (trigger message) or group | root `hx1:studio:<inst>:request:<message or group id>`, parent = the root |
 * | Task | self `hx1:studio:<inst>:task:<task id>` |
 * | Hand-off | parent = the source task; `inputs` = the source's Ardent task when known |
 * | Reassign | parent = the reassigned-from task |
 * | Discussion turn | parent = the previous turn |
 * | Assignment revision | `attempt` = the team revision (a team proposal: its attempt) |
 * | Workflow node | parent = the run `hx1:studio:<inst>:workflow:<run id>` (also the root); `inputs` = the needed nodes' tasks; `attempt` = the node attempt |
 *
 * A caused task keeps its cause's root and request ID. A cause's deadline is not inherited: a
 * hand-off is new work with its own deadline, set when it is submitted.
 */
export function taskExecution(task: StudioTask, options: ExecutionOptions, depth = 0): ExecutionContext | undefined {
  const self = studioRef(options.instance, 'task', task.id);
  if (!self) return undefined;
  if (task.workflow) {
    const workflow = options.lookup.workflow?.(task);
    if (workflow) {
      const inputs = workflow.inputs.flatMap(id => studioRef(options.instance, 'task', id) ?? []).slice(0, MAX_EXECUTION_INPUTS);
      const { deadline_ms: _deadline, ...run } = workflow.run;
      return childExecution(run, self, { attempt: task.workflow.attempt, ...(inputs.length ? { inputs } : {}) });
    }
  }
  const attempt = attemptOf(task);
  const cause = depth < MAX_DEPTH ? causeOf(task, options.lookup) : undefined;
  if (cause) {
    const parent = cause.task.execution ?? taskExecution(cause.task, options, depth + 1);
    if (parent) {
      const { deadline_ms: _deadline, ...withoutDeadline } = parent;
      const input = cause.kind === 'handoff' ? ardentTaskRef(cause.task.ardent.agent_ref, cause.task.ardent.task_id) : undefined;
      return childExecution(withoutDeadline, self, { ...(attempt !== undefined ? { attempt } : {}), ...(input ? { inputs: [input] } : {}) });
    }
  }
  const root = rootRefOf(task, options.instance);
  const requestId = options.requestId !== undefined ? { requestId: options.requestId } : {};
  const at = attempt !== undefined ? { attempt } : {};
  return root ? childExecution(rootExecution(root, requestId), self, at) : rootExecution(self, { ...requestId, ...at });
}

/** The context a submission carries: the task's context with the mission deadline, when it has one. */
export function submissionExecution(execution: ExecutionContext, deadlineMs: number | null): ExecutionContext {
  return deadlineMs === null ? execution : { ...execution, deadline_ms: deadlineMs };
}
