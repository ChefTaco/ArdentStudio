// The conductor: one worker inside ArdentStudio that starts agent turns through Magnus, follows
// them, relays live reply text, writes the final messages and enforces team rules on what
// agents request. It never runs model work, and everything it records comes from a person's
// request or a real Ardent record. See docs/CONDUCTOR.md.
import { createHash } from 'node:crypto';
import { currentRequestId } from '@hivemagnus/hive-common/context';
import { HiveError } from '@hivemagnus/hive-common/errors';
import type { ExecutionContext } from '@hivemagnus/hive-common/execution';
import { backoffDelay, retryAfterFromHeaders, type RetryPolicy } from '@hivemagnus/hive-common/retry';
import { z } from 'zod';
import { isAvailable, type AgentDirectory } from '../agents/directory.js';
import {
  ARDENT_LINEAGE_CAPABILITY, ARDENT_RUNTIME_LEVELS, ARDENT_STUDIO_CAPABILITY, ARDENT_UNSUPPORTED_CAPABILITY, ardentTaskRecoverySchema, MagnusError, parseAgentRef,
  type ArdentContextItem, type ArdentProfileRuntime, type ArdentTaskEvent, type ArdentTaskRecovery, type ArdentTaskRecoveryDecision, type ArdentTeamMission, type MagnusClient,
} from '../clients/magnus.js';
import { ServiceTokenError } from '../clients/service-token.js';
import type { BlobStore } from '../blobs/store.js';
import { hivememProjectId, type Project } from '../db/repos/projects.js';
import type { Conversation, Discussion, Message, MessageAuthor } from '../db/repos/room.js';
import { sessionKey, type SessionContext } from '../db/repos/sessions.js';
import { TERMINAL_TASK_STATES, type FrozenSubmission, type StudioTask, type TaskMode, type TaskState } from '../db/repos/tasks.js';
import type { TeamRevision } from '../db/repos/team.js';
import type { Store } from '../db/store.js';
import type { Logger } from '../logger.js';
import { deriveActivity, excerpt, type ProbeResult } from './activity.js';
import { submissionExecution, taskExecution } from './execution.js';
import { ARDENT_FINISHED, TaskFollower, type DoneRecord, type FollowerOptions } from './follower.js';
import type { LiveText } from './live.js';
import { buildMission, composeTurn, HANDOFF_EDGES, type AttachmentText, type TeamRole } from './prompting.js';
import { WorkflowEngine } from './workflows.js';

export type ConductorMagnus = Pick<MagnusClient, 'getInstallation' | 'openSession' | 'prepareSubmission' | 'submitPrepared' | 'streamTask' | 'taskEvents' | 'task'
  | 'cancelTask' | 'pauseTask' | 'resumeTask' | 'runtime' | 'taskRecovery' | 'decideRecovery'>;

export interface ConductorOptions {
  store: Store;
  blobs: BlobStore;
  magnus: ConductorMagnus;
  agents: Pick<AgentDirectory, 'profiles'>;
  live: LiveText;
  logger: Logger;
  /** Presence probe interval. Default 30 s. */
  presenceMs?: number;
  /** How long an agent shows Delivering after a verified deliverable revision. Default 20 s. */
  deliveringMs?: number;
  /** Base retry delay for a submission Magnus could not take: it doubles per attempt (full jitter). Default 1 s. */
  submitRetryMs?: number;
  /** Upper bound of the submission retry delay. Default 60 s. */
  submitRetryMaxMs?: number;
  maxSubmitAttempts?: number;
  /** This Studio in qualified execution references (ARDENT_STUDIO_INSTANCE_ID). Default `local`. */
  studioInstanceId?: string;
  /** Random source for retry jitter (tests). */
  random?: () => number;
  capabilityCacheMs?: number;
  follower?: FollowerOptions;
}

/** Hooks later features attach to journal events (the artifact importer). Called inside the event's transaction. */
export type JournalHook = (task: StudioTask, event: ArdentTaskEvent) => void;
/** Extra context for a task's turn (review comments for a revision task). */
export type ContextProvider = (task: StudioTask) => Array<{ title: string; text: string; mime?: string }>;

/** What a mode handler sends: a mission objective and context items, or one prompt for task-submit. */
export interface ModeRequest { objective: string; contextItems: ArdentContextItem[]; prompt: string; mission: ArdentTeamMission }

/**
 * A task mode that does not speak in the room (a team proposal). The handler names the agent and
 * composes the request; the conductor submits and follows it like any task, then hands the final
 * reply to the handler instead of writing a room message.
 */
export interface TaskModeHandler {
  /** The agent to ask, or why the task cannot start. */
  agent(task: StudioTask): { agentRef: string } | { error: string };
  compose(task: StudioTask, input: { project: Project; dispatch: 'mission' | 'turn'; now: Date }): ModeRequest;
  /** The task's final state and reply. Called inside the transaction that records it. */
  finished(task: StudioTask, outcome: { state: TaskState; reply: string | null; error: string | null }): void;
}

interface SubmitPlan {
  agentRef: string;
  dispatch: 'mission' | 'turn';
  session: ReturnType<Store['sessions']['get']>;
  seenSeq: number;
  objective: string;
  contextItems: ArdentContextItem[];
  prompt: string;
  mission: ArdentTeamMission | undefined;
  labels: Record<string, string>;
  /** The node agent accepts `execution` in the action request (lineage >= 1). */
  lineage: boolean;
}

export class ConductorError extends Error {
  override name = 'ConductorError';
  constructor(message: string, readonly status: 404 | 409 | 422 | 502 | 503, readonly code: string, readonly details?: unknown) { super(message); }
}

/**
 * A task's recovery as Studio records and shows it: Ardent's C3 object, with `actions` limited to
 * what Studio can send (none when the profile lacks recovery >= 1), `supported` saying whether it can,
 * and when Studio observed it.
 */
export type StudioRecovery = ArdentTaskRecovery & { supported: boolean; observed_at: string };
/** Ardent journal kinds after which Studio reads the task's recovery again. */
const RECOVERY_EVENTS = new Set(['recovery_planned', 'recovery_held', 'recovery_decided', 'recovery_continued']);
/** Held tasks whose recovery is read again per presence probe (oldest first). */
const MAX_HELD_RECHECKS = 50;
/** Recovery statuses under which the task still runs (Studio shows it as recovering). */
const RECOVERING = new Set(['ready', 'reconciling', 'resumed']);

const ROOM_HISTORY = 50;
const ATTACHMENT_TEXT_LIMIT = 256 * 1024;
const TEXT_MIME = /^(text\/|application\/json$|image\/svg\+xml$)/;
const FINISHED: readonly TaskState[] = [...TERMINAL_TASK_STATES, 'input_required'];

const handoffSchema = z.object({ to_role: z.string(), objective: z.string(), deliverables: z.array(z.string()).optional(), note: z.string().optional() });
const askSchema = z.object({ question: z.string(), options: z.array(z.string()).optional() });
const proposalSchema = z.object({ title: z.string(), statement: z.string(), rationale: z.string().optional() });
const stateSchema = z.object({ to: z.string() });
const toolSchema = z.object({ name: z.string() });
const teamResultSchema = z.object({ outcome: z.string(), summary: z.string(), artifacts: z.array(z.object({ name: z.string(), sha256: z.string() }).loose()).optional() }).loose();

/** A stable UUID for a Studio task, so a retried submission is the same Ardent task. */
export function ardentIdempotencyKey(taskId: string): string {
  const hex = createHash('sha256').update(`ardentstudio:${taskId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function transient(error: unknown): boolean {
  if (error instanceof ServiceTokenError) return true;
  if (error instanceof MagnusError) {
    // Magnus runs one managed command per node at a time and refuses another with this conflict
    // before anything is admitted, so the same frozen body is safe to send again.
    if (error.status === 409 && error.code === 'RESOURCE_LEASE_CONFLICT') return true;
    return error.status >= 500 || error.status === 429 || error.status === 408;
  }
  return !(error instanceof z.ZodError);
}

/** The wait a peer asked for with Retry-After, from a Magnus or HiveCommon error. */
function retryAfterOf(error: unknown): number | undefined {
  if (error instanceof MagnusError) return error.retryAfterMs;
  if (HiveError.is(error) && error.headers) return retryAfterFromHeaders(error.headers);
  return undefined;
}

/** The longest Retry-After a submission waits for; a longer one fails the task. */
const MAX_SUBMIT_RETRY_AFTER_MS = 10 * 60_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : 'unknown error';
}

const versionAtLeast = (version: string | null, minimum: [number, number, number]) => {
  const match = version ? /^(\d+)\.(\d+)\.(\d+)/.exec(version) : null;
  if (!match) return false;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < 3; index++) if (parts[index] !== minimum[index]) return parts[index]! > minimum[index]!;
  return true;
};


interface TurnContext { project: Project; revision: TeamRevision; role: TeamRole; agentRef: string; bindingId: string }

export class Conductor {
  private readonly followers = new Map<string, TaskFollower>();
  private readonly submitting = new Set<string>();
  private readonly capabilities = new Map<string, { level: number; lineage: number; version: string | null; at: number }>();
  /** Per-profile runtime levels (recovery, lineage, artifact transfer), cached briefly. */
  private readonly runtimes = new Map<string, { value: ArdentProfileRuntime; at: number }>();
  /** Last presence probe per agent. Absent until probed. */
  private readonly presence = new Map<string, ProbeResult>();
  /** Re-derive an agent's activity when its Delivering window ends, per project and binding. */
  private readonly deliveringTimers = new Map<string, NodeJS.Timeout>();
  private readonly hooks: JournalHook[] = [];
  private readonly contextProviders: ContextProvider[] = [];
  private readonly modes = new Map<TaskMode, TaskModeHandler>();
  private pumping: Promise<void> | undefined;
  private rechecking = false;
  private pumpAgain = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryDue: number | undefined;
  private presenceTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly store: Store;
  private readonly magnus: ConductorMagnus;
  private readonly instance: string;
  /** Workflow runs: their nodes are tasks this conductor queues and follows. */
  readonly workflows: WorkflowEngine;

  constructor(private readonly options: ConductorOptions) {
    this.store = options.store;
    this.magnus = options.magnus;
    this.instance = options.studioInstanceId ?? 'local';
    this.workflows = new WorkflowEngine({ store: this.store, host: this, instance: this.instance, logger: options.logger });
    this.addContextProvider(task => this.workflows.contextFor(task));
  }

  /** Register a journal hook (for example the artifact importer). */
  onJournalEvent(hook: JournalHook): void {
    this.hooks.push(hook);
  }

  /** Register extra turn context (for example the review comments of a revision task). */
  addContextProvider(provider: ContextProvider): void {
    this.contextProviders.push(provider);
  }

  /** Handle tasks of this mode with the handler instead of the room (for example team proposals). */
  registerMode(mode: TaskMode, handler: TaskModeHandler): void {
    this.modes.set(mode, handler);
  }

  /** Resume following every accepted task from its stored cursor, finish discussions a restart interrupted, and start dispatching. */
  start(): void {
    this.stopped = false;
    for (const task of this.store.tasks.following()) this.follow(task);
    for (const conversation of this.runningDiscussions()) this.advanceDiscussion(conversation.id);
    this.workflows.recover();
    this.kick();
    // The probe also reads held tasks' recoveries again (a decision made while Studio was down).
    void this.probe();
    this.presenceTimer = setInterval(() => { void this.probe(); }, this.options.presenceMs ?? 30_000);
    this.presenceTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryDue = undefined;
    for (const timer of this.deliveringTimers.values()) clearTimeout(timer);
    this.deliveringTimers.clear();
    await Promise.all([...this.followers.values()].map(follower => follower.stop()));
    this.followers.clear();
    await this.pumping;
  }

  /** This Studio in qualified execution references. */
  get instanceId(): string { return this.instance; }

  /** Tasks the conductor currently follows (for tests and diagnostics). */
  followerOf(taskId: string): TaskFollower | undefined {
    return this.followers.get(taskId);
  }

  // ── Dispatch ──

  /** Submit every task that is ready. Safe to call often: runs are serialized. */
  kick(): void {
    if (this.stopped) return;
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined;
      if (this.pumpAgain) { this.pumpAgain = false; this.kick(); }
    });
  }

  /** Resolves when no dispatch run is in progress. */
  async settled(): Promise<void> {
    while (this.pumping) await this.pumping;
  }

  private async pump(): Promise<void> {
    const now = Date.now();
    const ready: StudioTask[] = [];
    let nextRetry: number | undefined;
    for (const task of this.store.tasks.unsubmitted()) {
      if (this.submitting.has(task.id)) continue;
      // A persisted backoff holds across restarts: the next attempt starts no earlier than submit_next_at.
      if (task.submit_next_at !== null && task.submit_next_at > now) {
        nextRetry = Math.min(nextRetry ?? task.submit_next_at, task.submit_next_at);
        continue;
      }
      const project = this.store.projects.get(task.project_id);
      if (!project || project.status !== 'active') continue;
      const conversation = task.conversation_id ? this.store.room.conversation(task.conversation_id) : undefined;
      if (conversation?.stopped_at) { this.cancelLocally(task, 'The conversation was stopped before this turn started.'); continue; }
      const ahead = this.store.tasks.groupBefore(task).filter(item => !FINISHED.includes(item.state));
      if (ahead.length) { this.refreshActivity(task.project_id, task.binding_id); continue; }
      ready.push(task);
    }
    if (nextRetry !== undefined) this.scheduleRetry(nextRetry - now);
    await Promise.all(ready.map(task => this.submit(task)));
  }

  private resolve(task: StudioTask): TurnContext | string {
    const project = this.store.projects.get(task.project_id);
    if (!project) return 'The project no longer exists.';
    const revision = task.assignment_revision ? this.store.team.revision(project.id, task.assignment_revision) : this.store.team.current(project.id);
    if (!revision) return 'The project has no published team.';
    const role = revision.body.roles.find(item => item.key === task.role_key);
    if (!role) return `Team r${revision.revision} has no role "${task.role_key ?? ''}".`;
    if (!role.agent_ref) return `${role.name} has no bound agent in team r${revision.revision}.`;
    const bindingId = role.binding_id ?? this.store.team.ensureBinding(role.agent_ref).id;
    return { project, revision, role, agentRef: role.agent_ref, bindingId };
  }

  /**
   * Studio level and whether the agent runs an Ardent with missions, both from the node's one
   * installation record (every profile on a node runs its one Ardent package). Cached briefly.
   * A failed or stale agent list never decides this, so a mission is not silently sent as a
   * plain task without its tools.
   */
  private async capability(agentRef: string): Promise<{ level: number; missions: boolean; lineage: boolean }> {
    const { nodeId } = parseAgentRef(agentRef);
    let cached = this.capabilities.get(nodeId);
    if (!cached || Date.now() - cached.at >= (this.options.capabilityCacheMs ?? 60_000)) {
      const installation = await this.magnus.getInstallation(nodeId);
      cached = { level: installation.capabilities?.studio ?? 0, lineage: installation.capabilities?.lineage ?? 0, version: installation.version, at: Date.now() };
      this.capabilities.set(nodeId, cached);
    }
    const { level, version } = cached;
    return { level, missions: level >= ARDENT_STUDIO_CAPABILITY.missions && versionAtLeast(version, [2, 2, 0]), lineage: cached.lineage >= ARDENT_LINEAGE_CAPABILITY.execution };
  }

  /** A room turn: the role's agent under the task's team revision, with an Ardent session when the node supports one. */
  private async planTurn(task: StudioTask): Promise<SubmitPlan | string> {
    const resolved = this.resolve(task);
    if (typeof resolved === 'string') return resolved;
    const { project, revision, role, agentRef } = resolved;
    const { level, missions, lineage } = await this.capability(agentRef);
    const conversationId = task.conversation_id ?? this.ensureTeamConversation(project.id, 'conductor').id;
    const context: SessionContext = missions ? 'mission' : 'direct';
    let session = level >= ARDENT_STUDIO_CAPABILITY.bridge ? this.store.sessions.get(conversationId, role.key, agentRef, context) : undefined;
    if (level >= ARDENT_STUDIO_CAPABILITY.bridge && !session) {
      const key = sessionKey(project.id, conversationId, role.key);
      const opened = await this.magnus.openSession(agentRef, missions ? { key, context } : { key });
      session = this.store.sessions.save({ conversationId, roleKey: role.key, agentRef, context, projectId: project.id, sessionKey: key, sessionId: opened.id });
    }
    const turn = this.compose(task, resolved, conversationId, session?.last_seen_seq ?? 0, !session || session.turns === 0);
    return {
      agentRef, dispatch: missions ? 'mission' : 'turn', session, seenSeq: turn.seenSeq,
      objective: turn.composed.objective, contextItems: turn.composed.contextItems, prompt: turn.composed.prompt,
      mission: missions ? buildMission({ task, project, team: revision.body, role, hivememProjectId: hivememProjectId(project.id), now: new Date() }) : undefined,
      labels: { 'studio.project': project.id, 'studio.task': task.id, 'studio.conversation': conversationId, 'studio.role': role.key }, lineage,
    };
  }

  /** A handled mode: one request without a session, composed by its handler. */
  private async planHandled(task: StudioTask, handler: TaskModeHandler): Promise<SubmitPlan | string> {
    const project = this.store.projects.get(task.project_id);
    if (!project) return 'The project no longer exists.';
    const chosen = handler.agent(task);
    if ('error' in chosen) return chosen.error;
    const { missions, lineage } = await this.capability(chosen.agentRef);
    const dispatch = missions ? 'mission' : 'turn';
    const request = handler.compose(task, { project, dispatch, now: new Date() });
    return {
      agentRef: chosen.agentRef, dispatch, session: undefined, seenSeq: 0, objective: request.objective, contextItems: request.contextItems,
      prompt: request.prompt, mission: missions ? request.mission : undefined,
      labels: { 'studio.project': project.id, 'studio.task': task.id, 'studio.mode': task.mode }, lineage,
    };
  }

  /**
   * Submit a task. The first attempt plans the turn and freezes the exact Magnus action body (mission
   * deadline and idempotency key included) in the task; every retry, also after a restart, sends that
   * frozen body unchanged, so an attempt whose answer was lost is answered with the same Ardent task
   * instead of an idempotency conflict.
   */
  private async submit(task: StudioTask): Promise<void> {
    this.submitting.add(task.id);
    let frozen = task.submit_payload;
    try {
      if (!frozen) {
        const handler = this.modes.get(task.mode);
        const plan = handler ? await this.planHandled(task, handler) : await this.planTurn(task);
        if (typeof plan === 'string') { this.failTask(task, plan); return; }
        frozen = this.freeze(task, plan);
      }
      const admission = await this.magnus.submitPrepared(frozen.agent_ref, frozen, { execution: frozen.execution ?? undefined });
      const { agent_ref: agentRef, dispatch, session } = frozen;
      const mission = frozen.action === 'mission-submit' ? (JSON.parse(frozen.request) as { body: { mission: ArdentTeamMission } }).body.mission : undefined;
      let accepted: StudioTask | undefined;
      this.store.tx(() => {
        const current = this.store.tasks.get(task.id)!;
        this.store.tasks.setSubmitNextAt(task.id, null);
        accepted = this.store.tasks.attachArdent(task.id, { agentRef, taskId: admission.task_id, sessionId: session?.session_id ?? null, dispatch, ...(mission ? { mission } : {}) });
        if (current.state === 'queued' && admission.state === 'running') accepted = this.store.tasks.setState(task.id, 'running');
        if (session) this.store.sessions.recordTurn(session, frozen!.seen_seq);
        this.store.emit(task.project_id, 'task.updated', this.taskEvent(accepted));
        this.refreshActivity(task.project_id, accepted.binding_id);
      });
      // A pause or cancel asked for while the submission was in flight applies now.
      if (accepted!.state === 'paused') void this.magnus.pauseTask(agentRef, admission.task_id).catch(error => this.options.logger.warn('Pause after admission failed', { task_id: task.id, error: errorText(error) }));
      if (accepted!.state === 'cancelled') {
        void this.magnus.cancelTask(agentRef, admission.task_id).catch(error => this.options.logger.warn('Cancel after admission failed', { task_id: task.id, error: errorText(error) }));
        return;
      }
      this.follow(accepted!);
    } catch (error) {
      if (transient(error)) {
        const attempts = this.store.tasks.countAttempt(task.id);
        const wait = backoffDelay(attempts, this.retryPolicy(), {
          retryAfterMs: retryAfterOf(error), deadlineMs: frozen?.deadline_ms ?? undefined, ...(this.options.random ? { random: this.options.random } : {}),
        });
        if (wait !== null) {
          this.store.tasks.setSubmitNextAt(task.id, Date.now() + wait);
          this.scheduleRetry(wait);
          this.options.logger.warn('Task submission failed; retrying', { task_id: task.id, attempts, retry_ms: wait, error: errorText(error) });
          return;
        }
      }
      this.failTask(task, `Magnus could not start the turn: ${errorText(error)}`);
    } finally {
      this.submitting.delete(task.id);
    }
  }

  private retryPolicy(): RetryPolicy {
    return { maxAttempts: this.options.maxSubmitAttempts ?? 5, baseMs: this.options.submitRetryMs ?? 1_000, maxMs: this.options.submitRetryMaxMs ?? 60_000,
      jitter: 'full', maxRetryAfterMs: MAX_SUBMIT_RETRY_AFTER_MS };
  }

  /** Build the first attempt's exact action body and store it with the task's execution context. */
  private freeze(task: StudioTask, plan: SubmitPlan): FrozenSubmission {
    const { agentRef, dispatch, session, mission } = plan;
    const deadlineMs = mission ? mission.deadline * 1000 : null;
    const current = this.store.tasks.get(task.id) ?? task;
    const base = current.execution ?? this.executionOf(current);
    const execution = base ? submissionExecution(base, deadlineMs) : null;
    const carried = plan.lineage && execution ? execution : undefined;
    const prepared = mission
      ? this.magnus.prepareSubmission({ action: 'mission-submit', body: {
        ...(session ? { session_id: session.session_id } : {}), objective: plan.objective, mission,
        ...(plan.contextItems.length ? { context_items: plan.contextItems } : {}),
        labels: plan.labels,
        idempotency_key: task.id,
      } }, carried)
      : this.magnus.prepareSubmission({ action: 'task-submit', body: { prompt: plan.prompt, idempotency_key: ardentIdempotencyKey(task.id), ...(session ? { session_id: session.session_id } : {}) } }, carried);
    return this.store.tx(() => {
      if (execution) this.store.tasks.setExecution(task.id, execution);
      return this.store.tasks.freezeSubmission(task.id, {
        v: 1, agent_ref: agentRef, dispatch, action: prepared.action, request: prepared.request,
        session: session ? { conversation_id: session.conversation_id, role_key: session.role_key, agent_ref: session.agent_ref, context: session.context, session_id: session.session_id } : null,
        seen_seq: plan.seenSeq, deadline_ms: deadlineMs, execution, frozen_at: this.store.clock.now().toISOString(),
      }).submit_payload!;
    });
  }

  /** The task's execution context from its Studio relationships (src/conductor/execution.ts). */
  private executionOf(task: StudioTask): ExecutionContext | undefined {
    const requestId = currentRequestId();
    return taskExecution(task, {
      instance: this.instance,
      lookup: { task: id => this.store.tasks.get(id), discussionTurns: conversationId => this.store.tasks.inConversation(conversationId), workflow: task => this.workflows.executionFor(task) },
      ...(requestId ? { requestId } : {}),
    });
  }

  /** Record a new task's execution context. Call inside the transaction that created it. */
  private stamp(task: StudioTask): StudioTask {
    const execution = this.executionOf(task);
    return execution ? this.store.tasks.setExecution(task.id, execution) : task;
  }

  /** Run the dispatcher again in `ms`, unless it already will sooner. Each run reschedules for the earliest waiting task. */
  private scheduleRetry(ms: number): void {
    if (this.stopped) return;
    const due = Date.now() + Math.max(0, ms);
    if (this.retryTimer && this.retryDue !== undefined && this.retryDue <= due) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryDue = due;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.retryDue = undefined; this.kick(); }, Math.max(0, ms) + 5);
    this.retryTimer.unref();
  }

  private compose(task: StudioTask, context: TurnContext, conversationId: string, lastSeen: number, firstTurn: boolean) {
    const { project, revision, role, bindingId } = context;
    const conversation = this.store.room.conversation(conversationId)!;
    const trigger = task.trigger_message_id ? this.store.room.message(task.trigger_message_id) : undefined;
    const roleNames = new Map(revision.body.roles.map(item => [item.key, item.name]));
    const names = {
      role: (key: string) => roleNames.get(key) ?? key,
      author: (message: Message) => message.author.kind === 'user' ? message.author.user_id
        : message.author.kind === 'agent' ? (message.author.role_key ? roleNames.get(message.author.role_key) ?? message.author.role_key : 'Agent') : 'Studio',
    };
    const own = (message: Message) => message.author.kind === 'agent' && message.author.binding_id === bindingId;
    let unseen: Message[] = [];
    let discussion: Parameters<typeof composeTurn>[0]['discussion'];
    if (conversation.kind === 'discussion' && conversation.discussion) {
      const transcript = this.store.room.recentMessages(conversation.id, ROOM_HISTORY);
      discussion = { ...conversation.discussion, summary: task.source.summary === true, transcript };
    } else {
      unseen = this.store.room.messages(conversationId, lastSeen, 500).filter(message => message.id !== trigger?.id && !own(message)).slice(-ROOM_HISTORY);
    }
    const attachments: AttachmentText[] = (trigger?.attachments ?? []).flatMap(id => {
      const file = this.store.files.get(id);
      return file ? [this.attachmentText(file)] : [];
    });
    const extra = this.contextProviders.flatMap(provider => provider(task));
    const composed = composeTurn({ project, team: revision.body, role, task, firstTurn, unseen, trigger, names, attachments, discussion, extra });
    const seen = [...unseen, ...(trigger ? [trigger] : []), ...(discussion?.transcript ?? [])].reduce((max, message) => Math.max(max, message.seq), lastSeen);
    return { composed, seenSeq: seen };
  }

  /** Text attachments are read synchronously only when small; others are named, not inlined. */
  private attachmentText(file: { name: string; mime: string; size: number; sha256: string }): AttachmentText {
    if (!TEXT_MIME.test(file.mime) || file.size > ATTACHMENT_TEXT_LIMIT) return { name: file.name, mime: file.mime, text: null };
    try {
      const text = this.options.blobs.readTextSync(file.sha256);
      return { name: file.name, mime: file.mime, text };
    } catch {
      return { name: file.name, mime: file.mime, text: null };
    }
  }

  /** A task that could not start: record why, in the task and in the room. */
  private failTask(task: StudioTask, reason: string): void {
    this.store.tx(() => {
      const current = this.store.tasks.get(task.id);
      if (!current || FINISHED.includes(current.state)) return;
      const failed = this.store.tasks.setState(task.id, 'failed', { error: reason, ardent_state: null });
      this.store.emit(task.project_id, 'task.updated', this.taskEvent(failed));
      const handler = this.modes.get(task.mode);
      const conversationId = task.conversation_id ?? this.store.room.teamConversation(task.project_id)?.id;
      if (handler) handler.finished(failed, { state: 'failed', reply: null, error: reason });
      else if (conversationId) this.systemMessage(conversationId, `${this.roleName(task)}: ${task.title}. ${reason}`, { task_id: task.id }, task.trigger_message_id);
      this.workflows.taskFinished(failed, { state: 'failed', reply: null, error: reason });
      this.refreshActivity(task.project_id, task.binding_id);
    });
    this.afterFinish(task);
  }

  private cancelLocally(task: StudioTask, reason: string): void {
    this.store.tx(() => {
      const current = this.store.tasks.get(task.id);
      if (!current || FINISHED.includes(current.state)) return;
      const cancelled = this.store.tasks.setState(task.id, 'cancelled', { error: null, ardent_state: null, note: reason });
      this.store.emit(task.project_id, 'task.updated', this.taskEvent(cancelled));
      this.modes.get(task.mode)?.finished(cancelled, { state: 'cancelled', reply: null, error: reason });
      this.workflows.taskFinished(cancelled, { state: 'cancelled', reply: null, error: reason });
      this.refreshActivity(task.project_id, task.binding_id);
    });
    this.afterFinish(task);
  }

  // ── Following ──

  private follow(task: StudioTask): void {
    if (this.stopped || this.followers.has(task.id) || !task.ardent.agent_ref || !task.ardent.task_id) return;
    const ref = task.ardent.agent_ref;
    const follower = new TaskFollower(this.magnus, ref, task.ardent.task_id, {
      cursor: () => this.store.tasks.get(task.id)?.ardent.event_cursor ?? 0,
      text: (step, text, mode) => this.relay(task.id, step, text, mode),
      event: event => this.journal(task.id, event),
      done: record => this.finish(task.id, record),
      observe: record => this.observe(task.id, record),
    }, this.options.logger, this.options.follower);
    this.followers.set(task.id, follower);
    void follower.start().finally(() => { if (this.followers.get(task.id) === follower) this.followers.delete(task.id); });
  }

  /** Live reply text: create the streaming message on the first visible text, then relay it. */
  private relay(taskId: string, step: number, text: string, mode: 'replace' | 'append'): void {
    const task = this.store.tasks.get(taskId);
    // Handled modes do not speak in the room; their reply is read when the task finishes.
    if (!task?.ardent.task_id || FINISHED.includes(task.state) || this.modes.has(task.mode)) return;
    let message = this.store.room.messageForArdentTask(task.ardent.task_id);
    if (!message) {
      if (!text) return;
      const conversationId = task.conversation_id ?? this.store.room.teamConversation(task.project_id)?.id;
      if (!conversationId) return;
      message = this.store.tx(() => {
        const created = this.store.room.addMessage({ conversationId, author: this.agentAuthor(task), kind: task.source.summary === true ? 'summary' : 'reply',
          bodyMd: '', replyTo: task.trigger_message_id, links: { task_id: task.id }, ardent: { task_id: task.ardent.task_id!, session_id: task.ardent.session_id }, state: 'streaming' });
        this.store.emit(task.project_id, 'message.created', this.messageEvent(created));
        return created;
      });
    }
    if (message.state !== 'streaming') return;
    if (mode === 'replace') this.options.live.replace(task.project_id, message.id, step, text);
    else this.options.live.append(task.project_id, message.id, step, text);
  }

  /** Handle one journal event and advance the cursor in the same transaction. True when it ends the turn. */
  private async journal(taskId: string, event: ArdentTaskEvent): Promise<boolean> {
    const task = this.store.tasks.get(taskId);
    // An event of an earlier Ardent attempt (the task moved on to a continuation) is not this task's any more.
    if (!task || event.task_id !== task.ardent.task_id || event.sequence <= task.ardent.event_cursor) return false;
    let ended = false;
    let dispatch = false;
    this.store.tx(() => {
      switch (event.kind) {
        case 'state': {
          const to = stateSchema.safeParse(event.detail).data?.to;
          if (to === 'running' && (task.state === 'queued')) {
            this.store.emit(task.project_id, 'task.updated', this.taskEvent(this.store.tasks.setState(task.id, 'running')));
          }
          if (to === 'input_required') ended = true;
          break;
        }
        case 'model_started':
          if (!FINISHED.includes(task.state)) this.store.tasks.noteProgress(task.id, { model_started: true });
          break;
        case 'tool_attempt': {
          const tool = toolSchema.safeParse(event.detail).data?.name;
          if (tool && !FINISHED.includes(task.state)) this.store.tasks.noteProgress(task.id, { model_started: true, tool });
          break;
        }
        case 'team_handoff': dispatch = this.handoff(task, event); break;
        case 'team_ask_user': this.clarification(task, event); break;
        case 'team_propose_decision': this.proposal(task, event); break;
        case 'pause_requested':
          if (!FINISHED.includes(task.state)) this.store.emit(task.project_id, 'task.updated', this.taskEvent(this.store.tasks.setState(task.id, 'pausing')));
          break;
        case 'paused':
          if (!FINISHED.includes(task.state)) this.store.emit(task.project_id, 'task.updated', this.taskEvent(this.store.tasks.setState(task.id, 'paused')));
          break;
        case 'resumed':
          if (!FINISHED.includes(task.state)) this.store.emit(task.project_id, 'task.updated', this.taskEvent(this.store.tasks.setState(task.id, 'running')));
          break;
        default: break;
      }
      for (const hook of this.hooks) hook(task, event);
      this.store.tasks.advanceCursor(task.id, event.sequence);
      this.refreshActivity(task.project_id, task.binding_id);
    });
    if (dispatch) this.kick();
    if (RECOVERY_EVENTS.has(event.kind)) await this.refreshRecovery(task.id);
    if (ended && task.ardent.agent_ref && task.ardent.task_id) {
      const record = await this.magnus.task(task.ardent.agent_ref, task.ardent.task_id).catch(() => undefined);
      if (record && (ARDENT_FINISHED as readonly string[]).includes(record.state)) { await this.finish(task.id, record); return true; }
    }
    return false;
  }

  /** An agent asked for a hand-off. Studio starts it only along a delegates_to or hands_off_to edge of the task's team revision. */
  private handoff(task: StudioTask, event: ArdentTaskEvent): boolean {
    const request = handoffSchema.safeParse(event.detail);
    const conversationId = task.conversation_id ?? this.store.room.teamConversation(task.project_id)?.id;
    if (!request.success || !conversationId) return false;
    const revision = task.assignment_revision ? this.store.team.revision(task.project_id, task.assignment_revision) : this.store.team.current(task.project_id);
    const from = this.roleName(task);
    const asked = request.data.to_role.trim();
    const target = revision?.body.roles.find(role => role.key === asked || role.name.toLowerCase() === asked.toLowerCase());
    const refuse = (why: string) => {
      this.systemMessage(conversationId, `${from} asked to hand work to ${target?.name ?? JSON.stringify(asked)} (${excerpt(request.data.objective, 120)}). ${why}`,
        { task_id: task.id, handoff: { from_role: task.role_key, to_role: target?.key ?? asked, objective: request.data.objective, allowed: false } }, task.trigger_message_id);
      return false;
    };
    if (!revision) return refuse('The project has no published team, so Studio did not start it.');
    if (!target) return refuse(`Team r${revision.revision} has no such role, so Studio did not start it.`);
    const edge = revision.body.relationships.find(item => item.from === task.role_key && item.to === target.key && HANDOFF_EDGES.includes(item.type));
    if (!edge) {
      return refuse(`Team r${revision.revision} has no delegates_to or hands_off_to relationship from ${from} to ${target.name}, so Studio did not start it. `
        + 'A person can assign the work from the Tasks drawer or change the team.');
    }
    if (!target.agent_ref) return refuse(`${target.name} has no bound agent in team r${revision.revision}, so Studio did not start it.`);
    const instructions = [request.data.objective, request.data.deliverables?.length ? `Deliverables: ${request.data.deliverables.join('; ')}` : '',
      request.data.note ? `Note from ${from}: ${request.data.note}` : ''].filter(Boolean).join('\n\n');
    const created = this.stamp(this.store.tasks.create({
      projectId: task.project_id, title: excerpt(request.data.objective, 200), mode: 'assignment', roleKey: target.key,
      bindingId: target.binding_id ?? this.store.team.ensureBinding(target.agent_ref).id, assignmentRevision: revision.revision,
      source: { handoff_from: task.role_key, from_task: task.id, ardent_event_seq: event.sequence, relationship: edge.type },
      createdBy: 'conductor', conversationId, instructionsMd: instructions,
    }));
    this.store.emit(task.project_id, 'task.created', this.taskEvent(created));
    const message = this.store.room.addMessage({ conversationId, author: this.agentAuthor(task), kind: 'handoff', addressees: [target.key],
      bodyMd: `Handed off to ${target.name}: ${request.data.objective}`, replyTo: task.trigger_message_id,
      links: { task_id: task.id, handoff: { from_role: task.role_key, to_role: target.key, task_id: created.id, relationship: edge.type, allowed: true } }, state: 'complete' });
    this.store.emit(task.project_id, 'message.created', this.messageEvent(message));
    this.refreshActivity(task.project_id, created.binding_id);
    return true;
  }

  private clarification(task: StudioTask, event: ArdentTaskEvent): void {
    const asked = askSchema.safeParse(event.detail);
    const conversationId = task.conversation_id ?? this.store.room.teamConversation(task.project_id)?.id;
    if (!asked.success || !conversationId) return;
    const message = this.store.room.addMessage({ conversationId, author: this.agentAuthor(task), kind: 'clarification', bodyMd: asked.data.question,
      replyTo: task.trigger_message_id, links: { task_id: task.id, question: asked.data.question, options: asked.data.options ?? [], answer_message_id: null }, state: 'complete' });
    this.store.emit(task.project_id, 'message.created', this.messageEvent(message));
    const outcome = (task.outcome && typeof task.outcome === 'object' ? task.outcome : {}) as Record<string, unknown>;
    this.store.tasks.setState(task.id, task.state, { ...outcome, clarification_message_id: message.id });
  }

  private proposal(task: StudioTask, event: ArdentTaskEvent): void {
    const proposal = proposalSchema.safeParse(event.detail);
    const conversationId = task.conversation_id ?? this.store.room.teamConversation(task.project_id)?.id;
    if (!proposal.success || !conversationId) return;
    // Pinning stays with a person: this is only a proposal card.
    const message = this.store.room.addMessage({ conversationId, author: this.agentAuthor(task), kind: 'decision_proposal', bodyMd: proposal.data.statement,
      replyTo: task.trigger_message_id, links: { task_id: task.id, proposal: { title: proposal.data.title, statement: proposal.data.statement, rationale: proposal.data.rationale ?? '' }, decision_id: null },
      state: 'complete' });
    this.store.emit(task.project_id, 'message.created', this.messageEvent(message));
  }

  /** The task finished in Ardent: write the final message and the task state. Idempotent on the Ardent task id. */
  private async finish(taskId: string, record: DoneRecord): Promise<void> {
    const task = this.store.tasks.get(taskId);
    if (!task || !task.ardent.task_id || FINISHED.includes(task.state)) return;
    // The record of an earlier attempt: the task already follows its continuation.
    if (record.id !== task.ardent.task_id) return;
    // The stream may end before every journal event was sent: read the rest first.
    if (task.ardent.agent_ref) {
      const rest = await this.magnus.taskEvents(task.ardent.agent_ref, task.ardent.task_id, task.ardent.event_cursor).catch(() => []);
      for (const event of rest) await this.journal(taskId, event);
    }
    const current = this.store.tasks.get(taskId);
    if (!current || current.ardent.task_id !== record.id || FINISHED.includes(current.state)) return;
    const recovery = await this.recoveryOf(current, record);
    if (recovery) {
      if (recovery.continuation_task_id && recovery.continuation_task_id !== record.id && this.continueWith(current, recovery)) return;
      // Held only where a person can decide through Studio; elsewhere the task ends unknown with its message, as before.
      if (recovery.status === 'awaiting_decision' && record.state === 'unknown' && recovery.supported) { this.hold(current, recovery, record); return; }
    }
    this.complete(taskId, record, recovery ? { recovery } : {});
  }

  /** Exposed for routes that receive a final task record directly (cancel). */
  complete(taskId: string, record: DoneRecord, options: { recovery?: StudioRecovery; held?: boolean } = {}): void {
    const task = this.store.tasks.get(taskId);
    // A task Ardent held (Studio unknown) is completed once its recovery ends without a continuation.
    const reopen = (state: TaskState) => options.held === true && state === 'unknown';
    if (!task || !task.ardent.task_id || (FINISHED.includes(task.state) && !reopen(task.state))) return;
    const result = typeof record.result === 'string' ? record.result : null;
    let teamResult: z.infer<typeof teamResultSchema> | undefined;
    if (task.dispatch === 'mission' && result) {
      try { teamResult = teamResultSchema.safeParse(JSON.parse(result)).data; } catch { teamResult = undefined; }
    }
    const outcome = (task.outcome && typeof task.outcome === 'object' ? task.outcome : {}) as Record<string, unknown>;
    const asked = typeof outcome.clarification_message_id === 'string' || teamResult?.outcome === 'input_required';
    const ardentState = record.state;
    const state: TaskState = ardentState === 'missing' ? 'unknown'
      : (ardentState === 'completed' || ardentState === 'partial') ? (asked ? 'input_required' : ardentState)
        : (['failed', 'cancelled', 'unknown', 'input_required'] as const).find(item => item === ardentState) ?? 'unknown';
    const answer = (teamResult?.summary ?? result ?? '').trim();
    // Ardent summarizes a turn that ended with team_ask_user as the question itself, which the
    // clarification card already shows: posting it again as a reply would repeat the question.
    const question = typeof outcome.clarification_message_id === 'string' ? this.store.room.message(outcome.clarification_message_id)?.body_md.trim() : undefined;
    const reply = asked && question !== undefined && answer === question ? '' : answer;
    const error = typeof record.error === 'string' && record.error ? record.error.slice(0, 2000) : null;
    const handler = this.modes.get(task.mode);
    if (handler) { this.completeHandled(task, handler, { ardentState, reply, error, outcome, ...options }); return; }
    let finishedMessage: Message | undefined;
    this.store.tx(() => {
      const current = this.store.tasks.get(taskId)!;
      if (FINISHED.includes(current.state) && !reopen(current.state)) return;
      if (options.recovery) this.settleRecovery(current, options.recovery);
      const conversationId = task.conversation_id ?? this.store.room.teamConversation(task.project_id)?.id;
      const existing = this.store.room.messageForArdentTask(task.ardent.task_id!);
      const failed = state === 'failed' || state === 'unknown' || state === 'cancelled';
      const body = reply || (state === 'cancelled' ? 'The task was cancelled.' : failed ? `The task ${state === 'failed' ? 'failed' : 'ended in an unknown state'}${error ? `: ${error}` : '.'}` : '');
      if (existing) {
        if (existing.state === 'streaming') {
          finishedMessage = this.store.room.finishMessage(existing.id, { bodyMd: body, state: failed && !reply ? 'failed' : 'complete' });
          this.store.emit(task.project_id, 'message.updated', this.messageEvent(finishedMessage));
        }
      } else if (conversationId && body) {
        finishedMessage = this.store.room.addMessage({ conversationId, author: this.agentAuthor(task), kind: task.source.summary === true ? 'summary' : 'reply', bodyMd: body,
          replyTo: task.trigger_message_id, links: { task_id: task.id }, ardent: { task_id: task.ardent.task_id!, session_id: task.ardent.session_id },
          state: failed && !reply ? 'failed' : 'complete' });
        this.store.emit(task.project_id, 'message.created', this.messageEvent(finishedMessage));
      }
      const finished = this.store.tasks.setState(taskId, state, {
        ...outcome, ardent_state: ardentState, error, reply_message_id: finishedMessage?.id ?? existing?.id ?? null,
        ...(teamResult ? { team_result: { outcome: teamResult.outcome, artifacts: teamResult.artifacts?.length ?? 0 } } : {}),
      });
      this.store.emit(task.project_id, 'task.updated', this.taskEvent(finished));
      this.workflows.taskFinished(finished, { state, reply: reply || null, error });
      this.refreshActivity(task.project_id, task.binding_id);
    });
    const live = finishedMessage ?? this.store.room.messageForArdentTask(task.ardent.task_id);
    if (live) this.options.live.clear(live.id);
    this.afterFinish(task);
  }

  /** A handled mode has no clarifications: Ardent input_required ends it as partial, and the handler reads the reply. */
  private completeHandled(task: StudioTask, handler: TaskModeHandler,
    input: { ardentState: string; reply: string; error: string | null; outcome: Record<string, unknown>; recovery?: StudioRecovery; held?: boolean }): void {
    const { ardentState } = input;
    const state: TaskState = ardentState === 'completed' || ardentState === 'partial' ? ardentState
      : ardentState === 'input_required' ? 'partial'
        : ardentState === 'failed' || ardentState === 'cancelled' ? ardentState : 'unknown';
    this.store.tx(() => {
      const current = this.store.tasks.get(task.id)!;
      if (FINISHED.includes(current.state) && !(input.held === true && current.state === 'unknown')) return;
      if (input.recovery) this.settleRecovery(current, input.recovery);
      const finished = this.store.tasks.setState(task.id, state, { ...input.outcome, ardent_state: ardentState, error: input.error });
      this.store.emit(task.project_id, 'task.updated', this.taskEvent(finished));
      handler.finished(finished, { state, reply: input.reply || null, error: input.error });
      this.workflows.taskFinished(finished, { state, reply: input.reply || null, error: input.error });
      this.refreshActivity(task.project_id, task.binding_id);
    });
    this.afterFinish(task);
  }

  private afterFinish(task: StudioTask): void {
    if (task.mode === 'discussion_turn' && task.conversation_id) this.advanceDiscussion(task.conversation_id);
    this.kick();
  }

  // ── Recovery (Ardent 3.2.0 through Magnus 3.3.0; docs/CONDUCTOR.md#recovery) ──

  /** A profile's runtime levels, cached briefly. A failed read is not cached. */
  async runtimeOf(agentRef: string): Promise<ArdentProfileRuntime> {
    const cached = this.runtimes.get(agentRef);
    if (cached && Date.now() - cached.at < (this.options.capabilityCacheMs ?? 60_000)) return cached.value;
    const value = await this.magnus.runtime(agentRef);
    this.runtimes.set(agentRef, { value, at: Date.now() });
    return value;
  }

  /** Drop a cached runtime read (an answer showed it is stale). */
  forgetRuntime(agentRef: string): void {
    this.runtimes.delete(agentRef);
  }

  /** Whether Studio can read and decide recoveries on this agent. An unreadable installation counts as no. */
  private async recoverySupported(agentRef: string): Promise<boolean> {
    try { return (await this.runtimeOf(agentRef)).recovery >= ARDENT_RUNTIME_LEVELS.recovery; } catch { return false; }
  }

  /** Ardent's recovery as Studio records it: actions only when Studio can send them. */
  private studioRecovery(recovery: ArdentTaskRecovery, supported: boolean): StudioRecovery {
    return { ...recovery, actions: supported ? recovery.actions : [], supported, observed_at: this.store.clock.now().toISOString() };
  }

  /**
   * The recovery of a finished record: the record's own (Ardent 3.2.0 task records carry it), else, for a
   * task Ardent ended unknown on a profile with recovery >= 1, read through Magnus (404: never interrupted).
   */
  private async recoveryOf(task: StudioTask, record: DoneRecord): Promise<StudioRecovery | undefined> {
    const agentRef = task.ardent.agent_ref;
    if (!agentRef) return undefined;
    const own = ardentTaskRecoverySchema.safeParse(record.recovery);
    const supported = await this.recoverySupported(agentRef);
    if (own.success) return this.studioRecovery(own.data, supported);
    if (record.state !== 'unknown' || !supported) return undefined;
    try { return this.studioRecovery(await this.magnus.taskRecovery(agentRef, record.id), true); } catch (error) {
      if (!(error instanceof MagnusError && error.status === 404)) this.options.logger.warn('Task recovery could not be read', { task_id: task.id, error: errorText(error) });
      return undefined;
    }
  }

  /** Record a recovery and announce it with task.recovery. Call inside a transaction. */
  private recordRecovery(task: StudioTask, recovery: StudioRecovery, change: 'recovering' | 'held' | 'continued' | 'resolved' | 'unsupported',
    extra: Record<string, unknown> = {}): StudioTask {
    const updated = this.store.tasks.setRecovery(task.id, recovery);
    this.store.emit(task.project_id, 'task.recovery', { task_id: task.id, change, recovery, ardent_task_id: updated.ardent.task_id, ...extra });
    return updated;
  }

  /** Record the recovery a finished task ended with; announced only when it changed. Call inside a transaction. */
  private settleRecovery(task: StudioTask, recovery: StudioRecovery): void {
    const previous = task.recovery as StudioRecovery | null;
    if (previous && previous.status === recovery.status && previous.attempt === recovery.attempt && previous.decided?.at === recovery.decided?.at) {
      this.store.tasks.setRecovery(task.id, recovery);
      return;
    }
    const unsupported = recovery.status === 'unsupported' || (recovery.status === 'awaiting_decision' && !recovery.supported);
    this.recordRecovery(task, recovery, unsupported ? 'unsupported' : 'resolved');
  }

  /** A re-read of a running task: keep its recovery (ready, reconciling, resumed) so the room shows it recovering. */
  private observe(taskId: string, record: DoneRecord): void {
    const task = this.store.tasks.get(taskId);
    if (!task || task.ardent.task_id !== record.id || FINISHED.includes(task.state)) return;
    const parsed = ardentTaskRecoverySchema.safeParse(record.recovery);
    if (!parsed.success || !RECOVERING.has(parsed.data.status)) return;
    const previous = task.recovery as StudioRecovery | null;
    if (previous && previous.status === parsed.data.status && previous.attempt === parsed.data.attempt) return;
    void this.recoverySupported(task.ardent.agent_ref!).then(supported => this.store.tx(() => {
      const current = this.store.tasks.get(taskId);
      if (!current || current.ardent.task_id !== record.id || FINISHED.includes(current.state)) return;
      const updated = this.recordRecovery(current, this.studioRecovery(parsed.data, supported), 'recovering');
      this.store.emit(current.project_id, 'task.updated', this.taskEvent(updated));
    }));
  }

  /** After a recovery journal event: read the recovery again, keep a running one, and follow a continuation. */
  private async refreshRecovery(taskId: string): Promise<void> {
    const task = this.store.tasks.get(taskId);
    if (!task?.ardent.agent_ref || !task.ardent.task_id || !await this.recoverySupported(task.ardent.agent_ref)) return;
    let recovery: StudioRecovery;
    try { recovery = this.studioRecovery(await this.magnus.taskRecovery(task.ardent.agent_ref, task.ardent.task_id), true); } catch { return; }
    if (recovery.continuation_task_id && recovery.continuation_task_id !== task.ardent.task_id) { this.continueWith(task, recovery); return; }
    if (!RECOVERING.has(recovery.status) || FINISHED.includes(task.state)) return;
    this.store.tx(() => {
      const current = this.store.tasks.get(taskId);
      if (!current || current.ardent.task_id !== task.ardent.task_id || FINISHED.includes(current.state)) return;
      const previous = current.recovery as StudioRecovery | null;
      if (previous && previous.status === recovery.status && previous.attempt === recovery.attempt) return;
      this.store.emit(current.project_id, 'task.updated', this.taskEvent(this.recordRecovery(current, recovery, 'recovering')));
    });
  }

  /**
   * Ardent holds the task for a decision: Studio shows it unknown with the recovery and its actions.
   * No reply is written: the task's one completion message comes when the work ends (in a continuation,
   * or when the recovery is resolved without one).
   */
  private hold(task: StudioTask, recovery: StudioRecovery, record: DoneRecord): void {
    const error = typeof record.error === 'string' && record.error ? record.error.slice(0, 2000) : recovery.reason.message;
    let held: StudioTask | undefined;
    this.store.tx(() => {
      const current = this.store.tasks.get(task.id);
      if (!current || FINISHED.includes(current.state)) return;
      const outcome = (current.outcome && typeof current.outcome === 'object' ? current.outcome : {}) as Record<string, unknown>;
      this.recordRecovery(current, recovery, 'held');
      held = this.store.tasks.setState(task.id, 'unknown', { ...outcome, ardent_state: 'unknown', error });
      this.store.emit(task.project_id, 'task.updated', this.taskEvent(held));
      this.workflows.taskFinished(held, { state: 'unknown', reply: null, error });
      this.refreshActivity(task.project_id, task.binding_id);
    });
    if (!held) return;
    const streaming = this.store.room.messageForArdentTask(record.id);
    if (streaming) this.options.live.clear(streaming.id);
    this.afterFinish(task);
  }

  /**
   * Follow a continuation of the same Studio task: the old Ardent id joins ardent_attempts, the
   * continuation's journal is read from sequence 0, the task runs again and a reply still streaming
   * moves to the continuation, so the task ends with one completion message. False when the
   * continuation already belongs to another Studio task.
   */
  private continueWith(task: StudioTask, recovery: StudioRecovery): boolean {
    const continuation = recovery.continuation_task_id;
    const agentRef = task.ardent.agent_ref;
    if (!continuation || !agentRef || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(continuation)) return false;
    const owner = this.store.tasks.byArdentTask(agentRef, continuation);
    if (owner && owner.id !== task.id) {
      this.options.logger.warn('A recovery continuation belongs to another task', { task_id: task.id, continuation_task_id: continuation });
      return false;
    }
    let switched: StudioTask | undefined;
    this.store.tx(() => {
      const current = this.store.tasks.get(task.id);
      if (!current?.ardent.task_id || current.ardent.task_id === continuation || current.ardent_attempts.includes(continuation)) return;
      if (['completed', 'partial', 'failed', 'cancelled'].includes(current.state)) return;
      const previous = current.ardent.task_id;
      switched = this.store.tasks.switchArdent(task.id, continuation, recovery);
      const { error: _error, ardent_state: _state, ...outcome } = (switched.outcome && typeof switched.outcome === 'object' ? switched.outcome : {}) as Record<string, unknown>;
      switched = this.store.tasks.setState(task.id, 'running', outcome);
      this.store.room.rekeyStreaming(previous, continuation);
      this.store.emit(task.project_id, 'task.recovery', { task_id: task.id, change: 'continued', recovery, ardent_task_id: continuation, previous_ardent_task_id: previous });
      this.store.emit(task.project_id, 'task.updated', this.taskEvent(switched));
      this.workflows.taskResumed(switched);
      this.refreshActivity(task.project_id, task.binding_id);
    });
    if (!switched) return this.store.tasks.get(task.id)?.ardent.task_id === continuation;
    const old = this.followers.get(task.id);
    this.followers.delete(task.id);
    if (old) void old.stop();
    this.follow(switched);
    return true;
  }

  /** A recovery that ended without a continuation (abandoned, or resolved elsewhere): the held task ends as unknown with its one message. */
  private resolveHeld(task: StudioTask, recovery: StudioRecovery): void {
    const outcome = (task.outcome && typeof task.outcome === 'object' ? task.outcome : {}) as Record<string, unknown>;
    const note = recovery.decided ? `Recovery ${recovery.decided.action === 'abandon' ? 'abandoned' : 'resolved'}${recovery.decided.note ? `: ${recovery.decided.note}` : ''}` : recovery.reason.message;
    this.complete(task.id, { id: task.ardent.task_id!, state: 'unknown', error: typeof outcome.error === 'string' ? `${outcome.error} (${note})` : note }, { recovery, held: true });
  }

  /** Apply a recovery read or decided later to a held task. */
  private applyHeld(task: StudioTask, recovery: StudioRecovery): StudioTask {
    if (recovery.continuation_task_id && recovery.continuation_task_id !== task.ardent.task_id) this.continueWith(task, recovery);
    // Only a task still held ends here, so reading a resolved recovery again never writes a second message.
    else if (recovery.status === 'resolved' && task.state === 'unknown' && (task.recovery as StudioRecovery | null)?.status === 'awaiting_decision') this.resolveHeld(task, recovery);
    else this.store.tx(() => {
      const current = this.store.tasks.get(task.id)!;
      const previous = current.recovery as StudioRecovery | null;
      if (previous && JSON.stringify({ ...previous, observed_at: null }) === JSON.stringify({ ...recovery, observed_at: null })) return;
      this.store.emit(task.project_id, 'task.updated', this.taskEvent(this.recordRecovery(current, recovery, recovery.status === 'awaiting_decision' ? 'held' : 'recovering')));
    });
    return this.store.tasks.get(task.id)!;
  }

  /** Read the recoveries of held tasks again (a decision made in Magnus, or while Studio was down). */
  async recheckHeld(): Promise<void> {
    if (this.rechecking) return;
    this.rechecking = true;
    try { await this.recheckHeldNow(); } finally { this.rechecking = false; }
  }

  private async recheckHeldNow(): Promise<void> {
    const held = this.store.tasks.held().filter(task => this.store.projects.get(task.project_id)?.status === 'active').slice(0, MAX_HELD_RECHECKS);
    for (const task of held) {
      if (this.stopped) return;
      try { await this.recovery(task); } catch (error) {
        this.options.logger.warn('Held task recovery could not be read', { task_id: task.id, error: errorText(error) });
      }
    }
  }

  /**
   * GET /tasks/{id}/recovery: the task's recovery, read again through Magnus when the profile supports
   * it (and acted on: a continuation decided elsewhere is followed), else as last recorded.
   */
  async recovery(task: StudioTask): Promise<{ task: StudioTask; recovery: StudioRecovery | null; supported: boolean; source: 'live' | 'stored'; unavailable: { code: string; message: string } | null }> {
    const stored = (task.recovery as StudioRecovery | null) ?? null;
    if (!task.ardent.agent_ref || !task.ardent.task_id) return { task, recovery: stored, supported: false, source: 'stored', unavailable: { code: 'NOT_STARTED', message: 'The task has not started in Ardent' } };
    let runtime: ArdentProfileRuntime;
    try { runtime = await this.runtimeOf(task.ardent.agent_ref); } catch (error) {
      return { task, recovery: stored, supported: false, source: 'stored', unavailable: { code: 'MAGNUS_UNAVAILABLE', message: `Magnus could not be reached: ${errorText(error)}` } };
    }
    if (runtime.recovery < ARDENT_RUNTIME_LEVELS.recovery) {
      return { task, recovery: stored ? { ...stored, actions: [], supported: false } : null, supported: false, source: 'stored', unavailable: unsupportedRecovery(runtime) };
    }
    let live: StudioRecovery;
    try { live = this.studioRecovery(await this.magnus.taskRecovery(task.ardent.agent_ref, task.ardent.task_id), true); } catch (error) {
      if (error instanceof MagnusError && error.status === 404) return { task, recovery: stored, supported: true, source: 'live', unavailable: null };
      if (error instanceof MagnusError && (error.code === ARDENT_UNSUPPORTED_CAPABILITY || error.code === 'AGENT_UPGRADE_REQUIRED')) {
        this.runtimes.delete(task.ardent.agent_ref);
        return { task, recovery: stored ? { ...stored, actions: [], supported: false } : null, supported: false, source: 'stored', unavailable: { code: 'RECOVERY_UNSUPPORTED', message: error.message } };
      }
      return { task, recovery: stored, supported: true, source: 'stored', unavailable: { code: 'MAGNUS_UNAVAILABLE', message: `Magnus could not read the recovery: ${errorText(error)}` } };
    }
    const updated = task.state === 'unknown' || live.continuation_task_id ? this.applyHeld(task, live) : task;
    return { task: updated, recovery: (updated.recovery as StudioRecovery | null) ?? live, supported: true, source: 'live', unavailable: null };
  }

  /**
   * POST /tasks/{id}/recovery: send a person's decision on a held task through Magnus (task-recovery),
   * then follow the continuation it names, or end the task when the recovery is resolved without one.
   */
  async decideRecovery(task: StudioTask, decision: ArdentTaskRecoveryDecision): Promise<{ task: StudioTask; recovery: StudioRecovery }> {
    if (!task.ardent.agent_ref || !task.ardent.task_id) throw new ConductorError('The task has not started in Ardent, so it has no recovery', 409, 'RECOVERY_UNAVAILABLE');
    if (task.state !== 'unknown') throw new ConductorError(`The task is ${task.state}; only a task Ardent holds for a decision takes one`, 409, 'RECOVERY_UNAVAILABLE');
    const agentRef = task.ardent.agent_ref;
    const runtime = await this.magnusCall(() => this.runtimeOf(agentRef));
    const unsupported = unsupportedRecovery(runtime);
    if (runtime.recovery < ARDENT_RUNTIME_LEVELS.recovery) throw new ConductorError(unsupported.message, 409, 'RECOVERY_UNSUPPORTED', unsupported.details);
    const decided = await this.magnusCall(() => this.magnus.decideRecovery(agentRef, task.ardent.task_id!, decision));
    const recovery = this.studioRecovery(decided, true);
    const updated = this.applyHeld(this.store.tasks.get(task.id)!, recovery);
    return { task: updated, recovery: (updated.recovery as StudioRecovery | null) ?? recovery };
  }

  // ── Requests from people (routes call these inside or after their transaction) ──

  /** The project's team conversation, created on first use. Call inside a transaction. */
  ensureTeamConversation(projectId: string, createdBy: string): Conversation {
    const existing = this.store.room.teamConversation(projectId);
    if (existing) return existing;
    return this.store.tx(() => {
      const created = this.store.room.createConversation({ projectId, kind: 'team', title: 'Team room', createdBy });
      this.store.emit(projectId, 'conversation.created', { conversation: created });
      return created;
    });
  }

  /**
   * Queue one turn per addressee in an ordering group, so each addressee sees the replies before
   * theirs. Call inside the transaction that stored the message.
   */
  queueTurns(input: { project: Project; revision: TeamRevision; conversation: Conversation; message: Message; roles: readonly TeamRole[]; createdBy: string; mode?: 'turn'; source?: Record<string, unknown> }): StudioTask[] {
    const groupId = `${input.message.id}:turns`;
    return input.roles.map((role, position) => {
      const task = this.stamp(this.store.tasks.create({
        projectId: input.project.id, title: excerpt(input.message.body_md || 'Reply', 120), mode: input.mode ?? 'turn', roleKey: role.key,
        bindingId: role.binding_id ?? (role.agent_ref ? this.store.team.ensureBinding(role.agent_ref).id : null), assignmentRevision: input.revision.revision,
        source: { message_id: input.message.id, ...input.source }, createdBy: input.createdBy, conversationId: input.conversation.id,
        triggerMessageId: input.message.id, groupId: input.roles.length > 1 ? groupId : null, groupPosition: position,
      }));
      this.store.emit(input.project.id, 'task.created', this.taskEvent(task));
      this.refreshActivity(input.project.id, task.binding_id);
      return task;
    });
  }

  /** Queue one task (an assignment, follow-up or answer). Call inside a transaction. */
  queueTask(input: Parameters<Store['tasks']['create']>[0]): StudioTask {
    const task = this.stamp(this.store.tasks.create(input));
    this.store.emit(input.projectId, 'task.created', this.taskEvent(task));
    this.refreshActivity(input.projectId, task.binding_id);
    return task;
  }

  /** Queue round `round` of a discussion: one turn per participant, in order. Call inside a transaction. */
  queueDiscussionRound(conversation: Conversation, revision: TeamRevision, round: number, createdBy: string): StudioTask[] {
    const discussion = conversation.discussion!;
    return discussion.participants.flatMap((key, position) => {
      const role = revision.body.roles.find(item => item.key === key);
      if (!role) return [];
      return [this.queueTask({ projectId: conversation.project_id, title: `${excerpt(discussion.question, 80)} (round ${round})`, mode: 'discussion_turn',
        roleKey: key, bindingId: role.binding_id ?? (role.agent_ref ? this.store.team.ensureBinding(role.agent_ref).id : null), assignmentRevision: revision.revision,
        source: { discussion: conversation.id, round }, createdBy, conversationId: conversation.id, groupId: `${conversation.id}:r${round}`, groupPosition: position })];
    });
  }

  /** Move a discussion on once the current round (or its summary) has finished. */
  advanceDiscussion(conversationId: string): void {
    const conversation = this.store.room.conversation(conversationId);
    const discussion = conversation?.discussion;
    if (!conversation || !discussion || conversation.stopped_at || (discussion.state !== 'running' && discussion.state !== 'summarizing')) return;
    const group = discussion.state === 'running' ? `${conversation.id}:r${discussion.round}` : `${conversation.id}:summary`;
    if (this.store.tasks.inGroup(group).some(task => !FINISHED.includes(task.state))) return;
    const revision = this.store.team.current(conversation.project_id);
    this.store.tx(() => {
      let next: Discussion;
      if (discussion.state === 'running' && discussion.round < discussion.max_rounds && revision) {
        next = { ...discussion, round: discussion.round + 1 };
        const updated = this.store.room.updateDiscussion(conversation.id, next);
        this.queueDiscussionRound(updated, revision, next.round, 'conductor');
      } else if (discussion.state === 'running') {
        const coordinator = revision?.body.roles.find(role => role.coordinator && role.agent_ref);
        if (coordinator && revision) {
          next = { ...discussion, state: 'summarizing' };
          this.store.room.updateDiscussion(conversation.id, next);
          this.queueTask({ projectId: conversation.project_id, title: `Summary: ${excerpt(discussion.question, 80)}`, mode: 'discussion_turn', roleKey: coordinator.key,
            bindingId: coordinator.binding_id ?? this.store.team.ensureBinding(coordinator.agent_ref!).id, assignmentRevision: revision.revision,
            source: { discussion: conversation.id, summary: true }, createdBy: 'conductor', conversationId: conversation.id, groupId: `${conversation.id}:summary` });
        } else {
          next = { ...discussion, state: 'done' };
          this.store.room.updateDiscussion(conversation.id, next);
          this.systemMessage(conversation.id, 'The discussion ended without a summary: the team has no bound coordinator.', {});
        }
      } else {
        next = { ...discussion, state: 'done' };
        this.store.room.updateDiscussion(conversation.id, next);
      }
      this.store.emit(conversation.project_id, 'conversation.updated', { conversation: this.store.room.conversation(conversation.id) });
    });
    this.kick();
  }

  private runningDiscussions(): Conversation[] {
    const rows = this.store.db.prepare("SELECT id FROM conversations WHERE kind = 'discussion' AND stopped_at IS NULL").all() as Array<{ id: string }>;
    return rows.map(row => this.store.room.conversation(row.id)!).filter(item => item.discussion?.state === 'running' || item.discussion?.state === 'summarizing');
  }

  /** Stop a conversation: unstarted turns are cancelled here, started ones are cancelled through Magnus. */
  async stopConversation(conversationId: string): Promise<void> {
    const tasks = this.store.tasks.inConversation(conversationId).filter(task => !FINISHED.includes(task.state));
    for (const task of tasks) {
      if (!task.ardent.task_id) this.cancelLocally(task, 'The conversation was stopped.');
      else await this.cancel(task).catch(error => this.options.logger.warn('Cancel on stop failed', { task_id: task.id, error: errorText(error) }));
    }
  }

  /** Cancel a task. An unstarted one is cancelled here; a started one through Magnus, and its final record follows. */
  async cancel(task: StudioTask): Promise<StudioTask> {
    if (FINISHED.includes(task.state)) throw new ConductorError('The task has already finished', 409, 'TASK_FINISHED');
    if (!task.ardent.task_id || !task.ardent.agent_ref) {
      this.cancelLocally(task, 'Cancelled before it started.');
      return this.store.tasks.get(task.id)!;
    }
    const record = await this.magnusCall(() => this.magnus.cancelTask(task.ardent.agent_ref!, task.ardent.task_id!));
    const parsed = z.object({ id: z.string(), state: z.string(), result: z.string().nullable().optional(), error: z.string().nullable().optional() }).loose().safeParse(record);
    if (parsed.success && (ARDENT_FINISHED as readonly string[]).includes(parsed.data.state)) await this.finish(task.id, parsed.data);
    return this.store.tasks.get(task.id)!;
  }

  /** Pause a task at its next step boundary (studio >= 2), or hold an unstarted one. */
  async pause(task: StudioTask): Promise<StudioTask> {
    if (FINISHED.includes(task.state)) throw new ConductorError('The task has already finished', 409, 'TASK_FINISHED');
    if (task.state === 'paused' || task.state === 'pausing') return task;
    if (!task.ardent.task_id || !task.ardent.agent_ref) {
      return this.store.tx(() => {
        const held = this.store.tasks.setState(task.id, 'paused', { ...(task.outcome as object | null ?? {}), held: true });
        this.store.emit(task.project_id, 'task.updated', this.taskEvent(held));
        this.refreshActivity(task.project_id, task.binding_id);
        return held;
      });
    }
    await this.magnusCall(() => this.magnus.pauseTask(task.ardent.agent_ref!, task.ardent.task_id!));
    return this.store.tx(() => {
      const current = this.store.tasks.get(task.id)!;
      if (current.state === 'paused' || FINISHED.includes(current.state)) return current;
      const pausing = this.store.tasks.setState(task.id, 'pausing');
      this.store.emit(task.project_id, 'task.updated', this.taskEvent(pausing));
      this.refreshActivity(task.project_id, task.binding_id);
      return pausing;
    });
  }

  async resume(task: StudioTask): Promise<StudioTask> {
    if (task.state !== 'paused' && task.state !== 'pausing') throw new ConductorError('The task is not paused', 409, 'TASK_NOT_PAUSED');
    if (!task.ardent.task_id || !task.ardent.agent_ref) {
      const queued = this.store.tx(() => {
        const next = this.store.tasks.setState(task.id, 'queued');
        this.store.emit(task.project_id, 'task.updated', this.taskEvent(next));
        this.refreshActivity(task.project_id, task.binding_id);
        return next;
      });
      this.kick();
      return queued;
    }
    const answer = await this.magnusCall(() => this.magnus.resumeTask(task.ardent.agent_ref!, task.ardent.task_id!));
    return this.store.tx(() => {
      const current = this.store.tasks.get(task.id)!;
      if (FINISHED.includes(current.state)) return current;
      const next = this.store.tasks.setState(task.id, answer.state === 'queued' ? 'queued' : 'running');
      this.store.emit(task.project_id, 'task.updated', this.taskEvent(next));
      this.refreshActivity(task.project_id, task.binding_id);
      return next;
    });
  }

  private async magnusCall<T>(call: () => Promise<T>): Promise<T> {
    try { return await call(); } catch (error) {
      if (error instanceof ConductorError) throw error;
      if (error instanceof MagnusError) {
        if (error.code === 'AGENT_UPGRADE_REQUIRED') throw new ConductorError(error.message, 409, 'AGENT_UPGRADE_REQUIRED');
        if (error.code === ARDENT_UNSUPPORTED_CAPABILITY) throw new ConductorError(`The agent's Ardent does not support this: ${error.message}`, 409, 'RECOVERY_UNSUPPORTED', error.details);
        if (error.status === 400 || error.status === 422) throw new ConductorError(`Ardent refused the request: ${error.message}`, 422, 'INVALID_INPUT');
        if (error.status === 409) throw new ConductorError(`Ardent refused: ${error.message}`, 409, 'ARDENT_CONFLICT');
        if (error.status === 404) throw new ConductorError('Ardent has no record of this task', 404, 'ARDENT_TASK_NOT_FOUND');
      }
      throw new ConductorError(`Magnus could not reach the agent: ${errorText(error)}`, 503, 'MAGNUS_UNAVAILABLE');
    }
  }

  // ── Presence and activity ──

  /** Probe agent status every 30 s. The probe only records reachability; activity is then derived as for any change. */
  async probe(): Promise<void> {
    if (this.stopped) return;
    void this.recheckHeld();
    let profiles: Awaited<ReturnType<ConductorOptions['agents']['profiles']>> | undefined;
    try { profiles = await this.options.agents.profiles(); } catch { profiles = undefined; }
    const byRef = new Map((profiles ?? []).map(profile => [`${profile.nodeId}~${profile.id}`, profile]));
    for (const project of this.store.projects.list({ status: 'active' })) {
      const revision = this.store.team.current(project.id);
      if (!revision) continue;
      this.store.tx(() => {
        for (const role of revision.body.roles) {
          if (!role.agent_ref) continue;
          const profile = byRef.get(role.agent_ref);
          this.presence.set(role.agent_ref, !profiles ? 'unreachable' : profile && isAvailable(profile) ? 'available' : 'offline');
          this.refreshActivity(project.id, role.binding_id ?? this.store.team.ensureBinding(role.agent_ref).id);
        }
      });
    }
  }

  /**
   * Derive a binding's activity from the last probe and its real records (docs/CONDUCTOR.md#activity),
   * and announce it when it changed. Call inside a transaction, after the records changed.
   */
  refreshActivity(projectId: string, bindingId: string | null): void {
    if (!bindingId) return;
    const binding = this.store.db.prepare('SELECT agent_ref FROM agent_bindings WHERE id = ?').get(bindingId) as { agent_ref: string } | undefined;
    if (!binding) return;
    const tasks = this.store.tasks.list(projectId).filter(task => task.binding_id === bindingId);
    const now = this.store.clock.now();
    const deliveringMs = this.options.deliveringMs ?? 20_000;
    const delivered = this.store.review.latestDeliveredBy(projectId, bindingId);
    const activity = deriveActivity({
      probe: this.presence.get(binding.agent_ref),
      tasks,
      blockerOf: task => this.store.tasks.groupBefore(task).find(item => !FINISHED.includes(item.state)),
      handedOff: this.store.tasks.handedOffFrom(projectId, new Set(tasks.map(task => task.id))).filter(task => task.binding_id !== bindingId),
      message: id => this.store.room.message(id),
      roleName: task => this.roleName(task),
      delivered, now, deliveringMs,
    });
    this.writeActivity(projectId, bindingId, binding.agent_ref, activity.state, activity.label, activity.source);
    // Delivering is transient: derive again when its window ends.
    const remaining = delivered ? Date.parse(delivered.received_at) + deliveringMs - now.getTime() : 0;
    const key = `${projectId}:${bindingId}`;
    if (remaining > 0 && !this.deliveringTimers.has(key) && !this.stopped) {
      const timer = setTimeout(() => {
        this.deliveringTimers.delete(key);
        if (!this.stopped) this.store.tx(() => this.refreshActivity(projectId, bindingId));
      }, remaining + 5);
      timer.unref();
      this.deliveringTimers.set(key, timer);
    }
  }

  private writeActivity(projectId: string, bindingId: string, agentRef: string, state: string, label: string, source: Record<string, unknown>): void {
    const since = this.store.clock.now().toISOString();
    if (this.store.room.changeActivity({ project_id: projectId, binding_id: bindingId, state, label, source, since })) {
      this.store.emit(projectId, 'presence.updated', { binding_id: bindingId, agent_ref: agentRef, state, label, source, since });
    }
  }

  // ── Shared record helpers ──

  private agentAuthor(task: StudioTask): MessageAuthor {
    return task.binding_id ? { kind: 'agent', binding_id: task.binding_id, role_key: task.role_key } : { kind: 'system' };
  }

  private roleName(task: Pick<StudioTask, 'project_id' | 'role_key' | 'assignment_revision'>): string {
    const revision = task.assignment_revision ? this.store.team.revision(task.project_id, task.assignment_revision) : this.store.team.current(task.project_id);
    return revision?.body.roles.find(role => role.key === task.role_key)?.name ?? task.role_key ?? 'An agent';
  }

  /** A Studio note in the room. Call inside a transaction. */
  systemMessage(conversationId: string, text: string, links: Record<string, unknown>, replyTo?: string | null): Message {
    const message = this.store.room.addMessage({ conversationId, author: { kind: 'system' }, kind: 'system', bodyMd: text, replyTo: replyTo ?? null, links, state: 'complete' });
    this.store.emit(message.project_id, 'message.created', this.messageEvent(message));
    return message;
  }

  messageEvent(message: Message): Record<string, unknown> {
    return { message };
  }

  taskEvent(task: StudioTask): Record<string, unknown> {
    return { task: publicTask(task) };
  }
}

/** Why Studio offers no recovery actions on a profile below recovery 1. */
function unsupportedRecovery(runtime: ArdentProfileRuntime): { code: string; message: string; details: Record<string, unknown> } {
  return { code: 'RECOVERY_UNSUPPORTED',
    message: runtime.studio < 4 ? 'The agent\'s Magnus node agent cannot relay task recovery; upgrade the Magnus agent' : 'The agent runs an Ardent without task recovery; upgrade Ardent to 3.2.0 or later',
    details: { capability: 'ardent.recovery.v1', required_level: ARDENT_RUNTIME_LEVELS.recovery, level: runtime.recovery, studio: runtime.studio, installed_version: runtime.version } };
}

/** A task as the browser sees it (no mission JSON). */
export function publicTask(task: StudioTask) {
  return {
    id: task.id, project_id: task.project_id, title: task.title, mode: task.mode, role_key: task.role_key, binding_id: task.binding_id,
    assignment_revision: task.assignment_revision, conversation_id: task.conversation_id, trigger_message_id: task.trigger_message_id,
    instructions_md: task.instructions_md, source: task.source, state: task.state, dispatch: task.dispatch,
    ardent: { agent_ref: task.ardent.agent_ref, task_id: task.ardent.task_id, session_id: task.ardent.session_id, attempts: task.ardent_attempts },
    outcome: task.outcome ?? null, reassigned_from: task.reassigned_from, group_id: task.group_id, group_position: task.group_position,
    created_by: task.created_by, created_at: task.created_at, updated_at: task.updated_at, finished_at: task.finished_at,
    execution: task.execution ? { root: task.execution.root, parent: task.execution.parent ?? null, self: task.execution.self ?? null,
      attempt: task.execution.attempt ?? null, inputs: task.execution.inputs ?? [] } : null,
    recovery: (task.recovery as StudioRecovery | null) ?? null,
  };
}
