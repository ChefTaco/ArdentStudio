// Agent activity, derived from real records only: the status probe, Studio tasks, what the
// Ardent journal showed of them (stored as task progress), clarifications, hand-offs and
// delivered revisions. Every state an agent could be in is collected, then the one with the
// highest precedence is shown. See docs/CONDUCTOR.md#activity.
import type { z } from 'zod';
import type { DeliverableRevision } from '../db/repos/review.js';
import type { Message } from '../db/repos/room.js';
import { TERMINAL_TASK_STATES, type StudioTask } from '../db/repos/tasks.js';
import type { activityStateSchema } from '../shared/browser.js';

export type ActivityState = z.infer<typeof activityStateSchema>;

/** Highest first: when an agent has several tasks, the first state in this list wins. */
export const ACTIVITY_PRECEDENCE: readonly ActivityState[] = [
  'offline', 'paused', 'blocked', 'asking', 'reviewing', 'working', 'queued', 'waiting', 'delivering', 'available', 'unknown',
];

export interface ActivityCandidate { state: ActivityState; label: string; source: Record<string, unknown> }

/** The last status probe of an agent: running and reachable, not, or Magnus could not be asked. Absent until probed. */
export type ProbeResult = 'available' | 'offline' | 'unreachable';

export interface ActivityInput {
  probe: ProbeResult | undefined;
  /** Every task of this binding in the project, oldest first. */
  tasks: readonly StudioTask[];
  /** The first unfinished task ahead of a queued task in its ordering group. */
  blockerOf: (task: StudioTask) => StudioTask | undefined;
  /** Active tasks started by a hand-off from one of this binding's tasks. */
  handedOff: readonly StudioTask[];
  message: (id: string) => Pick<Message, 'body_md' | 'links'> | undefined;
  roleName: (task: StudioTask) => string;
  /** The newest revision this binding delivered in the project. */
  delivered: (DeliverableRevision & { deliverable_name: string }) | undefined;
  now: Date;
  deliveringMs: number;
}

export const excerpt = (text: string, max = 80) => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };

const outcomeOf = (task: StudioTask) => (task.outcome && typeof task.outcome === 'object' ? task.outcome : {}) as Record<string, unknown>;

/** The clarification a task posted that nobody has answered yet. */
function openQuestion(task: StudioTask, input: ActivityInput): string | undefined {
  const id = outcomeOf(task).clarification_message_id;
  const message = typeof id === 'string' ? input.message(id) : undefined;
  if (!message || message.links.answer_message_id) return undefined;
  return message.body_md;
}

/** Why the binding's newest task needs a person: it failed, Ardent lost track of it, or the agent reported itself blocked. */
function blockedBy(task: StudioTask, input: ActivityInput): string | undefined {
  if (!TERMINAL_TASK_STATES.includes(task.state)) return undefined;
  const outcome = outcomeOf(task);
  const error = typeof outcome.error === 'string' && outcome.error ? outcome.error : undefined;
  if (task.state === 'failed') return error ?? `${task.title} failed`;
  if (task.state === 'unknown') return error ?? `Ardent does not know how ${task.title} ended`;
  const result = outcome.team_result as { outcome?: unknown } | undefined;
  if (result?.outcome === 'blocked') {
    const reply = typeof outcome.reply_message_id === 'string' ? input.message(outcome.reply_message_id)?.body_md : undefined;
    return reply?.trim() ? reply : task.title;
  }
  return undefined;
}

function taskCandidate(task: StudioTask, input: ActivityInput): ActivityCandidate | undefined {
  const source = { task_id: task.id, kind: 'task' };
  switch (task.state) {
    case 'pausing': return { state: 'paused', label: `Pause requested: ${task.title}`, source };
    case 'paused': return { state: 'paused', label: `Paused: ${task.title}`, source };
    case 'input_required': return { state: 'asking', label: `Asking: ${excerpt(openQuestion(task, input) ?? task.title)}`, source: { ...source, kind: 'clarification' } };
    case 'running':
    case 'queued': {
      const question = openQuestion(task, input);
      if (question) return { state: 'asking', label: `Asking: ${excerpt(question)}`, source: { ...source, kind: 'clarification' } };
      const accepted = Boolean(task.ardent.task_id);
      if (task.mode === 'review' && (task.state === 'running' || task.progress.model_started)) return { state: 'reviewing', label: `Reviewing: ${task.title}`, source };
      // Working only once the journal shows the model started or a tool was tried.
      if (accepted && task.progress.model_started) {
        return { state: 'working', label: `Working: ${task.title}${task.progress.tool ? ` · ${task.progress.tool}` : ''}`, source: { ...source, kind: 'journal' } };
      }
      if (task.state === 'running') return { state: 'queued', label: `Starting: ${task.title}`, source };
      const blocker = accepted ? undefined : input.blockerOf(task);
      if (blocker) return { state: 'waiting', label: `Waiting for ${input.roleName(blocker)}`, source: { ...source, kind: 'group', waiting_for: blocker.id } };
      return { state: 'queued', label: `Queued: ${task.title}`, source };
    }
    default: return undefined;
  }
}

/** Every state the records show for one agent binding in one project. */
export function activityCandidates(input: ActivityInput): ActivityCandidate[] {
  const candidates: ActivityCandidate[] = [];
  if (input.probe === 'offline') candidates.push({ state: 'offline', label: 'Offline', source: { kind: 'presence' } });
  if (input.probe === 'unreachable') candidates.push({ state: 'offline', label: 'Offline: Magnus is unreachable', source: { kind: 'presence' } });
  for (const task of input.tasks) {
    const candidate = taskCandidate(task, input);
    if (candidate) candidates.push(candidate);
  }
  const newest = input.tasks.at(-1);
  const reason = newest ? blockedBy(newest, input) : undefined;
  if (newest && reason) candidates.push({ state: 'blocked', label: `Blocked: ${excerpt(reason, 120)}`, source: { task_id: newest.id, kind: 'outcome' } });
  for (const task of input.handedOff) {
    candidates.push({ state: 'waiting', label: `Waiting for ${input.roleName(task)}`, source: { task_id: task.id, kind: 'handoff', from_task: task.source.from_task } });
  }
  const delivered = input.delivered;
  if (delivered && input.now.getTime() - Date.parse(delivered.received_at) < input.deliveringMs) {
    candidates.push({ state: 'delivering', label: `Delivered ${delivered.deliverable_name} r${delivered.revision}`,
      source: { kind: 'artifact_registered', revision_id: delivered.id, task_id: delivered.source_task_id } });
  }
  if (input.probe === 'available') candidates.push({ state: 'available', label: 'Available', source: { kind: 'presence' } });
  candidates.push({ state: 'unknown', label: 'Status not checked yet', source: { kind: 'presence' } });
  return candidates;
}

/** The candidate with the highest precedence; among equals, the oldest task's. */
export function pickActivity(candidates: readonly ActivityCandidate[]): ActivityCandidate {
  let best: ActivityCandidate | undefined;
  for (const candidate of candidates) {
    if (!best || ACTIVITY_PRECEDENCE.indexOf(candidate.state) < ACTIVITY_PRECEDENCE.indexOf(best.state)) best = candidate;
  }
  return best!;
}

export function deriveActivity(input: ActivityInput): ActivityCandidate {
  return pickActivity(activityCandidates(input));
}
