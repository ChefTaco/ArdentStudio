import type { z } from 'zod';
import type { Project } from '../../db/repos/projects.js';
import type { createProjectRequestSchema, listProjectsQuerySchema, projectSummarySchema, updateProjectRequestSchema } from '../../shared/browser.js';
import { publicTask } from '../../conductor/conductor.js';
import { validateAssignment } from '../../team/service.js';
import { actorOf, requireActive, requireProject, type AppDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import type { createRouter } from '../routing.js';

type Summary = z.infer<typeof projectSummarySchema>;

export function projectRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  const { store } = deps;

  const summary = (project: Project): Summary => {
    const { deliverables, brief_md, ...rest } = project;
    const team = store.team.draft(project.id) ?? store.team.current(project.id);
    const latest = store.events.latest(project.id);
    return {
      ...rest,
      brief_excerpt: brief_md.replace(/\s+/g, ' ').trim().slice(0, 240),
      file_count: store.files.count(project.id),
      deliverable_count: deliverables.length,
      team: { revision: store.team.pointers(project.id).current, role_count: team?.body.roles.length ?? 0, bound_count: team?.body.roles.filter(role => role.agent_ref).length ?? 0 },
      last_activity: latest ? { type: latest.type, at: latest.at } : null,
    };
  };

  register('GET', '/projects', (_c, { query }) => {
    const filter = query as z.infer<typeof listProjectsQuerySchema>;
    return { body: { projects: store.projects.list(filter).map(summary) } };
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
      files: store.files.list(id),
      current: store.team.current(id) ?? null,
      draft: store.team.draft(id) ?? null,
      conversations: store.room.conversations(id),
      tasks: store.tasks.active(id).map(publicTask),
      decisions: store.room.decisions(id),
      activity: activityOf(id),
      layout: store.room.layout(id) ?? null,
    }))();
    const { current, draft, ...rest } = view;
    const subject = draft ?? current;
    const validation = subject ? await validateAssignment(view.project, subject.body, deps.agents, { actingSubject: principal?.subject }) : null;
    return { body: { ...rest, team: { current, draft, validation } } };
  });
}
