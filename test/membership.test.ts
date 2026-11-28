import { afterEach, describe, expect, it } from 'vitest';
import { parseSseStream, type SseEvent } from '@hivemagnus/hive-common/sse';
import { ARDENT_STUDIO_API_PREFIX, PEOPLE_SEARCH_LIMIT, projectMembersResponseSchema } from '../src/shared/browser.js';
import { createProject, createTestContext, json, LINKS, NOT_ADMIN, profile, publishTeam, type TestContext } from './helpers.js';

let ctx: TestContext;
const open: Array<() => void> = [];
afterEach(() => { for (const close of open.splice(0)) close(); return ctx?.close(); });

/** The project creator (operator) and another linked person (member), neither a Studio admin. */
const people = async () => ({
  owner: await ctx.token({ permissions: NOT_ADMIN }),
  member: await ctx.token({ sub: 'subject-member', permissions: NOT_ADMIN }),
  reviewer: await ctx.token({ sub: 'subject-member', permissions: NOT_ADMIN, roles: ['studio-reviewers'] }),
  admin: await ctx.token(),
});

const upload = (projectId: string, token: string) =>
  ctx.call('POST', `/projects/${projectId}/files?name=notes.md`, { token, raw: '# Notes', headers: { 'content-type': 'text/markdown' } });

async function restrict(projectId: string, token: string, members: unknown[], base?: number) {
  const revision = base ?? (await json(await ctx.call('GET', `/projects/${projectId}/members`, { token }))).revision;
  return ctx.call('PUT', `/projects/${projectId}/members`, { token, body: { base_revision: revision, mode: 'members', members } });
}

async function connect(projectId: string, token: string) {
  const controller = new AbortController();
  const response = await ctx.app.request(`${ARDENT_STUDIO_API_PREFIX}/projects/${projectId}/stream`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  const close = () => controller.abort();
  open.push(close);
  if (response.status !== 200) return { response, next: async () => undefined };
  const iterator = parseSseStream(response.body!, { requireData: true })[Symbol.asyncIterator]();
  return {
    response,
    next: async (): Promise<SseEvent | undefined> => {
      const result = await Promise.race([iterator.next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream timeout')), 3000))]);
      return result.done ? undefined : result.value;
    },
  };
}

describe('project membership', () => {
  it('keeps a project open to everyone linked by default: the creator owns it, others edit', async () => {
    ctx = await createTestContext();
    const { owner, member } = await people();
    const project = await createProject(ctx);
    const listed = await json(await ctx.call('GET', '/projects', { token: member }));
    expect(listed.projects.map((item: { id: string }) => item.id)).toEqual([project.id]);
    expect(listed.projects[0].access).toEqual({ mode: 'everyone', role: 'editor' });
    expect((await json(await ctx.call('GET', '/projects', { token: owner }))).projects[0].access).toEqual({ mode: 'everyone', role: 'owner' });
    const members = projectMembersResponseSchema.parse(await json(await ctx.call('GET', `/projects/${project.id}/members`, { token: member })));
    expect(members).toEqual({ project_id: project.id, mode: 'everyone', revision: 0, members: [], access: { mode: 'everyone', role: 'editor' } });
    expect((await ctx.call('PATCH', `/projects/${project.id}`, { token: member, body: { name: 'Edited by a member' } })).status).toBe(200);
    // Only an owner (or an admin) changes the membership.
    const refused = await ctx.call('PUT', `/projects/${project.id}/members`, { token: member, body: { base_revision: 0, mode: 'members', members: [{ kind: 'subject', subject: 'subject-member', role: 'owner' }] } });
    expect(refused.status).toBe(403);
    expect((await json(refused)).error).toMatchObject({ code: 'PROJECT_ROLE_REQUIRED', details: { required: 'owner', role: 'editor' } });
  });

  it('limits a project to its members on every route, the stream and its blobs', async () => {
    ctx = await createTestContext();
    const { owner, member, reviewer, admin } = await people();
    const project = await createProject(ctx);
    const other = await createProject(ctx, { name: 'Open project' });
    const file = await json(await upload(project.id, owner));
    const link = await json(await ctx.call('POST', `/projects/${project.id}/links`, { token: owner, body: { url: 'https://example.com/guide', title: 'Guide' } }));
    const decision = await json(await ctx.call('POST', `/projects/${project.id}/decisions`, { token: owner, body: { title: 'Tone', statement_md: 'Keep it light.' } }));

    const response = await restrict(project.id, owner, [
      { kind: 'subject', subject: 'subject-operator', role: 'owner' },
      { kind: 'oathweave_role', name: 'studio-reviewers', role: 'viewer' },
    ]);
    expect(response.status).toBe(200);
    const saved = projectMembersResponseSchema.parse(await json(response));
    expect(saved).toMatchObject({ mode: 'members', revision: 1, access: { mode: 'members', role: 'owner' } });
    expect(saved.members).toEqual([
      { kind: 'subject', subject: 'subject-operator', issuer: null, role: 'owner', user_id: 'operator', display_name: null, added_by: 'operator', added_at: expect.any(String) },
      { kind: 'oathweave_role', name: 'studio-reviewers', role: 'viewer', added_by: 'operator', added_at: expect.any(String) },
    ]);

    // Someone not listed: the project and its records do not exist for them.
    expect((await json(await ctx.call('GET', '/projects?status=all', { token: member }))).projects.map((item: { id: string }) => item.id)).toEqual([other.id]);
    for (const [method, path, what] of [
      ['GET', `/projects/${project.id}`, 'Project'], ['GET', `/projects/${project.id}/snapshot`, 'Project'], ['GET', `/projects/${project.id}/files`, 'Project'],
      ['GET', `/projects/${project.id}/members`, 'Project'], ['GET', `/projects/${project.id}/links`, 'Project'], ['PATCH', `/links/${link.id}`, 'Link'],
      ['POST', `/files/${file.id}/reindex`, 'File'], ['DELETE', `/files/${file.id}`, 'File'], ['POST', `/decisions/${decision.id}/supersede`, 'Decision'],
      ['GET', `/blobs/${file.sha256}`, 'Blob'], ['GET', `/projects/${project.id}/stream`, 'Project'],
    ] as const) {
      const refused = await ctx.call(method, path, { token: member, ...(method === 'PATCH' ? { body: { title: 'x' } } : method === 'POST' && path.includes('supersede') ? { body: { title: 'x', statement_md: 'y' } } : {}) });
      expect(refused.status, `${method} ${path}`).toBe(404);
      expect((await json(refused)).error).toEqual({ code: 'NOT_FOUND', message: `${what} not found` });
    }
    expect((await upload(project.id, member)).status).toBe(404);
    expect((await ctx.call('GET', `/projects/${other.id}`, { token: member })).status).toBe(200);

    // Someone whose token carries a listed Oathweave role reads, but cannot change anything.
    expect((await ctx.call('GET', `/projects/${project.id}/snapshot`, { token: reviewer })).status).toBe(200);
    expect((await json(await ctx.call('GET', '/projects', { token: reviewer }))).projects.find((item: { id: string }) => item.id === project.id).access).toEqual({ mode: 'members', role: 'viewer' });
    expect((await ctx.call('GET', `/blobs/${file.sha256}`, { token: reviewer })).status).toBe(200);
    const readOnly = await ctx.call('PATCH', `/projects/${project.id}`, { token: reviewer, body: { name: 'No' } });
    expect(readOnly.status).toBe(403);
    expect((await json(readOnly)).error).toMatchObject({ code: 'PROJECT_ROLE_REQUIRED', details: { required: 'editor', role: 'viewer' } });
    expect((await ctx.call('DELETE', `/links/${link.id}`, { token: reviewer })).status).toBe(403);
    expect((await ctx.call('POST', `/projects/${project.id}/team/validate`, { token: reviewer, body: {} })).status).toBe(200);
    const stream = await connect(project.id, reviewer);
    expect(stream.response.status).toBe(200);

    // A Studio admin owns every project.
    expect((await json(await ctx.call('GET', `/projects/${project.id}/members`, { token: admin }))).access).toEqual({ mode: 'members', role: 'owner' });

    expect(ctx.store.audit.list({ targetId: project.id }).filter(entry => entry.action === 'project.members').map(entry => entry.detail)).toEqual([{
      mode: 'members', revision: 1,
      members: [{ kind: 'subject', issuer: null, value: 'subject-operator', role: 'owner' }, { kind: 'oathweave_role', issuer: null, value: 'studio-reviewers', role: 'viewer' }],
    }]);
  });

  it('refuses memberships that would lock people out or that are stale', async () => {
    ctx = await createTestContext();
    const { owner, admin } = await people();
    const project = await createProject(ctx);
    const put = (body: Record<string, unknown>, token = owner) => ctx.call('PUT', `/projects/${project.id}/members`, { token, body: { base_revision: 0, ...body } });
    const code = async (response: Response) => [response.status, (await json(response)).error.code];
    expect(await code(await put({ mode: 'members', members: [{ kind: 'subject', subject: 'subject-member', role: 'editor' }] }))).toEqual([422, 'OWNER_REQUIRED']);
    expect(await code(await put({ mode: 'members', members: [{ kind: 'subject', subject: 'subject-member', role: 'owner' }] }))).toEqual([422, 'SELF_LOCKOUT']);
    expect(await code(await put({ mode: 'members', members: [] }))).toEqual([422, 'OWNER_REQUIRED']);
    expect(await code(await put({ mode: 'everyone', members: [{ kind: 'subject', subject: 'subject-member', role: 'owner' }] }))).toEqual([422, 'MEMBERS_NOT_ALLOWED']);
    expect(await code(await put({ mode: 'members', members: [{ kind: 'subject', subject: 'subject-operator', role: 'owner' }, { kind: 'subject', subject: 'subject-operator', role: 'viewer' }] }))).toEqual([400, 'VALIDATION_ERROR']);
    expect(await code(await put({ base_revision: 3, mode: 'everyone' }))).toEqual([409, 'VERSION_CONFLICT']);
    // An owner through an Oathweave role keeps ownership; an admin may hand the project to others entirely.
    const viaRole = await ctx.token({ permissions: NOT_ADMIN, roles: ['leads'] });
    expect((await put({ mode: 'members', members: [{ kind: 'oathweave_role', name: 'leads', role: 'owner' }] }, viaRole)).status).toBe(200);
    expect((await ctx.call('PUT', `/projects/${project.id}/members`, { token: admin, body: { base_revision: 1, mode: 'members', members: [{ kind: 'subject', subject: 'subject-member', role: 'owner' }] } })).status).toBe(200);
    // The creator is no longer listed, so the project is gone for them.
    expect((await ctx.call('GET', `/projects/${project.id}`, { token: owner })).status).toBe(404);
    expect(ctx.store.members.get(project.id)).toMatchObject({ mode: 'members', revision: 2 });
  });

  it('closes the stream of someone a change removes, and opens the project again with mode everyone', async () => {
    ctx = await createTestContext();
    const { owner, member } = await people();
    const project = await createProject(ctx);
    const stream = await connect(project.id, member);
    expect(stream.response.status).toBe(200);
    expect((await restrict(project.id, owner, [{ kind: 'subject', subject: 'subject-operator', issuer: 'https://identity.example.com', role: 'owner' }])).status).toBe(200);
    expect(await stream.next()).toBeUndefined();
    expect((await ctx.call('GET', `/projects/${project.id}`, { token: member })).status).toBe(404);

    // A listed member keeps theirs and sees the change.
    expect((await restrict(project.id, owner, [{ kind: 'subject', subject: 'subject-operator', role: 'owner' }, { kind: 'subject', subject: 'subject-member', role: 'editor' }])).status).toBe(200);
    const kept = await connect(project.id, member);
    expect((await restrict(project.id, owner, [{ kind: 'subject', subject: 'subject-operator', role: 'owner' }, { kind: 'subject', subject: 'subject-member', role: 'viewer' }])).status).toBe(200);
    const event = (await kept.next())!;
    expect(event.event).toBe('project.members.updated');
    expect(JSON.parse(event.data).payload).toEqual({ mode: 'members', revision: 3 });

    const reopened = await ctx.call('PUT', `/projects/${project.id}/members`, { token: owner, body: { base_revision: 3, mode: 'everyone' } });
    expect(reopened.status).toBe(200);
    expect(await json(reopened)).toMatchObject({ mode: 'everyone', revision: 4, members: [] });
    expect((await json(await ctx.call('GET', `/projects/${project.id}/members`, { token: member }))).access).toEqual({ mode: 'everyone', role: 'editor' });
  });

  it('hides restricted projects in agent roles and operations', async () => {
    ctx = await createTestContext();
    const { owner, member } = await people();
    ctx.magnus.profiles = [profile('node1', 'lead'), profile('node1', 'scout'), profile('node2', 'mapper')];
    const project = await createProject(ctx);
    await publishTeam(ctx, project.id);
    const roleProjects = async (token: string) => (await json(await ctx.call('GET', '/agents', { token }))).agents
      .find((agent: { agent_ref: string }) => agent.agent_ref === 'node1~lead').roles.map((role: { project_id: string }) => role.project_id);
    expect(await roleProjects(member)).toEqual([project.id]);
    ctx.store.agents.recordOperation({ id: 'op-restricted', agentRef: 'node1~new', projectId: project.id, roleKey: null, createdBy: 'operator' });
    expect((await restrict(project.id, owner, [{ kind: 'subject', subject: 'subject-operator', role: 'owner' }])).status).toBe(200);
    expect(await roleProjects(member)).toEqual([]);
    expect(await roleProjects(owner)).toEqual([project.id]);
    expect((await ctx.call('GET', '/agents/operations/op-restricted', { token: member })).status).toBe(404);
    expect((await ctx.call('GET', `/projects?agentRef=node1~lead`, { token: member })).status).toBe(200);
    expect((await json(await ctx.call('GET', `/projects?agentRef=node1~lead`, { token: member }))).projects).toEqual([]);
  });
});

describe('GET /people', () => {
  const everyone = { people: [
    { user_id: 'operator', subject: 'subject-operator', issuer: 'https://identity.example.com', display_name: null },
    { user_id: 'viewer', subject: 'subject-viewer', issuer: 'https://identity.example.com', display_name: null },
    { user_id: 'member', subject: 'subject-member', issuer: 'https://identity.example.com', display_name: 'Member Person' },
  ], truncated: false };
  const refusedFor = async (token: string) => {
    const response = await ctx.call('GET', '/people', { token });
    expect(response.status).toBe(403);
    expect((await json(response)).error).toMatchObject({ code: 'PROJECT_ROLE_REQUIRED', details: { required: 'owner' } });
  };

  it('lists linked people only to admins and project owners', async () => {
    ctx = await createTestContext();
    const { owner, member, admin } = await people();
    const viewer = await ctx.token({ sub: 'subject-viewer', permissions: ['ardentstudio:projects:read'] });
    // Nobody owns a project yet: only an admin may list people.
    expect(await json(await ctx.call('GET', '/people', { token: admin }))).toEqual(everyone);
    await refusedFor(owner);

    const project = await createProject(ctx);
    // The creator owns a project open to everyone; the other linked people only edit or view it.
    expect(await json(await ctx.call('GET', '/people', { token: owner }))).toEqual(everyone);
    await refusedFor(member);
    await refusedFor(viewer);

    // Limited to members: an owner listed there may list people, editors and viewers may not, and the
    // creator no longer owns it when it does not list them as owner.
    expect((await restrict(project.id, admin, [
      { kind: 'subject', subject: 'subject-member', role: 'owner' },
      { kind: 'subject', subject: 'subject-operator', role: 'editor' },
      { kind: 'subject', subject: 'subject-viewer', role: 'viewer' },
    ])).status).toBe(200);
    expect(await json(await ctx.call('GET', '/people', { token: member }))).toEqual(everyone);
    await refusedFor(owner);
    await refusedFor(viewer);
    // An owner through an Oathweave role counts too.
    expect((await restrict(project.id, admin, [{ kind: 'oathweave_role', name: 'studio-leads', role: 'owner' }])).status).toBe(200);
    await refusedFor(member);
    const lead = await ctx.token({ sub: 'subject-member', permissions: NOT_ADMIN, roles: ['studio-leads'] });
    expect((await ctx.call('GET', '/people', { token: lead })).status).toBe(200);
    // Archived projects still count: their owners can still change the membership.
    const second = await createProject(ctx, { name: 'Second' });
    expect((await ctx.call('POST', `/projects/${second.id}/archive`, { token: owner })).status).toBe(200);
    expect((await ctx.call('GET', '/people', { token: owner })).status).toBe(200);
  });

  it('searches by prefix and caps the results', async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ issuer: 'https://identity.example.com', subject: `subject-bulk-${String(index).padStart(2, '0')}`,
      localUserId: `bulk${String(index).padStart(2, '0')}`, displayName: `Bulk Person ${index}` }));
    ctx = await createTestContext({ people: [...LINKS, ...many] });
    const { admin } = await people();
    const search = async (q: string) => json(await ctx.call('GET', `/people?q=${encodeURIComponent(q)}`, { token: admin }));
    // A word of the display name, case-insensitive.
    expect(await search('person')).toMatchObject({ people: [{ user_id: 'member' }, ...Array.from({ length: 49 }, () => ({}))], truncated: true });
    expect((await search('person')).people).toHaveLength(PEOPLE_SEARCH_LIMIT);
    expect(await search('MEMBER PE')).toEqual({ people: [everyone.people[2]], truncated: false });
    expect(await search('subject-op')).toEqual({ people: [everyone.people[0]], truncated: false });
    expect(await search('bulk5')).toMatchObject({ people: Array.from({ length: 10 }, (_, index) => ({ user_id: `bulk5${index}` })), truncated: false });
    // Only prefixes match.
    expect(await search('erson')).toEqual({ people: [], truncated: false });
    // Without q, every linked person.
    const all = await json(await ctx.call('GET', '/people', { token: admin }));
    expect(all.people).toHaveLength(63);
    expect(all.truncated).toBe(false);
    expect((await search('  ')).people).toHaveLength(63);
    expect((await ctx.call('GET', `/people?q=${'x'.repeat(201)}`, { token: admin })).status).toBe(400);
  });
});
