import { afterEach, describe, expect, it } from 'vitest';
import { createProject, createTestContext, json, publishTeam, teamRole, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(() => ctx?.close());

const ids = async (path: string, token?: string): Promise<string[]> => {
  const response = await ctx.call('GET', path, token ? { token } : {});
  expect(response.status).toBe(200);
  return (await json(response)).projects.map((item: { id: string }) => item.id).sort();
};

describe('project list filtered by agent', () => {
  it('keeps only projects where the agent holds a role in the published or draft team', async () => {
    ctx = await createTestContext();
    const published = await createProject(ctx, { name: 'Published Team' });
    await publishTeam(ctx, published.id);
    const drafted = await createProject(ctx, { name: 'Draft Team' });
    const saved = await ctx.call('PUT', `/projects/${drafted.id}/team/draft`, { body: { base_revision: null,
      body: { roles: [teamRole('analyst', 'Analyst', 'node3~analyst'), teamRole('mapper', 'Cartographer', 'node2~mapper')], relationships: [], stages: [] } } });
    expect(saved.status).toBe(200);
    const unrelated = await createProject(ctx, { name: 'No Team' });

    expect(await ids('/projects?agentRef=node2~mapper')).toEqual([published.id, drafted.id].sort());
    expect(await ids('/projects?agentRef=node1~lead')).toEqual([published.id]);
    expect(await ids('/projects?agentRef=node3~analyst')).toEqual([drafted.id]);
    // Without the parameter the list is unchanged.
    expect(await ids('/projects')).toEqual([published.id, drafted.id, unrelated.id].sort());
    // Other filters still apply alongside it.
    expect(await ids('/projects?agentRef=node2~mapper&q=draft')).toEqual([drafted.id]);
  });

  it('returns an empty list for an agent with no roles', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    await publishTeam(ctx, project.id);
    expect(await ids('/projects?agentRef=node9~nobody')).toEqual([]);
    // A profile name alone does not match a role bound on another node.
    expect(await ids('/projects?agentRef=node2~lead')).toEqual([]);
  });

  it('keeps the status filter, so an archived project needs status=archived or all', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    await publishTeam(ctx, project.id);
    expect((await ctx.call('POST', `/projects/${project.id}/archive`)).status).toBe(200);
    expect(await ids('/projects?agentRef=node1~lead')).toEqual([]);
    expect(await ids('/projects?agentRef=node1~lead&status=all')).toEqual([project.id]);
  });

  it('refuses a malformed agentRef with the validation error', async () => {
    ctx = await createTestContext();
    for (const bad of ['node1', 'node1~lead~extra', '~lead', 'node1~', 'node%201~lead', '']) {
      const response = await ctx.call('GET', `/projects?agentRef=${bad}`);
      expect(response.status, bad).toBe(400);
      expect((await json(response)).error).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ path: 'agentRef' }] });
    }
  });

  it('still requires project read permission', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    await publishTeam(ctx, project.id);
    expect((await ctx.call('GET', '/projects?agentRef=node1~lead', { token: null })).status).toBe(401);
    const noRead = await ctx.token({ permissions: ['ardentstudio:templates:read'] });
    expect((await ctx.call('GET', '/projects?agentRef=node1~lead', { token: noRead })).status).toBe(403);
    const viewer = await ctx.token({ sub: 'subject-viewer' });
    expect(await ids('/projects?agentRef=node1~lead', viewer)).toEqual([project.id]);
  });
});
