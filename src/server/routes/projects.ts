import type { z } from 'zod';
import type { Principal } from '../../auth/authenticator.js';
import { isStudioAdmin, projectRole, roleAtLeast } from '../../auth/project-access.js';
import type { Membership } from '../../db/repos/members.js';
import type { Project } from '../../db/repos/projects.js';
import type { createProjectRequestSchema, listProjectsQuerySchema, projectAccessSchema, projectMembersResponseSchema, projectSummarySchema,
  purgeProjectRequestSchema, putProjectMembersRequestSchema, ProjectRole, updateProjectRequestSchema } from '../../shared/browser.js';
import { publicTask } from '../../conductor/conductor.js';
import { validateAssignment } from '../../team/service.js';
import { actorOf, requireActive, requireProject, type RouteDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import type { createRouter } from '../routing.js';

type Summary = z.infer<typeof projectSummarySchema>;
type Access = z.infer<typeof projectAccessSchema>;

export function projectRoutes(register: ReturnType<typeof createRouter>, deps: RouteDeps): void {
  const { store } = deps;

  const accessOf = (principal: Principal | undefined, project: Project, role?: ProjectRole | null): Access => {
    const membership = store.members.get(project.id);
    const resolved = role ?? (principal && membership ? projectRole(principal, membership) : null);
    // The router admitted the caller, so a role is always found; viewer is only the type's fallback.
    return { mode: membership?.mode ?? 'everyone', role: resolved ?? 'viewer' };
  };

  const summary = (project: Project, access: Access): Summary => {
    const { deliverables, brief_md, ...rest } = project;
    const team = store.team.draft(project.id) ?? store.team.current(project.id);
    const current = store.team.current(project.id);
    return {
      ...rest,
      brief_excerpt: brief_md.replace(/\s+/g, ' ').trim().slice(0, 240),
      file_count: store.files.count(project.id),
      link_count: store.links.count(project.id),
      deliverable_count: deliverables.length,
      team: { revision: store.team.pointers(project.id).current, role_count: team?.body.roles.length ?? 0, bound_count: team?.body.roles.filter(role => role.agent_ref).length ?? 0 },
      ...store.summaries.counts(project.id),
      // Role names come from the published team, the one agents spoke under.
      last_activity: store.summaries.lastActivity(project.id, current?.body ?? team?.body),
      access,
    };
  };

  register('GET', '/projects', (_c, { query, principal }) => {
    const filter = query as z.infer<typeof listProjectsQuerySchema>;
    // Only projects the caller is a member of (every project open to everyone linked, too).
    const roleOf = principal ? deps.access.roles(principal) : () => null;
    const visible = new Map<string, ProjectRole>();
    let projects = store.projects.list(filter).filter(project => {
      const role = roleOf(project.id, project.created_by);
      if (role) visible.set(project.id, role);
      return role !== null;
    });
    if (filter.needs_review !== undefined) {
      const needing = store.summaries.needingReview();
      projects = projects.filter(project => needing.has(project.id) === (filter.needs_review === 'true'));
    }
    if (filter.agentRef !== undefined) {
      // Narrows the list the caller can already read; it never adds a project.
      const bound = store.team.projectsForAgent(filter.agentRef);
      projects = projects.filter(project => bound.has(project.id));
    }
    return { body: { projects: projects.map(project => summary(project, accessOf(principal, project, visible.get(project.id)))) } };
  });

  register('POST', '/projects', (_c, { body, principal, idempotencyKey }) => {
    const input = body as z.infer<typeof createProjectRequestSchema>;
    const actor = actorOf(principal);
    const project = store.tx(() => {
      const created = store.projects.create({ ...input, createdBy: actor.userId });
      store.emit(created.id, 'project.created', { project_id: created.id, name: created.name });
      store.record(actor, 'project.create', { type: 'project', id: created.id }, { name: created.name }, idempotencyKey);
      return created;
    });
    // The workspace is created in the background; hivemem.state shows the outcome and failures retry.
    void deps.knowledge.ensureWorkspace(project).then(() => deps.knowledge.kick(), () => undefined);
    return { status: 201, body: project };
  });

  register('GET', '/projects/{projectId}', (_c, { params }) => ({ body: requireProject(store, params.projectId) }));

  register('PATCH', '/projects/{projectId}', (_c, { params, body, principal, idempotencyKey }) => {
    const patch = body as z.infer<typeof updateProjectRequestSchema>;
    const project = requireProject(store, params.projectId);
    const changes = Object.keys(patch);
    if (project.status === 'archived' && changes.some(key => key !== 'last_area')) requireActive(project);
    const actor = actorOf(principal);
    const updated = store.tx(() => {
      const next = store.projects.update(project.id, patch);
      store.emit(project.id, 'project.updated', { fields: changes });
      store.record(actor, 'project.update', { type: 'project', id: project.id }, { fields: changes }, idempotencyKey);
      return next;
    });
    return { body: updated };
  });

  register('POST', '/projects/{projectId}/archive', (_c, { params, principal, idempotencyKey }) => {
    const project = requireProject(store, params.projectId);
    if (project.status === 'archived') return { body: project };
    const active = store.tasks.active(project.id);
    if (active.length) {
      throw new ApiError(409, 'TASKS_ACTIVE', 'Cancel the running tasks before archiving the project',
        { tasks: active.map(task => ({ id: task.id, title: task.title, state: task.state })) });
    }
    const actor = actorOf(principal);
    return { body: store.tx(() => {
      const archived = store.projects.setStatus(project.id, 'archived');
      store.emit(project.id, 'project.archived', {});
      store.record(actor, 'project.archive', { type: 'project', id: project.id }, {}, idempotencyKey);
      return archived;
    }) };
  });

  register('POST', '/projects/{projectId}/reopen', (_c, { params, principal, idempotencyKey }) => {
    const project = requireProject(store, params.projectId);
    if (project.status === 'active') return { body: project };
    const actor = actorOf(principal);
    return { body: store.tx(() => {
      const reopened = store.projects.setStatus(project.id, 'active');
      store.emit(project.id, 'project.reopened', {});
      store.record(actor, 'project.reopen', { type: 'project', id: project.id }, {}, idempotencyKey);
      return reopened;
    }) };
  });

  const activityOf = (projectId: string) => {
    const refs = new Map(store.team.bindings().map(binding => [binding.id, binding.agent_ref]));
    return store.room.activity(projectId).flatMap(({ project_id: _project, binding_id, ...rest }) => {
      const agent_ref = refs.get(binding_id);
      return agent_ref ? [{ binding_id, agent_ref, ...rest }] : [];
    });
  };

  register('GET', '/projects/{projectId}/snapshot', async (_c, { params, principal }) => {
    const id = requireProject(store, params.projectId).id;
    // Read the records and their cursor together, so ?after=<seq> resumes exactly after this view.
    const view = store.db.transaction(() => ({
      seq: store.events.cursor(id).lastSeq,
      project: store.projects.get(id)!,
      summary: summary(store.projects.get(id)!, accessOf(principal, store.projects.get(id)!)),
      files: store.files.list(id),
      links: store.links.list(id),
      current: store.team.current(id) ?? null,
      draft: store.team.draft(id) ?? null,
      conversations: store.room.conversations(id),
      tasks: store.tasks.active(id).map(publicTask),
      decisions: store.room.decisions(id),
      activity: activityOf(id),
      layout: store.room.layout(id) ?? null,
      team_proposals: store.proposals.open(id),
    }))();
    const { current, draft, ...rest } = view;
    const subject = draft ?? current;
    const validation = subject ? await validateAssignment(view.project, subject.body, deps.agents, { actingSubject: principal?.subject }) : null;
    return { body: { ...rest, team: { current, draft, validation } } };
  });

  // ── Membership ──
  const membersView = (project: Project, membership: Membership, principal: Principal | undefined): z.infer<typeof projectMembersResponseSchema> => ({
    project_id: project.id,
    mode: membership.mode,
    revision: membership.revision,
    members: membership.members.map(member => {
      if (member.kind === 'oathweave_role') return { kind: 'oathweave_role' as const, name: member.value, role: member.role, added_by: member.added_by, added_at: member.added_at };
      const issuer = member.issuer === '' ? null : member.issuer;
      const link = (deps.people ?? []).find(item => item.subject === member.value && (issuer === null || item.issuer === issuer));
      return { kind: 'subject' as const, subject: member.value, issuer, role: member.role, user_id: link?.localUserId ?? null, display_name: link?.displayName ?? null,
        added_by: member.added_by, added_at: member.added_at };
    }),
    access: accessOf(principal, project),
  });

  register('GET', '/projects/{projectId}/members', (_c, { params, principal }) => {
    const project = requireProject(store, params.projectId);
    return { body: membersView(project, store.members.get(project.id)!, principal) };
  });

  register('PUT', '/projects/{projectId}/members', (_c, { params, body, principal, idempotencyKey }) => {
    const input = body as z.output<typeof putProjectMembersRequestSchema>;
    const project = requireProject(store, params.projectId);
    if (!principal) throw new ApiError(401, 'UNAUTHENTICATED', 'A bearer token is required');
    const actor = actorOf(principal);
    const current = store.members.get(project.id)!;
    if (input.base_revision !== current.revision) throw new ApiError(409, 'VERSION_CONFLICT', 'The membership changed; reload it', { revision: current.revision });
    if (input.mode === 'everyone' && input.members.length) throw new ApiError(422, 'MEMBERS_NOT_ALLOWED', 'A project open to everyone linked lists no members');
    if (input.mode === 'members' && !input.members.some(member => member.role === 'owner')) throw new ApiError(422, 'OWNER_REQUIRED', 'List at least one owner');
    if (!isStudioAdmin(principal)) {
      // The caller must still own the project afterwards, so nobody locks themselves out by mistake.
      const after: Membership = { mode: input.mode, revision: current.revision + 1, createdBy: current.createdBy, members: input.members.map(member => ({
        kind: member.kind, issuer: member.kind === 'subject' ? member.issuer ?? '' : '', value: member.kind === 'subject' ? member.subject : member.name,
        role: member.role, added_by: actor.userId, added_at: '' })) };
      if (!roleAtLeast(projectRole(principal, after), 'owner')) throw new ApiError(422, 'SELF_LOCKOUT', 'You would no longer own this project; list yourself as an owner');
    }
    const updated = store.tx(() => {
      const next = store.members.replace(project.id, input.mode, input.members, actor.userId);
      store.emit(project.id, 'project.members.updated', { mode: next.mode, revision: next.revision });
      store.record(actor, 'project.members', { type: 'project', id: project.id }, {
        mode: next.mode, revision: next.revision,
        members: next.members.map(member => ({ kind: member.kind, issuer: member.issuer || null, value: member.value, role: member.role })),
      }, idempotencyKey);
      return next;
    });
    return { body: membersView(project, updated, principal) };
  });

  register('GET', '/people', () => ({
    body: { people: (deps.people ?? []).map(link => ({ user_id: link.localUserId, subject: link.subject, issuer: link.issuer, display_name: link.displayName ?? null })) },
  }));

  // ── Purge ──
  register('POST', '/projects/{projectId}/purge', (_c, { params, body, principal, idempotencyKey }) => {
    const { confirm_name: confirmName } = body as z.infer<typeof purgeProjectRequestSchema>;
    const project = requireProject(store, params.projectId);
    if (project.status !== 'archived') throw new ApiError(409, 'PROJECT_NOT_ARCHIVED', 'Archive the project before purging it');
    if (confirmName !== project.name) throw new ApiError(422, 'CONFIRMATION_MISMATCH', 'confirm_name must be the exact project name');
    const active = store.tasks.active(project.id);
    if (active.length) {
      throw new ApiError(409, 'TASKS_ACTIVE', 'Cancel the running tasks before purging the project',
        { tasks: active.map(task => ({ id: task.id, title: task.title, state: task.state })) });
    }
    // Portraits are shown in every project; one that uses a file of this project must stop first.
    const agents = [...new Set(store.files.list(project.id, 'avatar').flatMap(file => store.files.avatarUses(file.id)))];
    if (agents.length) throw new ApiError(409, 'FILE_IN_USE', 'Change the agent portraits that use files of this project first', { agents });
    const actor = actorOf(principal);
    const purgedAt = store.clock.now().toISOString();
    const result = store.tx(() => {
      const rows = store.purgeProject(project.id);
      store.record(actor, 'project.purge', { type: 'project', id: project.id }, {
        name: project.name, archived_at: project.archived_at, removed: rows.removed, sources_retiring: rows.sourcesRetiring,
      }, idempotencyKey);
      return rows;
    });
    // After the commit: open streams hear it and close; bytes nothing else references go now.
    deps.bus.publishEphemeral(project.id, 'project.purged', { project_id: project.id, at: purgedAt });
    for (const sha of result.blobs) deps.blobs.removeIfUnreferenced(sha);
    for (const id of result.imports) void deps.blobs.removePartial(id).catch(() => undefined);
    if (result.sourcesRetiring) deps.knowledge.kick();
    return { body: { project_id: project.id, name: project.name, purged_at: purgedAt, removed: result.removed, knowledge: { sources_retiring: result.sourcesRetiring } } };
  });
}
