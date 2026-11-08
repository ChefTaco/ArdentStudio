import type { z } from 'zod';
import { addressees } from '../../conductor/addressing.js';
import { publicTask } from '../../conductor/conductor.js';
import type { Conversation, Message } from '../../db/repos/room.js';
import type { TeamRevision } from '../../db/repos/team.js';
import type { Store } from '../../db/store.js';
import {
  conversationIdSchema, messageIdSchema,
  type answerRequestSchema, type createConversationRequestSchema, type followUpRequestSchema, type listMessagesQuerySchema, type postMessageRequestSchema,
  type putLayoutRequestSchema,
} from '../../shared/browser.js';
import { actorOf, requireActive, requireProject, type AppDeps } from '../deps.js';
import { ApiError, notFound } from '../errors.js';
import type { createRouter } from '../routing.js';

export function requireConversation(store: Store, id: string | undefined): Conversation {
  const parsed = conversationIdSchema.safeParse(id);
  const conversation = parsed.success ? store.room.conversation(parsed.data) : undefined;
  if (!conversation) throw notFound('Conversation');
  return conversation;
}

export function requireMessage(store: Store, id: string | undefined): Message {
  const parsed = messageIdSchema.safeParse(id);
  const message = parsed.success ? store.room.message(parsed.data) : undefined;
  if (!message) throw notFound('Message');
  return message;
}

export function requireTeam(store: Store, projectId: string): TeamRevision {
  const revision = store.team.current(projectId);
  if (!revision) throw new ApiError(409, 'TEAM_NOT_READY', 'Publish a team before starting work in the room');
  return revision;
}

export function roomRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  const { store, conductor } = deps;

  register('GET', '/projects/{projectId}/layout', (_c, { params }) => ({ body: { layout: store.room.layout(requireProject(store, params.projectId).id) ?? null } }));

  register('PUT', '/projects/{projectId}/layout', (_c, { params, body, principal, idempotencyKey }) => {
    const project = requireActive(requireProject(store, params.projectId));
    const input = body as z.infer<typeof putLayoutRequestSchema>;
    const seats = new Set(input.seats.map(seat => seat.id));
    if (seats.size !== input.seats.length) throw new ApiError(422, 'DUPLICATE_SEAT', 'Seat ids must be unique');
    const missing = input.placements.filter(placement => !seats.has(placement.seat_id)).map(placement => placement.seat_id);
    if (missing.length) throw new ApiError(422, 'UNKNOWN_SEAT', 'Placements name seats that are not in the layout', { seats: missing });
    const actor = actorOf(principal);
    const layout = store.tx(() => {
      const current = store.room.layout(project.id)?.revision ?? null;
      if (current !== input.base_revision) throw new ApiError(409, 'LAYOUT_CONFLICT', `The layout is at revision ${current ?? 0}`, { revision: current });
      const saved = store.room.saveLayout(project.id, { seats: input.seats, placements: input.placements, zone_labels: input.zone_labels, createdBy: actor.userId });
      store.emit(project.id, 'layout.updated', { revision: saved.revision });
      store.record(actor, 'layout.save', { type: 'project', id: project.id }, { revision: saved.revision }, idempotencyKey);
      return saved;
    });
    return { body: { layout } };
  });

  register('GET', '/projects/{projectId}/conversations', (_c, { params }) => ({ body: { conversations: store.room.conversations(requireProject(store, params.projectId).id) } }));

  register('POST', '/projects/{projectId}/conversations', (_c, { params, body, principal, idempotencyKey }) => {
    const project = requireActive(requireProject(store, params.projectId));
    const input = body as z.infer<typeof createConversationRequestSchema>;
    const actor = actorOf(principal);
    if (input.kind === 'team') {
      const existing = store.room.teamConversation(project.id);
      if (existing) return { status: 200, body: existing };
      const created = store.tx(() => {
        const conversation = store.room.createConversation({ projectId: project.id, kind: 'team', title: input.title ?? 'Team room', createdBy: actor.userId });
        store.emit(project.id, 'conversation.created', { conversation });
        store.record(actor, 'conversation.create', { type: 'conversation', id: conversation.id }, { kind: 'team' }, idempotencyKey);
        return conversation;
      });
      return { status: 201, body: created };
    }
    const revision = requireTeam(store, project.id);
    const roleOf = (key: string) => revision.body.roles.find(role => role.key === key);
    if (input.kind === 'direct') {
      const role = roleOf(input.role_key);
      if (!role) throw new ApiError(409, 'TEAM_NOT_READY', `Team r${revision.revision} has no role "${input.role_key}"`);
      const created = store.tx(() => {
        const conversation = store.room.createConversation({ projectId: project.id, kind: 'direct', roleKey: role.key, title: input.title ?? role.name, createdBy: actor.userId });
        store.emit(project.id, 'conversation.created', { conversation });
        store.record(actor, 'conversation.create', { type: 'conversation', id: conversation.id }, { kind: 'direct', role_key: role.key }, idempotencyKey);
        return conversation;
      });
      return { status: 201, body: created };
    }
    const missing = input.participants.filter(key => !roleOf(key)?.agent_ref);
    if (missing.length) throw new ApiError(409, 'TEAM_NOT_READY', 'Every participant needs a role with a bound agent', { roles: missing });
    const parent = input.parent_id ? store.room.conversation(input.parent_id) : undefined;
    if (input.parent_id && parent?.project_id !== project.id) throw new ApiError(422, 'UNKNOWN_CONVERSATION', 'parent_id is not a conversation of this project');
    const created = store.tx(() => {
      const conversation = store.room.createConversation({
        projectId: project.id, kind: 'discussion', parentId: parent?.id ?? null, title: input.title ?? input.question.slice(0, 200), createdBy: actor.userId,
        discussion: { question: input.question, desired_output: input.desired_output, participants: input.participants, max_rounds: input.max_rounds, round: 1, state: 'running' },
      });
      store.emit(project.id, 'conversation.created', { conversation });
      const question = store.room.addMessage({ conversationId: conversation.id, author: { kind: 'user', user_id: actor.userId }, kind: 'discussion_question',
        addressees: input.participants, bodyMd: input.question, state: 'complete' });
      store.emit(project.id, 'message.created', { message: question });
      conductor.queueDiscussionRound(conversation, revision, 1, actor.userId);
      store.record(actor, 'discussion.start', { type: 'conversation', id: conversation.id }, { participants: input.participants, max_rounds: input.max_rounds }, idempotencyKey);
      return conversation;
    });
    conductor.kick();
    return { status: 201, body: created };
  });

  register('POST', '/conversations/{conversationId}/stop', async (_c, { params, principal, idempotencyKey }) => {
    const conversation = requireConversation(store, params.conversationId);
    requireActive(requireProject(store, conversation.project_id));
    const actor = actorOf(principal);
    const stopped = store.tx(() => {
      let next = store.room.stopConversation(conversation.id);
      if (next.discussion && (next.discussion.state === 'running' || next.discussion.state === 'summarizing')) {
        next = store.room.updateDiscussion(next.id, { ...next.discussion, state: 'stopped' });
      }
      store.emit(conversation.project_id, 'conversation.updated', { conversation: next });
      store.record(actor, 'conversation.stop', { type: 'conversation', id: conversation.id }, {}, idempotencyKey);
      return next;
    });
    await conductor.stopConversation(conversation.id);
    return { body: stopped };
  });

  register('GET', '/conversations/{conversationId}/messages', (_c, { params, query }) => {
    const conversation = requireConversation(store, params.conversationId);
    const { after, limit } = query as z.infer<typeof listMessagesQuerySchema>;
    const size = Math.min(200, Math.max(1, Number(limit ?? '100')));
    const messages = store.room.messages(conversation.id, Number(after ?? '0'), size);
    return { body: { messages, next_after: messages.length === size ? messages.at(-1)!.seq : null } };
  });

  register('POST', '/conversations/{conversationId}/messages', (_c, { params, body, principal, idempotencyKey }) => {
    const conversation = requireConversation(store, params.conversationId);
    const project = requireActive(requireProject(store, conversation.project_id));
    const input = body as z.infer<typeof postMessageRequestSchema>;
    if (conversation.stopped_at) throw new ApiError(409, 'CONVERSATION_STOPPED', 'This conversation was stopped');
    const files = new Set(store.files.list(project.id).map(file => file.id));
    const foreign = input.attachments.filter(id => !files.has(id));
    if (foreign.length) throw new ApiError(422, 'UNKNOWN_FILE', 'Attachments must be files of this project', { files: foreign });
    for (const id of [input.reply_to, input.thread_root]) {
      if (id && store.room.message(id)?.project_id !== project.id) throw new ApiError(422, 'UNKNOWN_MESSAGE', 'reply_to and thread_root must be messages of this project');
    }
    const revision = conversation.kind === 'discussion' ? store.team.current(project.id) : requireTeam(store, project.id);
    const addressing = addressees({ conversation, to: input.to, body: input.body_md, roles: revision?.body.roles ?? [] });
    if ('error' in addressing) throw new ApiError(409, 'TEAM_NOT_READY', addressing.error, addressing.details);
    const actor = actorOf(principal);
    const result = store.tx(() => {
      const message = store.room.addMessage({ conversationId: conversation.id, author: { kind: 'user', user_id: actor.userId }, kind: 'message',
        addressees: addressing.roles.map(role => role.key), bodyMd: input.body_md, replyTo: input.reply_to ?? null, threadRoot: input.thread_root ?? null,
        attachments: input.attachments, state: 'complete' });
      store.emit(project.id, 'message.created', { message });
      const tasks = revision && addressing.roles.length
        ? conductor.queueTurns({ project, revision, conversation, message, roles: addressing.roles, createdBy: actor.userId })
        : [];
      store.record(actor, 'message.post', { type: 'message', id: message.id }, { conversation_id: conversation.id, addressees: message.addressees, tasks: tasks.length }, idempotencyKey);
      return { message, tasks: tasks.map(publicTask) };
    });
    conductor.kick();
    return { status: 201, body: result };
  });

  register('POST', '/messages/{messageId}/answer', (_c, { params, body, principal, idempotencyKey }) => {
    const clarification = requireMessage(store, params.messageId);
    const project = requireActive(requireProject(store, clarification.project_id));
    if (clarification.kind !== 'clarification') throw new ApiError(409, 'NOT_A_CLARIFICATION', 'Only an agent\'s clarification can be answered');
    if (clarification.links.answer_message_id) throw new ApiError(409, 'ALREADY_ANSWERED', 'This clarification has already been answered');
    const asked = typeof clarification.links.task_id === 'string' ? store.tasks.get(clarification.links.task_id) : undefined;
    if (!asked) throw new ApiError(409, 'NOT_A_CLARIFICATION', 'The clarification has no task');
    const revision = (asked.assignment_revision ? store.team.revision(project.id, asked.assignment_revision) : undefined) ?? requireTeam(store, project.id);
    const role = revision.body.roles.find(item => item.key === asked.role_key);
    if (!role?.agent_ref) throw new ApiError(409, 'TEAM_NOT_READY', 'The role that asked has no bound agent');
    const input = body as z.infer<typeof answerRequestSchema>;
    const conversation = store.room.conversation(clarification.conversation_id)!;
    const actor = actorOf(principal);
    const result = store.tx(() => {
      const answer = store.room.addMessage({ conversationId: conversation.id, author: { kind: 'user', user_id: actor.userId }, kind: 'answer', addressees: [role.key],
        bodyMd: input.option ? `${input.option}\n\n${input.body_md}` : input.body_md, replyTo: clarification.id, links: { answers: clarification.id }, state: 'complete' });
      store.emit(project.id, 'message.created', { message: answer });
      store.emit(project.id, 'message.updated', { message: store.room.updateLinks(clarification.id, { answer_message_id: answer.id }) });
      const current = store.tasks.get(asked.id)!;
      if (current.state === 'input_required') {
        const outcome = (current.outcome && typeof current.outcome === 'object' ? current.outcome : {}) as Record<string, unknown>;
        store.emit(project.id, 'task.updated', conductor.taskEvent(store.tasks.setState(asked.id, 'completed', { ...outcome, answered_by: answer.id })));
      }
      const task = conductor.queueTask({
        projectId: project.id, title: `Answer: ${clarification.body_md.replace(/\s+/g, ' ').slice(0, 100)}`, mode: 'turn', roleKey: role.key,
        bindingId: role.binding_id ?? store.team.ensureBinding(role.agent_ref!).id, assignmentRevision: revision.revision,
        source: { answer_to: clarification.id, question: clarification.body_md, answers_task: asked.id }, createdBy: actor.userId,
        conversationId: conversation.id, triggerMessageId: answer.id,
      });
      store.record(actor, 'clarification.answer', { type: 'message', id: clarification.id }, { answer_id: answer.id, task_id: task.id }, idempotencyKey);
      return { message: answer, tasks: [publicTask(task)] };
    });
    conductor.kick();
    return { status: 201, body: result };
  });

  register('POST', '/messages/{messageId}/follow-up', (_c, { params, body, principal, idempotencyKey }) => {
    const original = requireMessage(store, params.messageId);
    const project = requireActive(requireProject(store, original.project_id));
    if (original.author.kind !== 'agent' || !original.author.role_key) throw new ApiError(409, 'NOT_AN_AGENT_MESSAGE', 'Only an agent\'s message can be followed up');
    const revision = requireTeam(store, project.id);
    const role = revision.body.roles.find(item => item.key === (original.author as { role_key: string }).role_key);
    if (!role?.agent_ref) throw new ApiError(409, 'TEAM_NOT_READY', 'That role is no longer bound in the published team');
    const conversation = store.room.conversation(original.conversation_id)!;
    if (conversation.stopped_at) throw new ApiError(409, 'CONVERSATION_STOPPED', 'This conversation was stopped');
    const input = body as z.infer<typeof followUpRequestSchema>;
    const quoted = original.body_md.replace(/\s+/g, ' ').trim().slice(0, 500);
    const actor = actorOf(principal);
    const result = store.tx(() => {
      const message = store.room.addMessage({ conversationId: conversation.id, author: { kind: 'user', user_id: actor.userId }, kind: 'message', addressees: [role.key],
        bodyMd: `Please follow up on your message:\n> ${quoted}${input.body_md ? `\n\n${input.body_md}` : ''}`, replyTo: original.id, links: { follow_up_of: original.id }, state: 'complete' });
      store.emit(project.id, 'message.created', { message });
      const [task] = conductor.queueTurns({ project, revision, conversation, message, roles: [role], createdBy: actor.userId, source: { follow_up_of: original.id } });
      store.record(actor, 'message.follow_up', { type: 'message', id: original.id }, { message_id: message.id, task_id: task!.id }, idempotencyKey);
      return { message, tasks: [publicTask(task!)] };
    });
    conductor.kick();
    return { status: 201, body: result };
  });
}
