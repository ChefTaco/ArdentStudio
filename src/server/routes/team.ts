import type { z } from 'zod';
import type { Project } from '../../db/repos/projects.js';
import { TeamConflictError, type TeamBody } from '../../db/repos/team.js';
import type { TeamTemplateBody } from '../../db/repos/templates.js';
import { TemplateConflictError } from '../../db/repos/templates.js';
import {
  teamProposalIdSchema, type applyTemplateRequestSchema, type proposeTeamRequestSchema, type publishTeamRequestSchema, type putTeamDraftRequestSchema,
  type saveAsTemplateRequestSchema, type teamDraftBodySchema, type validateTeamRequestSchema,
} from '../../shared/browser.js';
import { ProposalError } from '../../team/proposals.js';
import { teamState, validateAssignment } from '../../team/service.js';
import { actorOf, requireActive, requireProject, type AppDeps } from '../deps.js';
import { ApiError, notFound } from '../errors.js';
import type { createRouter } from '../routing.js';
import { checkTemplateBody, requireTemplate } from './templates.js';

type TeamBodyInput = z.infer<typeof teamDraftBodySchema>;

export function teamRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  const { store } = deps;

  /** Resolve bindings and check knowledge references. Does not write. */
  const resolveBody = (project: Project, input: TeamBodyInput): TeamBody => {
    const projectFiles = new Set(store.files.list(project.id).map(file => file.id));
    for (const role of input.roles) {
      const foreign = role.knowledge.filter(id => !projectFiles.has(id));
      if (foreign.length) throw new ApiError(422, 'UNKNOWN_FILE', `Role ${role.key} names files that are not in this project`, { files: foreign });
    }
    return {
      roles: input.roles.map(role => ({ ...role, binding_id: role.agent_ref ? store.team.binding(role.agent_ref)?.id ?? null : null })),
      relationships: input.relationships,
      stages: input.stages,
    };
  };
  /** Inside a transaction: give every bound agent a stable binding id. */
  const bind = (body: TeamBody): TeamBody => ({
    ...body,
    roles: body.roles.map(role => ({ ...role, binding_id: role.agent_ref ? store.team.ensureBinding(role.agent_ref).id : null })),
  });
  const context = (principal: { subject: string } | undefined) => ({ actingSubject: principal?.subject });

  register('GET', '/projects/{projectId}/team', async (_c, { params, principal }) => {
    const project = requireProject(store, params.projectId);
    return { body: await teamState(store, project, deps.agents, context(principal)) };
  });

  register('PUT', '/projects/{projectId}/team/draft', async (_c, { params, body, principal, idempotencyKey }) => {
    const project = requireActive(requireProject(store, params.projectId));
    const input = body as z.infer<typeof putTeamDraftRequestSchema>;
    const actor = actorOf(principal);
    if (input.source_template) {
      const version = store.templates.version(input.source_template.template_id, input.source_template.version);
      if (!version || version.kind !== 'team') throw new ApiError(422, 'UNKNOWN_TEMPLATE', 'source_template is not a team template version');
    }
    const resolved = resolveBody(project, input.body);
    try {
      store.tx(() => {
        const draft = store.team.saveDraft(project.id, { baseRevision: input.base_revision, body: bind(resolved), sourceTemplate: input.source_template, userId: actor.userId });
        store.emit(project.id, 'team.draft.updated', { revision: draft.revision });
        store.record(actor, 'team.draft.save', { type: 'project', id: project.id }, { revision: draft.revision, roles: draft.body.roles.length }, idempotencyKey);
      });
    } catch (error) {
      if (error instanceof TeamConflictError) throw new ApiError(409, 'TEAM_REVISION_CONFLICT', error.message, { current_revision: store.team.pointers(project.id).current });
      throw error;
    }
    return { body: await teamState(store, project, deps.agents, context(principal)) };
  });

  register('POST', '/projects/{projectId}/team/validate', async (_c, { params, body, principal }) => {
    const project = requireProject(store, params.projectId);
    const input = body as z.infer<typeof validateTeamRequestSchema>;
    const subject = input.body ? resolveBody(project, input.body)
      : (store.team.draft(project.id) ?? store.team.current(project.id))?.body ?? { roles: [], relationships: [], stages: [] };
    return { body: await validateAssignment(project, subject, deps.agents, context(principal)) };
  });

  register('POST', '/projects/{projectId}/team/publish', async (_c, { params, body, principal, idempotencyKey }) => {
    const project = requireActive(requireProject(store, params.projectId));
    const { draft_revision: revision } = body as z.infer<typeof publishTeamRequestSchema>;
    const draft = store.team.draft(project.id);
    if (!draft || draft.revision !== revision) throw new ApiError(409, 'TEAM_REVISION_CONFLICT', `r${revision} is not the current draft`, { draft_revision: draft?.revision ?? null });
    const validation = await validateAssignment(project, draft.body, deps.agents, context(principal));
    if (!validation.can_publish) throw new ApiError(409, 'TEAM_INVALID', 'Fix the errors before publishing', { validation });
    const actor = actorOf(principal);
    try {
      store.tx(() => {
        // Saving a draft keeps its revision number, so the number alone cannot show that the body
        // changed while Magnus was asked for agent facts. Only the body that was validated is published.
        if (JSON.stringify(store.team.draft(project.id)?.body) !== JSON.stringify(draft.body)) {
          throw new TeamConflictError(`Draft r${revision} changed while it was being validated`);
        }
        const previous = store.team.pointers(project.id).current;
        const published = store.team.publish(project.id, revision, actor.userId);
        store.emit(project.id, 'team.revision.published', { revision: published.revision, previous_revision: previous });
        store.record(actor, 'team.publish', { type: 'project', id: project.id }, { revision: published.revision, previous_revision: previous }, idempotencyKey);
      });
    } catch (error) {
      if (error instanceof TeamConflictError) throw new ApiError(409, 'TEAM_REVISION_CONFLICT', error.message);
      throw error;
    }
    // Newly bound agents get their status now, not at the next 30-second probe.
    void deps.conductor.probe();
    return { body: await teamState(store, project, deps.agents, context(principal)) };
  });

  register('POST', '/projects/{projectId}/team/apply-template', async (_c, { params, body, principal, idempotencyKey }) => {
    const project = requireActive(requireProject(store, params.projectId));
    const input = body as z.infer<typeof applyTemplateRequestSchema>;
    const { id, kind } = requireTemplate(store, input.template_id);
    if (kind !== 'team') throw new ApiError(422, 'NOT_A_TEAM_TEMPLATE', 'Only team templates can be applied to a project');
    if (store.templates.summary(id)!.archived) throw new ApiError(409, 'TEMPLATE_ARCHIVED', 'The template is archived');
    const version = store.templates.version(id, input.version);
    if (!version || version.kind !== 'team') throw notFound('Template version');
    const pointers = store.team.pointers(project.id);
    if (pointers.draft && !input.replace_draft) throw new ApiError(409, 'DRAFT_EXISTS', 'The project has a draft; send replace_draft to overwrite it', { draft_revision: pointers.draft });
    const teamBody: TeamBody = {
      roles: version.body.roles.map(role => ({ ...role, agent_ref: null, binding_id: null, knowledge: [] })),
      relationships: version.body.relationships,
      stages: version.body.stages,
    };
    const actor = actorOf(principal);
    store.tx(() => {
      const draft = store.team.saveDraft(project.id, { baseRevision: pointers.current, body: teamBody, sourceTemplate: { template_id: id, version: version.version }, userId: actor.userId });
      store.emit(project.id, 'team.draft.updated', { revision: draft.revision, source_template: { template_id: id, version: version.version } });
      store.record(actor, 'team.apply_template', { type: 'project', id: project.id }, { template_id: id, version: version.version, revision: draft.revision }, idempotencyKey);
    });
    return { body: await teamState(store, project, deps.agents, context(principal)) };
  });

  register('POST', '/projects/{projectId}/team/propose', async (_c, { params, body, principal, idempotencyKey }) => {
    const project = requireActive(requireProject(store, params.projectId));
    const input = body as z.infer<typeof proposeTeamRequestSchema>;
    try {
      const proposal = await deps.proposer.propose(project, { agentRef: input.agent_ref, actor: actorOf(principal), actingSubject: principal?.subject, idempotencyKey });
      return { status: 201, body: proposal };
    } catch (error) {
      if (error instanceof ProposalError) throw new ApiError(error.status, error.code, error.message, error.details);
      throw error;
    }
  });

  register('GET', '/projects/{projectId}/team/proposals', (_c, { params }) => ({ body: { proposals: store.proposals.list(requireProject(store, params.projectId).id) } }));

  register('GET', '/projects/{projectId}/team/proposals/{proposalId}', (_c, { params }) => {
    const project = requireProject(store, params.projectId);
    const id = teamProposalIdSchema.safeParse(params.proposalId);
    const proposal = id.success ? store.proposals.get(id.data) : undefined;
    if (!proposal || proposal.project_id !== project.id) throw notFound('Team proposal');
    return { body: proposal };
  });

  register('POST', '/projects/{projectId}/team/save-as-template', (_c, { params, body, principal, idempotencyKey }) => {
    const project = requireProject(store, params.projectId);
    const input = body as z.infer<typeof saveAsTemplateRequestSchema>;
    const revision = input.from === 'draft' ? store.team.draft(project.id) : store.team.current(project.id);
    if (!revision) throw new ApiError(404, 'NOT_FOUND', input.from === 'draft' ? 'The project has no draft team' : 'The project has no published team');
    // Bindings and project knowledge stay with the project.
    const template: TeamTemplateBody = {
      name: input.name, category: input.category, purpose: input.purpose, example_uses: [],
      roles: revision.body.roles.map(({ agent_ref: _agent, binding_id: _binding, knowledge: _knowledge, ...role }) => role),
      relationships: revision.body.relationships, stages: revision.body.stages, integrations: ['hivemem'], runtime_req: { ardent: null, backend: 'any' },
    };
    checkTemplateBody(store, 'team', template);
    const actor = actorOf(principal);
    let id: string;
    try {
      id = store.tx(() => {
        if (input.template_id) {
          const existing = requireTemplate(store, input.template_id);
          const summary = store.templates.summary(existing.id)!;
          if (existing.kind !== 'team' || summary.source !== 'user') throw new ApiError(409, 'NOT_A_USER_TEAM_TEMPLATE', 'New versions from a project go to your own team templates');
          if (input.base_version === undefined) throw new ApiError(400, 'VALIDATION_ERROR', 'base_version is required with template_id');
          const version = store.templates.addVersion('team', existing.id, { baseVersion: input.base_version, body: template, changelog: input.changelog, createdBy: actor.userId });
          store.record(actor, 'template.version', { type: 'template', id: existing.id }, { version, from_project: project.id, from_revision: revision.revision }, idempotencyKey);
          return existing.id;
        }
        const slug = input.slug ?? store.templates.freeSlug('team', input.name);
        const created = store.templates.create('team', { slug, source: 'user', body: template, changelog: input.changelog, createdBy: actor.userId });
        store.record(actor, 'template.create', { type: 'template', id: created }, { kind: 'team', slug, from_project: project.id, from_revision: revision.revision }, idempotencyKey);
        return created;
      });
    } catch (error) {
      if (error instanceof TemplateConflictError) throw new ApiError(409, 'VERSION_CONFLICT', error.message);
      throw error;
    }
    return { status: 201, body: store.templates.detail(id) };
  });
}
