// What an agent is told for one turn. Pure functions: the conductor gathers the records, this
// module turns them into a mission objective with context items (Ardent 2.2.0 missions) or one
// composed prompt (task-submit on older agents). Role instructions come every turn; the project
// brief only on the first turn of a session, because later turns rely on the Ardent session.
// The agent sees only room messages it has not been shown yet. Nothing here invents content:
// every line comes from a stored record, and anything cut to fit is marked as cut.
import type { ArdentContextItem, ArdentTeamMission } from '../clients/magnus.js';
import { ARDENT_CONTEXT_ITEMS_MAX_BYTES } from '../clients/magnus.js';
import type { Project } from '../db/repos/projects.js';
import type { Message } from '../db/repos/room.js';
import type { StudioTask } from '../db/repos/tasks.js';
import type { TeamBody } from '../db/repos/team.js';

export type TeamRole = TeamBody['roles'][number];

/** Ardent's limits: a mission objective and a task prompt are at most 16000 characters. */
export const PROMPT_LIMIT = 16_000;
/** Inline sizes before material moves into context items. */
const INLINE_BRIEF = 3_000;
const INLINE_ROOM = 6_000;
const ITEM_TEXT_LIMIT = 24_000;

export interface AttachmentText { name: string; mime: string; text: string | null }

export interface TurnInput {
  project: Pick<Project, 'id' | 'name' | 'brief_md' | 'audience' | 'constraints' | 'deliverables'>;
  team: Pick<TeamBody, 'roles' | 'relationships'>;
  role: TeamRole;
  task: Pick<StudioTask, 'id' | 'mode' | 'title' | 'instructions_md' | 'source'>;
  /** No earlier turn in this Ardent session (or no session at all): include the brief and roster. */
  firstTurn: boolean;
  /** Room messages the agent has not been shown, oldest first, without the trigger. */
  unseen: readonly Message[];
  /** The message this turn answers, when there is one. */
  trigger: Message | undefined;
  /** Readable names for message authors and addressees. */
  names: { author: (message: Message) => string; role: (key: string) => string };
  attachments: readonly AttachmentText[];
  discussion?: { question: string; desired_output: string; round: number; max_rounds: number; summary: boolean; transcript: readonly Message[] } | undefined;
  /** Further material for this turn, such as the review comments of a revision request. */
  extra?: ReadonlyArray<{ title: string; text: string; mime?: string }> | undefined;
}

export interface ComposedTurn {
  /** Mission objective (missions) — at most PROMPT_LIMIT characters. */
  objective: string;
  /** Large material for a mission, within Ardent's 64 KiB. */
  contextItems: ArdentContextItem[];
  /** The same turn as one prompt for task-submit, with large material shortened to fit. */
  prompt: string;
}

const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, Math.max(0, max - 15)).trimEnd()}\n[…shortened]`;
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

function renderMessage(message: Message, names: TurnInput['names']): string {
  const to = message.addressees.length ? ` → ${message.addressees.map(names.role).join(', ')}` : '';
  return `[${names.author(message)}${to}] ${message.body_md.trim() || '(no text)'}`;
}

function roleSection(role: TeamRole): string {
  const lines = [`You are ${role.name} (role key "${role.key}")${role.coordinator ? ', the team coordinator' : ''}.`];
  if (role.responsibilities_md.trim()) lines.push(`Responsibilities:\n${role.responsibilities_md.trim()}`);
  if (role.instructions_md.trim()) lines.push(`Instructions for this project:\n${role.instructions_md.trim()}`);
  if (role.contributions.length) lines.push(`You contribute: ${role.contributions.join('; ')}.`);
  if (role.deliverables.length) lines.push(`You deliver: ${role.deliverables.join('; ')}.`);
  return lines.join('\n');
}

function rosterSection(input: TurnInput): string {
  const lines = input.team.roles.map(role => `- ${role.name} ("${role.key}")${role.coordinator ? ', coordinator' : ''}${role.agent_ref ? '' : ' (no agent bound)'}`);
  const edges = input.team.relationships.filter(edge => edge.from === input.role.key || edge.to === input.role.key)
    .map(edge => `- ${input.names.role(edge.from)} ${edge.type.replace(/_/g, ' ')} ${input.names.role(edge.to)}`);
  return [`Team:\n${lines.join('\n')}`, edges.length ? `Your working relationships:\n${edges.join('\n')}` : ''].filter(Boolean).join('\n');
}

function projectSection(input: TurnInput, brief: string): string {
  const project = input.project;
  const lines = [`Project: ${project.name}`];
  if (project.audience) lines.push(`Audience: ${project.audience}`);
  if (project.constraints.length) lines.push(`Constraints:\n${project.constraints.map(item => `- ${item}`).join('\n')}`);
  if (project.deliverables.length) {
    lines.push(`Requested deliverables:\n${project.deliverables.map(item => `- ${item.name} (${item.formats.join(', ')})${item.producer_role_key ? ` by ${input.names.role(item.producer_role_key)}` : ''}`).join('\n')}`);
  }
  if (brief) lines.push(`Brief:\n${brief}`);
  return lines.join('\n');
}

function requestSection(input: TurnInput): string {
  const { task, trigger, names, discussion } = input;
  if (discussion) {
    const head = `Discussion question: ${discussion.question}\nDesired output: ${discussion.desired_output.replace(/_/g, ' ')}.`;
    return discussion.summary
      ? `${head}\nThe discussion has ended. As coordinator, summarize it as the desired output. Name open disagreements; do not add positions nobody took.`
      : `${head}\nRound ${discussion.round} of ${discussion.max_rounds}. Give your contribution from your role in a few short paragraphs, responding to what others said.`;
  }
  if (typeof task.source.answer_to === 'string' && trigger) {
    const question = typeof task.source.question === 'string' ? task.source.question : 'your question';
    return `${names.author(trigger)} answered ${JSON.stringify(question)}:\n${trigger.body_md.trim()}`;
  }
  if (task.mode === 'turn' && trigger) return `Message for you from ${names.author(trigger)}:\n${trigger.body_md.trim()}`;
  const lines = [`${task.mode === 'revision' ? 'Revision request' : task.mode === 'review' ? 'Review request' : 'Assignment'}: ${task.title}`];
  if (task.instructions_md.trim()) lines.push(task.instructions_md.trim());
  if (typeof task.source.handoff_from === 'string') lines.push(`Handed off by ${names.role(task.source.handoff_from)}.`);
  if (trigger) lines.push(`From the message by ${names.author(trigger)}:\n${trigger.body_md.trim()}`);
  return lines.join('\n');
}

/** Compose one turn. Large material becomes context items for a mission and is shortened for a plain prompt. */
export function composeTurn(input: TurnInput): ComposedTurn {
  const items: ArdentContextItem[] = [];
  let itemBytes = 0;
  const addItem = (title: string, text: string, mime = 'text/markdown'): boolean => {
    const body = clip(text, ITEM_TEXT_LIMIT);
    const size = bytes(title + body);
    if (!body.trim() || itemBytes + size > ARDENT_CONTEXT_ITEMS_MAX_BYTES || items.length >= 64) return false;
    items.push({ title, mime, text: body });
    itemBytes += size;
    return true;
  };

  const brief = input.firstTurn ? input.project.brief_md.trim() : '';
  const briefInline = brief.length <= INLINE_BRIEF ? brief : '';
  const briefItem = brief && !briefInline ? addItem('Project brief', brief) : false;

  const transcript = input.discussion && !input.discussion.summary ? [] : input.unseen;
  const room = transcript.map(message => renderMessage(message, input.names)).join('\n');
  const roomInline = room.length <= INLINE_ROOM ? room : '';
  const roomItem = room && !roomInline ? addItem('Room messages since your last turn', room) : false;
  const discussionRoom = input.discussion ? input.discussion.transcript.map(message => renderMessage(message, input.names)).join('\n') : '';
  const discussionInline = discussionRoom.length <= INLINE_ROOM ? discussionRoom : '';
  const discussionItem = discussionRoom && !discussionInline ? addItem('Discussion so far', discussionRoom) : false;

  const attachmentNotes: string[] = [];
  for (const attachment of input.attachments) {
    if (attachment.text !== null && addItem(`Attachment: ${attachment.name}`, attachment.text, attachment.mime.startsWith('text/') ? attachment.mime : 'text/plain')) {
      attachmentNotes.push(`- ${attachment.name} (in context items)`);
    } else {
      attachmentNotes.push(`- ${attachment.name} (${attachment.mime}; not included as text)`);
    }
  }

  const extraNotes: string[] = [];
  const extraInline: string[] = [];
  for (const item of input.extra ?? []) {
    if (addItem(item.title, item.text, item.mime)) extraNotes.push(`- ${item.title}`);
    extraInline.push(`${item.title}:\n${clip(item.text, 3_000)}`);
  }

  const sections = (mode: 'mission' | 'prompt', budget: { brief: string; room: string; discussion: string }) => [
    roleSection(input.role),
    input.firstTurn ? projectSection(input, budget.brief) : `Project: ${input.project.name}`,
    input.firstTurn ? rosterSection(input) : '',
    budget.room ? `Room messages since your last turn:\n${budget.room}` : '',
    budget.discussion ? `Discussion so far:\n${budget.discussion}` : '',
    attachmentNotes.length ? `Attachments:\n${attachmentNotes.join('\n')}` : '',
    mode === 'mission' && extraNotes.length ? `In context items:\n${extraNotes.join('\n')}` : '',
    mode === 'prompt' && extraInline.length ? extraInline.join('\n\n') : '',
    requestSection(input),
    mode === 'mission'
      ? 'Reply to the team in plain prose; your reply is posted in the room as your message.'
      : 'Reply to the team in plain prose; your reply is posted in the room as your message. You cannot hand work to other roles or save files in this turn; say what you need instead.',
  ].filter(Boolean).join('\n\n');

  const objective = clip(sections('mission', {
    brief: briefInline || (briefItem ? '(in the context item "Project brief")' : clip(brief, INLINE_BRIEF)),
    room: roomInline || (roomItem ? '(in the context item "Room messages since your last turn")' : clip(room.slice(-INLINE_ROOM), INLINE_ROOM)),
    discussion: discussionInline || (discussionItem ? '(in the context item "Discussion so far")' : clip(discussionRoom.slice(-INLINE_ROOM), INLINE_ROOM)),
  }), PROMPT_LIMIT);

  // A plain prompt has no context items: keep the newest room text and the start of the brief.
  const fixed = sections('prompt', { brief: '', room: '', discussion: '' }).length;
  const spare = Math.max(0, PROMPT_LIMIT - fixed - 200);
  const roomShare = Math.floor(spare * (brief ? 0.5 : 1));
  const tail = (text: string, max: number) => text.length <= max ? text : `[…earlier messages left out]\n${text.slice(text.length - max + 32)}`;
  const prompt = clip(sections('prompt', {
    brief: brief ? clip(brief, Math.max(200, spare - Math.min(roomShare, room.length + discussionRoom.length))) : '',
    room: room ? tail(room, Math.max(200, Math.floor(roomShare / (discussionRoom ? 2 : 1)))) : '',
    discussion: discussionRoom ? tail(discussionRoom, Math.max(200, Math.floor(roomShare / 2))) : '',
  }), PROMPT_LIMIT);

  return { objective, contextItems: items, prompt };
}

/** Mission tools a role may use. A hand-off tool only when the team gives the role someone to hand to. */
export function missionResources(input: { team: Pick<TeamBody, 'relationships'>; role: TeamRole; hivememProjectId: string }): string[] {
  const resources = ['tool:team_ask_user', 'tool:team_propose_decision', 'tool:artifact_write', 'tool:document_render', 'tool:development_note'];
  if (input.team.relationships.some(edge => edge.from === input.role.key && HANDOFF_EDGES.includes(edge.type))) resources.unshift('tool:team_handoff');
  resources.push(`project:${input.hivememProjectId}`);
  return resources;
}

/** Relationship types along which Studio starts a requested hand-off. */
export const HANDOFF_EDGES: readonly string[] = ['delegates_to', 'hands_off_to'];

const MISSION_HOURS = 6;
const missionLine = (text: string) => {
  let line = text.replace(/\s+/g, ' ').trim();
  while (bytes(line) > 1000) line = line.slice(0, -16);
  return line;
};

/** The TeamMission for a Studio task: constraints from the project, criteria from the request. */
export function buildMission(input: { task: Pick<StudioTask, 'id' | 'mode' | 'title' | 'assignment_revision'> & { source?: Record<string, unknown> }; project: Pick<Project, 'name' | 'constraints' | 'deliverables'>;
  team: Pick<TeamBody, 'relationships'>; role: TeamRole; hivememProjectId: string; now: Date }): ArdentTeamMission {
  const { task, role, project } = input;
  const unique = (values: string[]) => [...new Set(values.map(missionLine).filter(Boolean))].slice(0, 32);
  const criteria = task.mode === 'turn' ? ['Reply to the latest message addressed to you, in your role']
    : task.mode === 'discussion_turn' ? ['Contribute your view to the discussion round, in your role']
      : [`Complete: ${task.title}`];
  const expected = task.mode === 'revision' && typeof task.source?.deliverable_name === 'string' ? [task.source.deliverable_name]
    : task.mode === 'assignment' ? project.deliverables.filter(item => item.producer_role_key === role.key).map(item => item.name)
      : [];
  return {
    id: task.id,
    revision: Math.max(1, task.assignment_revision ?? 1),
    parent_task: null,
    constraints: unique([`Project: ${project.name}`, `Role: ${role.name}`, ...project.constraints]),
    allowed_actions: ['observe', 'analyze', 'create_artifact', 'create_draft'],
    resources: missionResources(input),
    deadline: Math.floor(input.now.getTime() / 1000) + MISSION_HOURS * 3600,
    acceptance_criteria: unique(criteria),
    expected_artifacts: unique(expected),
  };
}
