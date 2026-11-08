import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, json, profile, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(() => ctx?.close());

describe('agents through Magnus', () => {
  it('lists Magnus profiles with Studio presentation and forwards the acting subject', async () => {
    ctx = await createTestContext();
    ctx.magnus.profiles = [profile('node1', 'lead'), profile('node2', 'mapper', { running: false }), profile('node3', 'broken', { error: 'Config invalid' })];
    ctx.store.agents.savePresentation({ agentRef: 'node1~lead', portrait: { preset: 'silhouette-a', accent: 'amber', emblem: 'crown' }, avatarFileId: null, displayName: 'Story Lead', updatedBy: 'operator' });
    const list = await json(await ctx.call('GET', '/agents'));
    expect(list.magnus).toEqual({ state: 'ok', error: null });
    expect(list.available_count).toBe(1);
    expect(list.agents.map((agent: { agent_ref: string; display_name: string; available: boolean }) => [agent.agent_ref, agent.display_name, agent.available])).toEqual([
      ['node1~lead', 'Story Lead', true], ['node2~mapper', 'mapper', false], ['node3~broken', 'broken', false],
    ]);
    expect(list.agents[0]).not.toHaveProperty('hostname');
    expect(ctx.magnus.calls.at(-1)).toEqual({ method: 'listProfiles', actingSubject: 'subject-operator' });
  });

  it('reports Magnus being unavailable instead of inventing agents', async () => {
    ctx = await createTestContext();
    ctx.magnus.fail = true;
    expect(await json(await ctx.call('GET', '/agents'))).toEqual({ agents: [], available_count: 0, magnus: { state: 'unavailable', error: 'Magnus unavailable' } });
  });
});

describe('health', () => {
  it('is live without a token', async () => {
    ctx = await createTestContext();
    const response = await ctx.call('GET', '/health/live', { token: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('is ready only with Magnus, HiveMem and at least one available agent', async () => {
    ctx = await createTestContext();
    const ready = await ctx.call('GET', '/health/ready', { token: null });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready', checks: { agents: { status: 'ok', available: 3 } } });
    ctx.close();
    ctx = await createTestContext();
    ctx.magnus.profiles = [profile('node1', 'lead', { reachable: false })];
    const noAgents = await ctx.call('GET', '/health/ready', { token: null });
    expect(noAgents.status).toBe(503);
    expect(await noAgents.json()).toMatchObject({ status: 'not_ready', checks: { magnus: { status: 'ok' }, agents: { status: 'unavailable', available: 0 } } });
    ctx.close();
    ctx = await createTestContext();
    ctx.hivemem.healthy = false;
    expect(await (await ctx.call('GET', '/health/ready', { token: null })).json()).toMatchObject({ status: 'not_ready', checks: { hivemem: { status: 'unavailable', error: 'HiveMem down' } } });
  });
});
