// "Propose a team from the brief" (§3.2.4). One agent, the bound coordinator or one a person
// chose, gets a bounded team_proposal task through the conductor with the brief, the requested
// deliverables, the template catalog and the available agents. Its reply must be TeamProposal
// JSON: it is validated, retried once with the validation error, and then fails visibly. A valid
// proposal is stored with a ready-to-send draft body; nothing is applied, a person decides.
import { z } from 'zod';
import type { AgentDirectory } from '../agents/directory.js';
import type { ArdentContextItem } from '../clients/magnus.js';
import { ARDENT_CONTEXT_ITEMS_MAX_BYTES } from '../clients/magnus.js';
import type { Conductor, ModeRequest, TaskModeHandler } from '../conductor/conductor.js';
import { PROMPT_LIMIT } from '../conductor/prompting.js';
import type { AuditActor } from '../db/repos/audit.js';
import { hivememProjectId, type Project } from '../db/repos/projects.js';
import { FINISHED_PROPOSAL_STATES, type TeamDraftBody, type TeamProposal, type TeamProposalRecord } from '../db/repos/proposals.js';
import type { StudioTask, TaskState } from '../db/repos/tasks.js';
import type { Store } from '../db/store.js';
import type { ArdentTaskEvent } from '../clients/magnus.js';
import { teamProposalSchema } from '../shared/browser.js';
import { validateTeam } from './validation.js';

/** One retry after an invalid reply. */
export const MAX_PROPOSAL_ATTEMPTS = 2;
const TEMPLATE_LIMIT = 40;
const AGENT_LIMIT = 100;
const INLINE_BRIEF = 3_000;
const ITEM_TEXT_LIMIT = 24_000;
const ERROR_LIMIT = 1_500;
const PROPOSAL_HOURS = 1;

export class ProposalError extends Error {
  override name = 'ProposalError';
  constructor(message: string, readonly status: 409 | 422 | 503, readonly code: string, readonly details?: unknown) { super(message); }
}

/** What the agent is given, stored with the proposal so a retry asks the same question. */
export interface ProposalRequest {
  project: { name: string; audience: string | null; constraints: string[]; brief_md: string; deliverables: Array<{ name: string; kind: string; formats: string[]; stage: string | null }> };
  basis_team: { source_template: string | null; roles: Array<{ key: string; name: string; coordinator: boolean; agent_ref: string | null }> } | null;
  team_templates: Array<{ template_id: string; version: number; name: string; category: string; purpose: string; roles: Array<{ key: string; name: string; coordinator: boolean }> }>;
  agent_templates: Array<{ template_id: string; version: number; name: string; category: string; purpose: string }>;
  agents: Array<{ agent_ref: string; display_name: string; backend: string | null; available: boolean; roles: string[] }>;
}

const line = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, Math.max(0, max - 15)).trimEnd()}\n[…shortened]`;
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

const INSTRUCTIONS = `Propose an agent team for this project from its brief. A person will review your proposal; nothing is applied automatically.

Reply with exactly one JSON object and nothing else (a \`\`\`json fence around it is fine). Do not use tools and do not create files. Fields:
- "rationale": why this team fits the brief (at most 4000 characters).
- "source_template": {"template_id": "...", "version": n} of the team template you started from, or null.
- "roles": 1 to 30 roles, each {"key", "name", "coordinator", "responsibilities_md", "instructions_md", "contributions", "deliverables", "agent_template_ref", "stage", "rationale"}. "key" is lower case (a-z, 0-9, _ or -, starting with a letter) and unique. Exactly one role has "coordinator": true. "deliverables" lists the requested deliverable names the role produces; every requested deliverable needs a producer. "agent_template_ref" is {"template_id", "version"} of a listed agent template, or null. "stage" is one of create, research, discuss, review, revise, deliver, or null.
- "relationships": [{"from", "to", "type", "stage", "label"}] between role keys; "type" is reports_to, delegates_to, hands_off_to or reviews. Every role except the coordinator reports to exactly one role, and reporting lines have no cycles. Hand-offs may loop only through a hands_off_to edge with "stage": "revise".
- "stages": the stages the team works through, in order.
- "bindings": suggested agents, [{"role_key", "agent_ref", "reason"}], using only agent_ref values from the available agents. Leave a role out when no listed agent fits.`;

function projectSection(request: ProposalRequest, brief: string): string {
  const { project } = request;
  const lines = [`Project: ${project.name}`];
  if (project.audience) lines.push(`Audience: ${project.audience}`);
  if (project.constraints.length) lines.push(`Constraints:\n${project.constraints.map(item => `- ${item}`).join('\n')}`);
  lines.push(project.deliverables.length
    ? `Requested deliverables:\n${project.deliverables.map(item => `- ${item.name} (${item.kind}; ${item.formats.join(', ')}${item.stage ? `; stage ${item.stage}` : ''})`).join('\n')}`
    : 'Requested deliverables: none listed yet.');
  if (request.basis_team?.roles.length) {
    lines.push(`Current team${request.basis_team.source_template ? ` (from ${request.basis_team.source_template})` : ''}:\n${request.basis_team.roles
      .map(role => `- ${role.name} ("${role.key}")${role.coordinator ? ', coordinator' : ''}${role.agent_ref ? `, bound to ${role.agent_ref}` : ''}`).join('\n')}`);
  }
  if (brief) lines.push(`Brief:\n${brief}`);
  return lines.join('\n');
}

export function agentsText(request: ProposalRequest): string {
  if (!request.agents.length) return 'No agents are available; leave "bindings" empty.';
  return request.agents.map(agent => `- ${agent.agent_ref}: ${agent.display_name}${agent.backend ? `, ${agent.backend}` : ''}, ${agent.available ? 'available' : 'not available now'}`
    + `${agent.roles.length ? `; current roles: ${agent.roles.join('; ')}` : ''}`).join('\n');
}

export function teamTemplatesText(request: ProposalRequest): string {
  if (!request.team_templates.length) return 'No team templates.';
  return request.team_templates.map(item => `- ${item.name} (template_id ${item.template_id}, version ${item.version}, ${item.category}): ${line(item.purpose, 200)} `
    + `Roles: ${item.roles.map(role => `${role.name} "${role.key}"${role.coordinator ? ' (coordinator)' : ''}`).join(', ')}.`).join('\n');
}

export function agentTemplatesText(request: ProposalRequest): string {
  if (!request.agent_templates.length) return 'No agent templates.';
  return request.agent_templates.map(item => `- ${item.name} (template_id ${item.template_id}, version ${item.version}, ${item.category}): ${line(item.purpose, 160)}`).join('\n');
}

function retrySection(previousError: string | undefined): string {
  return previousError
    ? `Your previous reply could not be used:\n${previousError}\nReply again with one corrected JSON object that follows the rules above.`
    : '';
}

/** The request for one attempt: a mission objective with context items, and a prompt for task-submit. */
export function composeProposal(input: { taskId: string; request: ProposalRequest; hivememProjectId: string; previousError?: string | undefined; now: Date }): ModeRequest {
  const { request } = input;
  const brief = request.project.brief_md.trim();
  const items: ArdentContextItem[] = [];
  let used = 0;
  const addItem = (title: string, text: string): boolean => {
    const body = clip(text, ITEM_TEXT_LIMIT);
    const size = bytes(title + body);
    if (!body.trim() || used + size > ARDENT_CONTEXT_ITEMS_MAX_BYTES) return false;
    items.push({ title, mime: 'text/markdown', text: body });
    used += size;
    return true;
  };
  const briefInline = brief.length <= INLINE_BRIEF ? brief : '';
  const briefItem = brief && !briefInline ? addItem('Project brief', brief) : false;
  const listed = [
    addItem('Available agents', agentsText(request)) ? 'Available agents' : '',
    addItem('Team templates', teamTemplatesText(request)) ? 'Team templates' : '',
    addItem('Agent templates', agentTemplatesText(request)) ? 'Agent templates' : '',
  ].filter(Boolean);
  const objective = clip([
    INSTRUCTIONS,
    retrySection(input.previousError),
    projectSection(request, briefInline || (briefItem ? '(in the context item "Project brief")' : clip(brief, INLINE_BRIEF))),
    listed.length ? `In context items: ${listed.map(title => `"${title}"`).join(', ')}.` : '',
    listed.includes('Available agents') ? '' : `Available agents:\n${clip(agentsText(request), 3_000)}`,
  ].filter(Boolean).join('\n\n'), PROMPT_LIMIT);

  // task-submit has no context items: keep the instructions, then share what is left.
  const fixed = [INSTRUCTIONS, retrySection(input.previousError), projectSection(request, '')].filter(Boolean).join('\n\n');
  const spare = Math.max(0, PROMPT_LIMIT - fixed.length - 300);
  const prompt = clip([
    fixed,
    brief ? `Brief:\n${clip(brief, Math.max(500, Math.floor(spare * 0.35)))}` : '',
    `Available agents:\n${clip(agentsText(request), Math.max(500, Math.floor(spare * 0.25)))}`,
    `Team templates:\n${clip(teamTemplatesText(request), Math.max(500, Math.floor(spare * 0.25)))}`,
    `Agent templates:\n${clip(agentTemplatesText(request), Math.max(300, Math.floor(spare * 0.15)))}`,
  ].filter(Boolean).join('\n\n'), PROMPT_LIMIT);

  return {
    objective, contextItems: items, prompt,
    mission: {
      id: input.taskId,
      revision: 1,
      parent_task: null,
      constraints: [line(`Project: ${request.project.name}`, 900), 'Answer with one TeamProposal JSON object; do not create files'],
      allowed_actions: ['observe', 'analyze'],
      resources: [`project:${input.hivememProjectId}`],
      deadline: Math.floor(input.now.getTime() / 1000) + PROPOSAL_HOURS * 3600,
      acceptance_criteria: ['Propose a team for the brief as one TeamProposal JSON object'],
      expected_artifacts: [],
    },
  };
}

/** The first JSON object in a reply: the whole reply, a fenced block, or the outermost braces. */
export function extractJson(reply: string): unknown {
  const text = reply.trim();
  const attempts = [text, /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(text)?.[1], text.includes('{') ? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1) : undefined];
  for (const candidate of attempts) {
    if (!candidate) continue;
    try { return JSON.parse(candidate) as unknown; } catch { /* try the next form */ }
  }
  throw new Error('The reply does not contain a JSON object.');
}

export type ProposalCheck = { ok: true; proposal: TeamProposal } | { ok: false; error: string };

/**
 * Validate a reply: the TeamProposal schema, then the rules that need Studio's records (listed
 * agents, existing templates, the team rules and the requested deliverables).
 */
export function checkProposal(reply: string | null, request: ProposalRequest, templates: { team: (id: string, version: number) => boolean; agent: (id: string, version: number) => boolean }): ProposalCheck {
  if (!reply?.trim()) return { ok: false, error: 'The reply was empty.' };
  let value: unknown;
  try { value = extractJson(reply); } catch (error) { return { ok: false, error: (error as Error).message }; }
  const wrapped = z.object({ team_proposal: z.unknown() }).loose().safeParse(value);
  if (wrapped.success && wrapped.data.team_proposal !== undefined) value = wrapped.data.team_proposal;
  const parsed = teamProposalSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: clip(z.prettifyError(parsed.error), ERROR_LIMIT) };
  const proposal = parsed.data;
  const problems: string[] = [];
  const agents = new Set(request.agents.map(agent => agent.agent_ref));
  proposal.bindings.forEach((binding, index) => {
    if (!agents.has(binding.agent_ref)) problems.push(`bindings[${index}].agent_ref "${binding.agent_ref}" is not one of the available agents.`);
  });
  if (proposal.source_template && !templates.team(proposal.source_template.template_id, proposal.source_template.version)) {
    problems.push(`source_template ${proposal.source_template.template_id} version ${proposal.source_template.version} is not a listed team template.`);
  }
  proposal.roles.forEach((role, index) => {
    if (role.agent_template_ref && !templates.agent(role.agent_template_ref.template_id, role.agent_template_ref.version)) {
      problems.push(`roles[${index}].agent_template_ref is not a listed agent template.`);
    }
  });
  const validation = validateTeam({ mode: 'template', roles: proposal.roles, relationships: proposal.relationships.map(edge => ({ ...edge })),
    requestedDeliverables: request.project.deliverables.map(item => ({ name: item.name })) });
  for (const issue of validation.issues) if (issue.severity === 'error') problems.push(issue.message);
  return problems.length ? { ok: false, error: clip(problems.join('\n'), ERROR_LIMIT) } : { ok: true, proposal };
}

/** The proposal as a draft body: suggested bindings filled in, knowledge kept for roles that keep their key. */
export function proposalDraftBody(proposal: TeamProposal, basisKnowledge: ReadonlyMap<string, string[]>): TeamDraftBody {
  const bindings = new Map(proposal.bindings.map(binding => [binding.role_key, binding.agent_ref]));
  return {
    roles: proposal.roles.map(({ rationale: _rationale, ...role }) => ({ ...role, agent_ref: bindings.get(role.key) ?? null, knowledge: basisKnowledge.get(role.key) ?? [] })),
    relationships: proposal.relationships.map(edge => ({ from: edge.from, to: edge.to, type: edge.type, ...(edge.stage !== undefined ? { stage: edge.stage } : {}),
      ...(edge.label !== undefined ? { label: edge.label } : {}) })),
    stages: proposal.stages,
  };
}

const sourceOf = (task: StudioTask) => z.object({ proposal_id: z.string(), attempt: z.number().int(), agent_ref: z.string(), previous_error: z.string().optional() }).safeParse(task.source).data;

export class TeamProposer implements TaskModeHandler {
  constructor(private readonly store: Store, private readonly agents: Pick<AgentDirectory, 'list'>, private readonly conductor: Conductor) {
    conductor.registerMode('team_proposal', this);
    conductor.onJournalEvent((task, event) => this.progress(task, event));
  }

  /** Ask for a proposal. Throws ProposalError when it cannot be asked. */
  async propose(project: Project, input: { agentRef?: string | undefined; actor: AuditActor; actingSubject?: string | undefined; idempotencyKey?: string | undefined }): Promise<TeamProposalRecord> {
    const open = this.store.proposals.open(project.id);
    if (open.length) throw new ProposalError('A team proposal is already being prepared', 409, 'PROPOSAL_IN_PROGRESS', { proposal_id: open[0]!.id });
    const current = this.store.team.current(project.id);
    const draft = this.store.team.draft(project.id);
    const team = draft ?? current;
    const coordinator = team?.body.roles.find(role => role.coordinator && role.agent_ref);
    const agentRef = input.agentRef ?? coordinator?.agent_ref ?? undefined;
    if (!agentRef) throw new ProposalError('Bind a coordinator or choose an agent to propose the team', 409, 'NO_COORDINATOR');
    const list = await this.agents.list({ actingSubject: input.actingSubject });
    if (list.magnus.state !== 'ok') throw new ProposalError(`Magnus is unavailable: ${list.magnus.error ?? 'no answer'}`, 503, 'MAGNUS_UNAVAILABLE');
    const agent = list.agents.find(item => item.agent_ref === agentRef);
    if (!agent) throw new ProposalError('Magnus does not manage this agent', 422, 'UNKNOWN_AGENT', { agent_ref: agentRef });
    if (!agent.available) throw new ProposalError(`${agent.display_name} is not available${agent.error ? `: ${agent.error}` : ''}`, 409, 'AGENT_UNAVAILABLE', { agent_ref: agentRef });

    const request = this.request(project, team, list.agents);
    const roleKey = team?.body.roles.find(role => role.agent_ref === agentRef)?.key ?? null;
    const record = this.store.tx(() => {
      const created = this.store.proposals.create({ projectId: project.id, agentRef, roleKey, createdBy: input.actor.userId, request,
        basis: { current_revision: current?.revision ?? null, draft_revision: draft?.revision ?? null, source_template: team?.source_template ?? null } });
      const started = this.attempt(created, 1, undefined, input.actor.userId);
      this.store.record(input.actor, 'team.propose', { type: 'project', id: project.id }, { proposal_id: created.id, agent_ref: agentRef }, input.idempotencyKey);
      return started;
    });
    this.conductor.kick();
    return record;
  }

  private request(project: Project, team: ReturnType<Store['team']['current']>, agents: Awaited<ReturnType<AgentDirectory['list']>>['agents']): ProposalRequest {
    const latest = (kind: 'team' | 'agent') => this.store.templates.list({ kind, archived: 'false' }).slice(0, TEMPLATE_LIMIT)
      .map(summary => ({ summary, version: this.store.templates.version(summary.id, summary.latest_version) }));
    const source = team?.source_template ? this.store.templates.summary(team.source_template.template_id) : undefined;
    return {
      project: { name: project.name, audience: project.audience, constraints: project.constraints, brief_md: project.brief_md,
        deliverables: project.deliverables.map(item => ({ name: item.name, kind: item.kind, formats: item.formats, stage: item.stage })) },
      basis_team: team ? {
        source_template: source && team.source_template ? `${source.name} v${team.source_template.version}` : null,
        roles: team.body.roles.map(role => ({ key: role.key, name: role.name, coordinator: role.coordinator, agent_ref: role.agent_ref })),
      } : null,
      team_templates: latest('team').flatMap(({ summary, version }) => version?.kind === 'team' ? [{
        template_id: summary.id, version: summary.latest_version, name: summary.name, category: summary.category, purpose: summary.purpose,
        roles: version.body.roles.map(role => ({ key: role.key, name: role.name, coordinator: role.coordinator })),
      }] : []),
      agent_templates: latest('agent').map(({ summary }) => ({ template_id: summary.id, version: summary.latest_version, name: summary.name, category: summary.category, purpose: summary.purpose })),
      agents: agents.slice(0, AGENT_LIMIT).map(agent => ({ agent_ref: agent.agent_ref, display_name: agent.display_name, backend: agent.backend, available: agent.available,
        roles: agent.roles.map(role => `${role.project_name} / ${role.role_name}`) })),
    };
  }

  /** Queue one attempt's task. Call inside a transaction. */
  private attempt(proposal: TeamProposalRecord, attempt: number, previousError: string | undefined, createdBy: string): TeamProposalRecord {
    const task = this.conductor.queueTask({
      projectId: proposal.project_id, title: attempt === 1 ? 'Propose a team from the brief' : 'Propose a team from the brief (retry)', mode: 'team_proposal',
      roleKey: proposal.role_key, bindingId: this.store.team.ensureBinding(proposal.agent_ref).id, assignmentRevision: null,
      source: { proposal_id: proposal.id, attempt, agent_ref: proposal.agent_ref, ...(previousError ? { previous_error: previousError } : {}) }, createdBy,
    });
    const updated = this.store.proposals.addAttempt(proposal.id, task.id, attempt === 1 ? 'Waiting for the agent to start' : 'Asked the agent again with the validation error');
    this.store.emit(proposal.project_id, 'team.proposal.updated', { proposal: updated });
    return updated;
  }

  agent(task: StudioTask): { agentRef: string } | { error: string } {
    const source = sourceOf(task);
    return source && this.store.proposals.get(source.proposal_id) ? { agentRef: source.agent_ref } : { error: 'The team proposal task has no proposal.' };
  }

  compose(task: StudioTask, input: { project: Project; dispatch: 'mission' | 'turn'; now: Date }): ModeRequest {
    const source = sourceOf(task);
    const stored = source ? this.store.proposals.stored(source.proposal_id) : undefined;
    // agent() already refused a task without a proposal.
    if (!source || !stored) throw new Error('The team proposal task has no proposal');
    return composeProposal({ taskId: task.id, request: stored.request as ProposalRequest, hivememProjectId: hivememProjectId(input.project.id), previousError: source.previous_error, now: input.now });
  }

  /** Journal progress: the agent started working. Called inside the event's transaction. */
  private progress(task: StudioTask, event: ArdentTaskEvent): void {
    if (task.mode !== 'team_proposal') return;
    const source = sourceOf(task);
    const proposal = source ? this.store.proposals.get(source.proposal_id) : undefined;
    if (!proposal || proposal.task_id !== task.id || FINISHED_PROPOSAL_STATES.includes(proposal.state) || proposal.state === 'running') return;
    const started = event.kind === 'model_started' || event.kind === 'tool_attempt'
      || (event.kind === 'state' && z.object({ to: z.literal('running') }).safeParse(event.detail).success);
    if (!started) return;
    const updated = this.store.proposals.setProgress(proposal.id, 'running', source!.attempt > 1 ? 'The agent is correcting its proposal' : 'The agent is preparing a proposal');
    this.store.emit(proposal.project_id, 'team.proposal.updated', { proposal: updated });
  }

  finished(task: StudioTask, outcome: { state: TaskState; reply: string | null; error: string | null }): void {
    const source = sourceOf(task);
    const stored = source ? this.store.proposals.stored(source.proposal_id) : undefined;
    if (!source || !stored || stored.record.task_id !== task.id || FINISHED_PROPOSAL_STATES.includes(stored.record.state)) return;
    const { record } = stored;
    const emit = (proposal: TeamProposalRecord) => this.store.emit(record.project_id, 'team.proposal.updated', { proposal });
    if (outcome.state === 'cancelled') {
      this.store.proposals.settleAttempt(record.id, 'cancelled', outcome.error);
      emit(this.store.proposals.finish(record.id, { state: 'cancelled', progress: 'The proposal was cancelled', error: null }));
      return;
    }
    if (outcome.state !== 'completed' && outcome.state !== 'partial') {
      const why = `The agent could not answer: ${outcome.error ?? `the task ended ${outcome.state}`}`;
      this.store.proposals.settleAttempt(record.id, 'failed', why);
      emit(this.store.proposals.finish(record.id, { state: 'failed', progress: 'The agent could not answer', error: why }));
      return;
    }
    const check = checkProposal(outcome.reply, stored.request as ProposalRequest, {
      team: (id, version) => this.store.templates.version(id, version)?.kind === 'team',
      agent: (id, version) => this.store.templates.version(id, version)?.kind === 'agent',
    });
    if (check.ok) {
      this.store.proposals.settleAttempt(record.id, 'valid', null);
      const basis = record.basis.draft_revision !== null ? this.store.team.revision(record.project_id, record.basis.draft_revision)
        : record.basis.current_revision !== null ? this.store.team.revision(record.project_id, record.basis.current_revision) : undefined;
      const knowledge = new Map((basis?.body.roles ?? []).map(role => [role.key, role.knowledge]));
      emit(this.store.proposals.finish(record.id, { state: 'ready', progress: `Proposed ${check.proposal.roles.length} role${check.proposal.roles.length === 1 ? '' : 's'}`,
        proposal: check.proposal, draftBody: proposalDraftBody(check.proposal, knowledge) }));
      return;
    }
    const settled = this.store.proposals.settleAttempt(record.id, 'invalid', check.error);
    if (settled.attempts.length < MAX_PROPOSAL_ATTEMPTS) {
      this.attempt(settled, settled.attempts.length + 1, check.error, 'conductor');
      return;
    }
    emit(this.store.proposals.finish(record.id, { state: 'failed', progress: 'The agent did not return a valid proposal',
      error: `The agent's reply was not a valid team proposal after ${MAX_PROPOSAL_ATTEMPTS} attempts: ${check.error}` }));
  }
}
