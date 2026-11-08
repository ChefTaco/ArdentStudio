// The conductor: one worker inside ArdentStudio that starts agent turns through Magnus, follows
// them, relays live reply text, writes the final messages and enforces team rules on what
// agents request. It never runs model work, and everything it records comes from a person's
// request or a real Ardent record. See docs/CONDUCTOR.md.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isAvailable, type AgentDirectory } from '../agents/directory.js';
import { ARDENT_STUDIO_CAPABILITY, MagnusError, parseAgentRef, type ArdentTaskEvent, type MagnusClient } from '../clients/magnus.js';
import { ServiceTokenError } from '../clients/service-token.js';
import type { BlobStore } from '../blobs/store.js';
import { hivememProjectId, type Project } from '../db/repos/projects.js';
import type { Conversation, Discussion, Message, MessageAuthor } from '../db/repos/room.js';
import { sessionKey, type SessionContext } from '../db/repos/sessions.js';
import { TERMINAL_TASK_STATES, type StudioTask, type TaskState } from '../db/repos/tasks.js';
import type { TeamRevision } from '../db/repos/team.js';
import type { Store } from '../db/store.js';
import type { Logger } from '../logger.js';
import { ARDENT_FINISHED, TaskFollower, type DoneRecord, type FollowerOptions } from './follower.js';
import type { LiveText } from './live.js';
import { buildMission, composeTurn, HANDOFF_EDGES, type AttachmentText, type TeamRole } from './prompting.js';

export type ConductorMagnus = Pick<MagnusClient, 'getInstallation' | 'openSession' | 'submitTask' | 'submitMission' | 'streamTask' | 'taskEvents' | 'task'
  | 'cancelTask' | 'pauseTask' | 'resumeTask'>;

export interface ConductorOptions {
  store: Store;
  blobs: BlobStore;
  magnus: ConductorMagnus;
  agents: Pick<AgentDirectory, 'profiles'>;
  live: LiveText;
  logger: Logger;
  /** Presence probe interval. Default 30 s. */
  presenceMs?: number;
  /** First retry delay for a submission Magnus could not take. Doubles per attempt. Default 1 s. */
  submitRetryMs?: number;
  maxSubmitAttempts?: number;
  capabilityCacheMs?: number;
  follower?: FollowerOptions;
}

/** Hooks later features attach to journal events (the artifact importer). Called inside the event's transaction. */
export type JournalHook = (task: StudioTask, event: ArdentTaskEvent) => void;

export class ConductorError extends Error {
  override name = 'ConductorError';
  constructor(message: string, readonly status: 404 | 409 | 502 | 503, readonly code: string) { super(message); }
}

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
  if (error instanceof MagnusError) return error.status >= 500 || error.status === 429 || error.status === 408;
  return !(error instanceof z.ZodError);
}

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

const excerpt = (text: string, max = 80) => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };

interface TurnContext { project: Project; revision: TeamRevision; role: TeamRole; agentRef: string; bindingId: string }

export class Conductor {
  private readonly followers = new Map<string, TaskFollower>();
  private readonly submitting = new Set<string>();
  private readonly retryAt = new Map<string, number>();
  private readonly capabilities = new Map<string, { level: number; at: number }>();
  /** Last presence probe per agent: true reachable and running, false not. Absent until probed. */
  private readonly presence = new Map<string, boolean>();
  private readonly hooks: JournalHook[] = [];
  private pumping: Promise<void> | undefined;
  private pumpAgain = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private presenceTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly store: Store;
  private readonly magnus: ConductorMagnus;

  constructor(private readonly options: ConductorOptions) {
    this.store = options.store;
    this.magnus = options.magnus;
  }

  /** Register a journal hook (for example the artifact importer). */
  onJournalEvent(hook: JournalHook): void {
    this.hooks.push(hook);
  }

  /** Resume following every accepted task from its stored cursor, finish discussions a restart interrupted, and start dispatching. */
  start(): void {
    this.stopped = false;
    for (const task of this.store.tasks.following()) this.follow(task);
    for (const conversation of this.runningDiscussions()) this.advanceDiscussion(conversation.id);
    this.kick();
    void this.probe();
    this.presenceTimer = setInterval(() => { void this.probe(); }, this.options.presenceMs ?? 30_000);
    this.presenceTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await Promise.all([...this.followers.values()].map(follower => follower.stop()));
    this.followers.clear();
    await this.pumping;
  }

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
    for (const task of this.store.tasks.unsubmitted()) {
      if (this.submitting.has(task.id) || (this.retryAt.get(task.id) ?? 0) > now) continue;
      const project = this.store.projects.get(task.project_id);
      if (!project || project.status !== 'active') continue;
      const conversation = task.conversation_id ? this.store.room.conversation(task.conversation_id) : undefined;
      if (conversation?.stopped_at) { this.cancelLocally(task, 'The conversation was stopped before this turn started.'); continue; }
      const ahead = this.store.tasks.groupBefore(task).filter(item => !FINISHED.includes(item.state));
      if (ahead.length) { this.refreshActivity(task.project_id, task.binding_id); continue; }
      ready.push(task);
    }
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

  /** Studio level and whether the agent runs an Ardent with missions. Cached briefly. */
  private async capability(agentRef: string): Promise<{ level: number; missions: boolean }> {
    const { nodeId, profile } = parseAgentRef(agentRef);
    const cached = this.capabilities.get(nodeId);
    let level: number;
    if (cached && Date.now() - cached.at < (this.options.capabilityCacheMs ?? 60_000)) level = cached.level;
    else {
      level = (await this.magnus.getInstallation(nodeId)).capabilities?.studio ?? 0;
      this.capabilities.set(nodeId, { level, at: Date.now() });
    }
    let missions = level >= ARDENT_STUDIO_CAPABILITY.missions;
    if (missions) {
      const profiles = await this.options.agents.profiles().catch(() => undefined);
      const found = profiles?.find(item => item.nodeId === nodeId && item.id === profile);
      missions = Boolean(found && versionAtLeast(found.installationVersion, [2, 2, 0]));
    }
    return { level, missions };
  }

  private async submit(task: StudioTask): Promise<void> {
    this.submitting.add(task.id);
    try {
      const resolved = this.resolve(task);
      if (typeof resolved === 'string') { this.failTask(task, resolved); return; }
      const { project, revision, role, agentRef } = resolved;
      const { level, missions } = await this.capability(agentRef);
      const dispatch = missions ? 'mission' : 'turn';
      const conversationId = task.conversation_id ?? this.ensureTeamConversation(project.id, 'conductor').id;
      const context: SessionContext = missions ? 'mission' : 'direct';
      let session = level >= ARDENT_STUDIO_CAPABILITY.bridge ? this.store.sessions.get(conversationId, role.key, agentRef, context) : undefined;
      if (level >= ARDENT_STUDIO_CAPABILITY.bridge && !session) {
        const key = sessionKey(project.id, conversationId, role.key);
        const opened = await this.magnus.openSession(agentRef, missions ? { key, context } : { key });
        session = this.store.sessions.save({ conversationId, roleKey: role.key, agentRef, context, projectId: project.id, sessionKey: key, sessionId: opened.id });
      }
      const turn = this.compose(task, resolved, conversationId, session?.last_seen_seq ?? 0, !session || session.turns === 0);
      let admission: { task_id: string; state: string };
      let mission: unknown;
      if (missions) {
        mission = buildMission({ task, project, team: revision.body, role, hivememProjectId: hivememProjectId(project.id), now: new Date() });
        admission = await this.magnus.submitMission(agentRef, {
          ...(session ? { session_id: session.session_id } : {}), objective: turn.composed.objective, mission: mission as never,
          ...(turn.composed.contextItems.length ? { context_items: turn.composed.contextItems } : {}),
          labels: { 'studio.project': project.id, 'studio.task': task.id, 'studio.conversation': conversationId, 'studio.role': role.key },
          idempotency_key: task.id,
        });
      } else {
        admission = await this.magnus.submitTask(agentRef, { prompt: turn.composed.prompt, idempotency_key: ardentIdempotencyKey(task.id), ...(session ? { session_id: session.session_id } : {}) });
      }
      this.retryAt.delete(task.id);
      let accepted: StudioTask | undefined;
      this.store.tx(() => {
        const current = this.store.tasks.get(task.id)!;
        accepted = this.store.tasks.attachArdent(task.id, { agentRef, taskId: admission.task_id, sessionId: session?.session_id ?? null, dispatch, ...(mission ? { mission } : {}) });
        if (current.state === 'queued' && admission.state === 'running') accepted = this.store.tasks.setState(task.id, 'running');
        if (session) this.store.sessions.recordTurn(session, turn.seenSeq);
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
        if (attempts < (this.options.maxSubmitAttempts ?? 5)) {
          const wait = (this.options.submitRetryMs ?? 1_000) * 2 ** (attempts - 1);
          this.retryAt.set(task.id, Date.now() + wait);
          this.scheduleRetry(wait);
          this.options.logger.warn('Task submission failed; retrying', { task_id: task.id, attempts, error: errorText(error) });
          return;
        }
      }
      this.failTask(task, `Magnus could not start the turn: ${errorText(error)}`);
    } finally {
      this.submitting.delete(task.id);
    }
  }

  private scheduleRetry(ms: number): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.kick(); }, ms + 5);
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
    const composed = composeTurn({ project, team: revision.body, role, task, firstTurn, unseen, trigger, names, attachments, discussion });
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
    this.retryAt.delete(task.id);
    this.store.tx(() => {
      const current = this.store.tasks.get(task.id);
      if (!current || FINISHED.includes(current.state)) return;
      const failed = this.store.tasks.setState(task.id, 'failed', { error: reason, ardent_state: null });
      this.store.emit(task.project_id, 'task.updated', this.taskEvent(failed));
      const conversationId = task.conversation_id ?? this.store.room.teamConversation(task.project_id)?.id;
      if (conversationId) this.systemMessage(conversationId, `${this.roleName(task)}: ${task.title}. ${reason}`, { task_id: task.id }, task.trigger_message_id);
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
    }, this.options.logger, this.options.follower);
    this.followers.set(task.id, follower);
    void follower.start().finally(() => { if (this.followers.get(task.id) === follower) this.followers.delete(task.id); });
  }

  /** Live reply text: create the streaming message on the first visible text, then relay it. */
  private relay(taskId: string, step: number, text: string, mode: 'replace' | 'append'): void {
    const task = this.store.tasks.get(taskId);
    if (!task?.ardent.task_id || FINISHED.includes(task.state)) return;
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
    if (!task || event.sequence <= task.ardent.event_cursor) return false;
    let ended = false;
    let dispatch = false;
    this.store.tx(() => {
      const label = (state: string, text: string) => this.setActivity(task, state, text, { task_id: task.id, ardent_event_seq: event.sequence, kind: event.kind });
      switch (event.kind) {
        case 'state': {
          const to = stateSchema.safeParse(event.detail).data?.to;
          if (to === 'running' && (task.state === 'queued')) {
            this.store.emit(task.project_id, 'task.updated', this.taskEvent(this.store.tasks.setState(task.id, 'running')));
            label(task.mode === 'review' ? 'reviewing' : 'working', `${task.mode === 'review' ? 'Reviewing' : 'Working'}: ${task.title}`);
          }
          if (to === 'input_required') ended = true;
          break;
        }
        case 'model_started':
          if (task.state === 'running' || task.state === 'queued') label(task.mode === 'review' ? 'reviewing' : 'working', `${task.mode === 'review' ? 'Reviewing' : 'Working'}: ${task.title}`);
          break;
        case 'tool_attempt': {
          const tool = toolSchema.safeParse(event.detail).data?.name;
          if (tool && (task.state === 'running' || task.state === 'queued')) label('working', `Working: ${task.title} · ${tool}`);
          break;
        }
        case 'team_handoff': dispatch = this.handoff(task, event); break;
        case 'team_ask_user': this.clarification(task, event); break;
        case 'team_propose_decision': this.proposal(task, event); break;
        case 'pause_requested':
          if (!FINISHED.includes(task.state)) {
            this.store.emit(task.project_id, 'task.updated', this.taskEvent(this.store.tasks.setState(task.id, 'pausing')));
            label('paused', `Pause requested: ${task.title}`);
          }
          break;
        case 'paused':
          if (!FINISHED.includes(task.state)) {
            this.store.emit(task.project_id, 'task.updated', this.taskEvent(this.store.tasks.setState(task.id, 'paused')));
            label('paused', `Paused: ${task.title}`);
          }
          break;
        case 'resumed':
          if (!FINISHED.includes(task.state)) {
            this.store.emit(task.project_id, 'task.updated', this.taskEvent(this.store.tasks.setState(task.id, 'running')));
            label('working', `Working: ${task.title}`);
          }
          break;
        default: break;
      }
      for (const hook of this.hooks) hook(task, event);
      this.store.tasks.advanceCursor(task.id, event.sequence);
    });
    if (dispatch) this.kick();
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
    const created = this.store.tasks.create({
      projectId: task.project_id, title: excerpt(request.data.objective, 200), mode: 'assignment', roleKey: target.key,
      bindingId: target.binding_id ?? this.store.team.ensureBinding(target.agent_ref).id, assignmentRevision: revision.revision,
      source: { handoff_from: task.role_key, from_task: task.id, ardent_event_seq: event.sequence, relationship: edge.type },
      createdBy: 'conductor', conversationId, instructionsMd: instructions,
    });
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
    this.setActivity(task, 'asking', `Asking: ${excerpt(asked.data.question)}`, { task_id: task.id, ardent_event_seq: event.sequence, kind: event.kind });
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
    // The stream may end before every journal event was sent: read the rest first.
    if (task.ardent.agent_ref) {
      const rest = await this.magnus.taskEvents(task.ardent.agent_ref, task.ardent.task_id, task.ardent.event_cursor).catch(() => []);
      for (const event of rest) await this.journal(taskId, event);
    }
    this.complete(taskId, record);
  }

  /** Exposed for routes that receive a final task record directly (cancel). */
  complete(taskId: string, record: DoneRecord): void {
    const task = this.store.tasks.get(taskId);
    if (!task || !task.ardent.task_id || FINISHED.includes(task.state)) return;
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
    const reply = (teamResult?.summary ?? result ?? '').trim();
    const error = typeof record.error === 'string' && record.error ? record.error.slice(0, 2000) : null;
    let finishedMessage: Message | undefined;
    this.store.tx(() => {
      const current = this.store.tasks.get(taskId)!;
      if (FINISHED.includes(current.state)) return;
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
      this.refreshActivity(task.project_id, task.binding_id);
    });
    const live = finishedMessage ?? this.store.room.messageForArdentTask(task.ardent.task_id);
    if (live) this.options.live.clear(live.id);
    this.afterFinish(task);
  }

  private afterFinish(task: StudioTask): void {
    if (task.mode === 'discussion_turn' && task.conversation_id) this.advanceDiscussion(task.conversation_id);
    this.kick();
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
      const task = this.store.tasks.create({
        projectId: input.project.id, title: excerpt(input.message.body_md || 'Reply', 120), mode: input.mode ?? 'turn', roleKey: role.key,
        bindingId: role.binding_id ?? (role.agent_ref ? this.store.team.ensureBinding(role.agent_ref).id : null), assignmentRevision: input.revision.revision,
        source: { message_id: input.message.id, ...input.source }, createdBy: input.createdBy, conversationId: input.conversation.id,
        triggerMessageId: input.message.id, groupId: input.roles.length > 1 ? groupId : null, groupPosition: position,
      });
      this.store.emit(input.project.id, 'task.created', this.taskEvent(task));
      this.refreshActivity(input.project.id, task.binding_id);
      return task;
    });
  }

  /** Queue one task (an assignment, follow-up or answer). Call inside a transaction. */
  queueTask(input: Parameters<Store['tasks']['create']>[0]): StudioTask {
    const task = this.store.tasks.create(input);
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
        this.setActivity(held, 'paused', `Paused: ${task.title}`, { task_id: task.id, kind: 'held' });
        return held;
      });
    }
    await this.magnusCall(() => this.magnus.pauseTask(task.ardent.agent_ref!, task.ardent.task_id!));
    return this.store.tx(() => {
      const current = this.store.tasks.get(task.id)!;
      if (current.state === 'paused' || FINISHED.includes(current.state)) return current;
      const pausing = this.store.tasks.setState(task.id, 'pausing');
      this.store.emit(task.project_id, 'task.updated', this.taskEvent(pausing));
      this.setActivity(pausing, 'paused', `Pause requested: ${task.title}`, { task_id: task.id, kind: 'pause_requested' });
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
      if (error instanceof MagnusError) {
        if (error.code === 'AGENT_UPGRADE_REQUIRED') throw new ConductorError(error.message, 409, 'AGENT_UPGRADE_REQUIRED');
        if (error.status === 409) throw new ConductorError(`Ardent refused: ${error.message}`, 409, 'ARDENT_CONFLICT');
        if (error.status === 404) throw new ConductorError('Ardent has no record of this task', 404, 'ARDENT_TASK_NOT_FOUND');
      }
      throw new ConductorError(`Magnus could not reach the agent: ${errorText(error)}`, 503, 'MAGNUS_UNAVAILABLE');
    }
  }

  // ── Presence and activity ──

  /** Probe agent status every 30 s. The probe only ever sets Available or Offline. */
  async probe(): Promise<void> {
    if (this.stopped) return;
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
          const available = Boolean(profile && isAvailable(profile));
          this.presence.set(role.agent_ref, available);
          const bindingId = role.binding_id ?? this.store.team.ensureBinding(role.agent_ref).id;
          if (!available) {
            this.writeActivity(project.id, bindingId, role.agent_ref, 'offline', profiles ? 'Offline' : 'Offline: Magnus is unreachable', { kind: 'presence' });
          } else {
            this.refreshActivity(project.id, bindingId);
          }
        }
      });
    }
  }

  /** Derive a binding's activity from its real tasks and the last probe. */
  private refreshActivity(projectId: string, bindingId: string | null): void {
    if (!bindingId) return;
    const binding = this.store.db.prepare('SELECT agent_ref FROM agent_bindings WHERE id = ?').get(bindingId) as { agent_ref: string } | undefined;
    if (!binding) return;
    const write = (state: string, label: string, source: Record<string, unknown>) => this.writeActivity(projectId, bindingId, binding.agent_ref, state, label, source);
    if (this.presence.get(binding.agent_ref) === false) { write('offline', 'Offline', { kind: 'presence' }); return; }
    const all = this.store.tasks.list(projectId, ['queued', 'running', 'pausing', 'paused', 'input_required']).filter(task => task.binding_id === bindingId);
    const pick = (state: TaskState) => all.find(task => task.state === state);
    const running = pick('running');
    if (running) {
      const current = this.store.room.activity(projectId).find(item => item.binding_id === bindingId);
      // Keep a more specific label from the journal (a tool name) for the same task.
      if (current && current.source.task_id === running.id && ['working', 'reviewing', 'asking'].includes(current.state)) return;
      write(running.mode === 'review' ? 'reviewing' : 'working', `${running.mode === 'review' ? 'Reviewing' : 'Working'}: ${running.title}`, { task_id: running.id, kind: 'task' });
      return;
    }
    const pausing = pick('pausing');
    if (pausing) { write('paused', `Pause requested: ${pausing.title}`, { task_id: pausing.id, kind: 'task' }); return; }
    const paused = pick('paused');
    if (paused) { write('paused', `Paused: ${paused.title}`, { task_id: paused.id, kind: 'task' }); return; }
    const queued = all.filter(task => task.state === 'queued');
    const accepted = queued.find(task => task.ardent.task_id);
    if (accepted) { write('queued', `Queued: ${accepted.title}`, { task_id: accepted.id, kind: 'task' }); return; }
    const waiting = queued.find(task => this.store.tasks.groupBefore(task).some(item => !FINISHED.includes(item.state)));
    if (waiting && queued.length === 1) {
      const blocker = this.store.tasks.groupBefore(waiting).find(item => !FINISHED.includes(item.state))!;
      write('waiting', `Waiting for ${this.roleName(blocker)}`, { task_id: waiting.id, kind: 'group' });
      return;
    }
    if (queued[0]) { write('queued', `Queued: ${queued[0].title}`, { task_id: queued[0].id, kind: 'task' }); return; }
    const asking = pick('input_required');
    if (asking) { write('asking', `Asking: ${excerpt(asking.title)}`, { task_id: asking.id, kind: 'task' }); return; }
    if (this.presence.get(binding.agent_ref) === true) write('available', 'Available', { kind: 'presence' });
    else write('unknown', 'Status not checked yet', { kind: 'presence' });
  }

  private setActivity(task: StudioTask, state: string, label: string, source: Record<string, unknown>): void {
    if (!task.binding_id) return;
    const binding = this.store.db.prepare('SELECT agent_ref FROM agent_bindings WHERE id = ?').get(task.binding_id) as { agent_ref: string } | undefined;
    if (binding) this.writeActivity(task.project_id, task.binding_id, binding.agent_ref, state, label, source);
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

/** A task as the browser sees it (no mission JSON). */
export function publicTask(task: StudioTask) {
  return {
    id: task.id, project_id: task.project_id, title: task.title, mode: task.mode, role_key: task.role_key, binding_id: task.binding_id,
    assignment_revision: task.assignment_revision, conversation_id: task.conversation_id, trigger_message_id: task.trigger_message_id,
    instructions_md: task.instructions_md, source: task.source, state: task.state, dispatch: task.dispatch,
    ardent: { agent_ref: task.ardent.agent_ref, task_id: task.ardent.task_id, session_id: task.ardent.session_id },
    outcome: task.outcome ?? null, reassigned_from: task.reassigned_from, group_id: task.group_id, group_position: task.group_position,
    created_by: task.created_by, created_at: task.created_at, updated_at: task.updated_at, finished_at: task.finished_at,
  };
}
