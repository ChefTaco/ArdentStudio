import { afterEach, describe, expect, it } from 'vitest';
import { createProject, createTestContext, json, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(() => ctx?.close());

describe('projects', () => {
  it('creates a project with its requested deliverables and HiveMem workspace', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx, {
      constraints: ['Rated for teens'], tags: ['adventure'],
      deliverables: [{ name: 'Adventure Text', kind: 'document', formats: ['docx', 'pdf'] }, { name: 'Region Map', kind: 'map', formats: ['svg'], stage: 'create' }],
    });
    expect(project).toMatchObject({ status: 'active', created_by: 'operator', hivemem: { state: 'pending' } });
    expect(project.deliverables.map((item: { name: string }) => item.name)).toEqual(['Adventure Text', 'Region Map']);
    expect(ctx.store.projects.get(project.id)!.hivemem.state).toBe('ready');
    expect(ctx.hivemem.workspaces.has(project.hivemem.workspace_id)).toBe(true);
    expect(project.hivemem.workspace_id).toBe(`ardentstudio-${project.id.toLowerCase()}`);
    const audit = ctx.store.audit.list({ targetId: project.id });
    expect(audit.map(entry => entry.action)).toEqual(['project.create']);
    expect(audit[0]).toMatchObject({ actor_user_id: 'operator', actor_subject: 'subject-operator' });
  });

  it('keeps the project pending and retries when HiveMem is down', async () => {
    ctx = await createTestContext();
    ctx.hivemem.failWorkspace = true;
    const project = await createProject(ctx);
    expect(ctx.store.projects.get(project.id)!.hivemem).toMatchObject({ state: 'failed', error: 'HiveMem unavailable' });
    ctx.hivemem.failWorkspace = false;
    await ctx.knowledge.idle(); await ctx.knowledge.runPass();
    expect(ctx.store.projects.get(project.id)!.hivemem).toMatchObject({ state: 'ready', error: null });
  });

  it('lists, searches and updates projects, keeping deliverable ids stable', async () => {
    ctx = await createTestContext();
    const first = await createProject(ctx, { tags: ['maps'], deliverables: [{ name: 'Region Map', kind: 'map', formats: ['svg'] }] });
    await createProject(ctx, { name: 'Battery Recycling Brief', brief_md: 'Research the market.' });
    const search = await json(await ctx.call('GET', '/projects?q=maps'));
    expect(search.projects.map((item: { id: string }) => item.id)).toEqual([first.id]);
    expect(search.projects[0]).toMatchObject({ file_count: 0, deliverable_count: 1, team: { revision: null, role_count: 0 }, link_count: 0,
      open_questions: 0, review_pending: 0, active_tasks: 0, last_activity: { type: 'project.created', text: 'operator created the project' } });
    const response = await ctx.call('PATCH', `/projects/${first.id}`, { body: { name: 'Renamed', deliverables: [{ name: 'Region Map', kind: 'map', formats: ['svg', 'png'] }, { name: 'Handout', kind: 'document', formats: ['pdf'] }] } });
    expect(response.status).toBe(200);
    const updated = await json(response);
    expect(updated.name).toBe('Renamed');
    expect(updated.deliverables[0].id).toBe(first.deliverables[0].id);
    expect(updated.deliverables[0].formats).toEqual(['svg', 'png']);
    expect((await ctx.call('PATCH', `/projects/${first.id}`, { body: { unknown: true } })).status).toBe(400);
  });

  it('archives read-only after active tasks finish, and reopens', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const task = ctx.store.tasks.create({ projectId: project.id, title: 'Draft the outline', mode: 'turn', createdBy: 'operator' });
    const blocked = await ctx.call('POST', `/projects/${project.id}/archive`);
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).error).toMatchObject({ code: 'TASKS_ACTIVE', details: { tasks: [{ id: task.id, state: 'queued' }] } });
    ctx.store.tasks.setState(task.id, 'completed');
    const archived = await json(await ctx.call('POST', `/projects/${project.id}/archive`));
    expect(archived).toMatchObject({ status: 'archived' });
    expect(archived.archived_at).not.toBeNull();
    expect((await ctx.call('PATCH', `/projects/${project.id}`, { body: { name: 'Nope' } })).status).toBe(409);
    expect((await ctx.call('PATCH', `/projects/${project.id}`, { body: { last_area: 'review' } })).status).toBe(200);
    expect((await json(await ctx.call('GET', '/projects'))).projects).toEqual([]);
    expect((await json(await ctx.call('GET', '/projects?status=archived'))).projects).toHaveLength(1);
    expect(await json(await ctx.call('POST', `/projects/${project.id}/reopen`))).toMatchObject({ status: 'active', archived_at: null });
  });

  it('replays a repeated idempotency key and refuses its reuse for a different request', async () => {
    ctx = await createTestContext();
    const body = { name: 'Once' };
    const first = await ctx.call('POST', '/projects', { body, key: 'fixture-idempotent-1' });
    const again = await ctx.call('POST', '/projects', { body, key: 'fixture-idempotent-1' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect((await json(again)).id).toBe((await json(first)).id);
    expect(ctx.store.projects.list({ status: 'all' })).toHaveLength(1);
    const reused = await ctx.call('POST', '/projects', { body: { name: 'Different' }, key: 'fixture-idempotent-1' });
    expect(reused.status).toBe(409);
    expect((await json(reused)).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await ctx.call('POST', '/projects', { body, key: null })).status).toBe(400);
  });

  it('serves a snapshot consistent with the stream cursor', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const snapshot = await json(await ctx.call('GET', `/projects/${project.id}/snapshot`));
    expect(snapshot.seq).toBe(ctx.store.events.cursor(project.id).lastSeq);
    expect(snapshot).toMatchObject({ project: { id: project.id }, files: [], team: { current: null, draft: null, validation: null } });
    expect((await ctx.call('GET', '/projects/prj_01JUNKJUNKJUNKJUNKJUNKJUNK/snapshot')).status).toBe(404);
  });
});
