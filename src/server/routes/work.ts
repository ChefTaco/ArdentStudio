// Decisions and the Studio task mirror. Agents only propose decisions; pinning is a person's act.
import type { z } from 'zod';
import { ConductorError, publicTask } from '../../conductor/conductor.js';
import { TERMINAL_TASK_STATES, type StudioTask } from '../../db/repos/tasks.js';
import type { Store } from '../../db/store.js';
import {
  decisionIdSchema, taskIdSchema,
  type createDecisionRequestSchema, type createTaskRequestSchema, type listTasksQuerySchema, type reassignTaskRequestSchema, type supersedeDecisionRequestSchema,
} from '../../shared/browser.js';
import { actorOf, requireActive, requireProject, type AppDeps } from '../deps.js';
import { ApiError, notFound } from '../errors.js';
import type { createRouter } from '../routing.js';
import { requireTeam } from './room.js';

function requireTask(store: Store, id: string | undefined): StudioTask {
  const parsed = taskIdSchema.safeParse(id);
  const task = parsed.success ? store.tasks.get(parsed.data) : undefined;
  if (!task) throw notFound('Task');
  return task;
}

/** Conductor refusals keep their status and code. */
function conductorError(error: unknown): never {
  if (error instanceof ConductorError) throw new ApiError(error.status, error.code, error.message);
  throw error;
}

export function workRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  const { store, conductor } = deps;

  // ── Decisions ──

  register('GET', '/projects/{projectId}/decisions', (_c, { params }) => ({ body: { decisions: store.room.decisions(requireProject(store, params.projectId).id) } }));

  register('POST', '/projects/{projectId}/decisions', (_c, { params, body, principal, idempotencyKey }) => {
    const project = requireActive(requireProject(store, params.projectId));
    const input = body as z.infer<typeof createDecisionRequestSchema>;
    const source = input.source_message_id ? store.room.message(input.source_message_id) : undefined;
    if (input.source_message_id && source?.project_id !== project.id) throw new ApiError(422, 'UNKNOWN_MESSAGE', 'source_message_id is not a message of this project');
    const actor = actorOf(principal);
    const decision = store.tx(() => {
      const created = store.room.createDecision({ projectId: project.id, title: input.title, statementMd: input.statement_md, rationaleMd: input.rationale_md,
        sources: source ? [{ kind: 'message', ref: source.id }] : [], decidedBy: actor.userId });
      store.emit(project.id, 'decision.created', { decision: created });
      if (source?.kind === 'decision_proposal') store.emit(project.id, 'message.updated', { message: store.room.updateLinks(source.id, { decision_id: created.id }) });
      store.record(actor, 'decision.pin', { type: 'decision', id: created.id }, { source_message_id: source?.id ?? null }, idempotencyKey);
      return created;
    });
    return { status: 201, body: decision };
  });

  register('POST', '/decisions/{decisionId}/supersede', (_c, { params, body, principal, idempotencyKey }) => {
    const parsed = decisionIdSchema.safeParse(params.decisionId);
    const previous = parsed.success ? store.room.decision(parsed.data) : undefined;
    if (!previous) throw notFound('Decision');
    requireActive(requireProject(store, previous.project_id));
    if (previous.superseded_by) throw new ApiError(409, 'DECISION_SUPERSEDED', 'This decision was already superseded', { superseded_by: previous.superseded_by });
    const input = body as z.infer<typeof supersedeDecisionRequestSchema>;
    const actor = actorOf(principal);
    const decision = store.tx(() => {
      const created = store.room.createDecision({ projectId: previous.project_id, title: input.title, statementMd: input.statement_md, rationaleMd: input.rationale_md,
        sources: [{ kind: 'decision', ref: previous.id }], decidedBy: actor.userId });
      store.emit(previous.project_id, 'decision.created', { decision: created });
      store.emit(previous.project_id, 'decision.updated', { decision: store.room.supersedeDecision(previous.id, created.id) });
      store.record(actor, 'decision.supersede', { type: 'decision', id: previous.id }, { by: created.id }, idempotencyKey);
      return created;
    });
    return { status: 201, body: decision };
  });

  // ── Tasks ──

  register('GET', '/projects/{projectId}/tasks', (_c, { params, query }) => {
    const project = requireProject(store, params.projectId);
    const filter = query as z.infer<typeof listTasksQuerySchema>;
    let tasks = store.tasks.list(project.id);
    if (filter.state === 'active') tasks = tasks.filter(task => !TERMINAL_TASK_STATES.includes(task.state));
    if (filter.state === 'finished') tasks = tasks.filter(task => TERMINAL_TASK_STATES.includes(task.state));
    if (filter.conversation_id) tasks = tasks.filter(task => task.conversation_id === filter.conversation_id);
    return { body: { tasks: tasks.map(publicTask) } };
  });

  register('POST', '/projects/{projectId}/tasks', (_c, { params, body, principal, idempotencyKey }) => {
    const project = requireActive(requireProject(store, params.projectId));
    const input = body as z.infer<typeof createTaskRequestSchema>;
    const revision = requireTeam(store, project.id);
    const role = revision.body.roles.find(item => item.key === input.role_key);
    if (!role?.agent_ref) throw new ApiError(409, 'TEAM_NOT_READY', `Role "${input.role_key}" has no bound agent in team r${revision.revision}`);
    const source = input.source_message_id ? store.room.message(input.source_message_id) : undefined;
    if (input.source_message_id && source?.project_id !== project.id) throw new ApiError(422, 'UNKNOWN_MESSAGE', 'source_message_id is not a message of this project');
    const named = input.conversation_id ? store.room.conversation(input.conversation_id) : undefined;
    if (input.conversation_id && named?.project_id !== project.id) throw new ApiError(422, 'UNKNOWN_CONVERSATION', 'conversation_id is not a conversation of this project');
    const actor = actorOf(principal);
    const task = store.tx(() => {
      const conversation = named ?? (source ? store.room.conversation(source.conversation_id)! : conductor.ensureTeamConversation(project.id, actor.userId));
      const created = conductor.queueTask({ projectId: project.id, title: input.title, mode: input.mode, roleKey: role.key,
        bindingId: role.binding_id ?? store.team.ensureBinding(role.agent_ref!).id, assignmentRevision: revision.revision,
        source: source ? { message_id: source.id } : {}, createdBy: actor.userId, conversationId: conversation.id, triggerMessageId: source?.id ?? null,
        instructionsMd: input.instructions_md });
      store.record(actor, 'task.create', { type: 'task', id: created.id }, { role_key: role.key, mode: input.mode }, idempotencyKey);
      return created;
    });
    conductor.kick();
    return { status: 201, body: publicTask(task) };
  });

  const control = (action: 'pause' | 'resume' | 'cancel') => async (_c: unknown, { params, principal, idempotencyKey }: { params: Record<string, string>; principal: Parameters<typeof actorOf>[0]; idempotencyKey: string | undefined }) => {
    const task = requireTask(store, params.taskId);
    if (action !== 'cancel') requireActive(requireProject(store, task.project_id));
    const actor = actorOf(principal);
    const updated = await conductor[action](task).catch(conductorError);
    store.tx(() => store.record(actor, `task.${action}`, { type: 'task', id: task.id }, { state: updated.state }, idempotencyKey));
    return { body: publicTask(updated) };
  };
  register('POST', '/tasks/{taskId}/pause', control('pause'));
  register('POST', '/tasks/{taskId}/resume', control('resume'));
  register('POST', '/tasks/{taskId}/cancel', control('cancel'));

  register('POST', '/tasks/{taskId}/reassign', async (_c, { params, body, principal, idempotencyKey }) => {
    const task = requireTask(store, params.taskId);
    const project = requireActive(requireProject(store, task.project_id));
    const input = body as z.infer<typeof reassignTaskRequestSchema>;
    const revision = requireTeam(store, project.id);
    const role = revision.body.roles.find(item => item.key === input.role_key);
    if (!role?.agent_ref) throw new ApiError(409, 'TEAM_NOT_READY', `Role "${input.role_key}" has no bound agent in team r${revision.revision}`);
    if (task.mode === 'discussion_turn') throw new ApiError(409, 'NOT_REASSIGNABLE', 'Discussion turns follow the discussion\'s participants');
    if (!TERMINAL_TASK_STATES.includes(task.state) && task.state !== 'input_required') await conductor.cancel(task).catch(conductorError);
    const actor = actorOf(principal);
    const created = store.tx(() => {
      const next = conductor.queueTask({ projectId: project.id, title: task.title, mode: task.mode, roleKey: role.key,
        bindingId: role.binding_id ?? store.team.ensureBinding(role.agent_ref!).id, assignmentRevision: revision.revision,
        source: { ...task.source, reassigned_from_role: task.role_key }, createdBy: actor.userId, conversationId: task.conversation_id,
        triggerMessageId: task.trigger_message_id, instructionsMd: task.instructions_md, reassignedFrom: task.id });
      store.record(actor, 'task.reassign', { type: 'task', id: task.id }, { to: next.id, role_key: role.key }, idempotencyKey);
      return next;
    });
    conductor.kick();
    return { status: 201, body: publicTask(created) };
  });
}
