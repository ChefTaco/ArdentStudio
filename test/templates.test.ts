import { afterEach, describe, expect, it } from 'vitest';
import { loadSeedTemplates, TEAM_SEEDS } from '../src/templates/seeds.js';
import { teamTemplateBodySchema, agentTemplateBodySchema } from '../src/shared/browser.js';
import { validateTeam } from '../src/team/validation.js';
import { createTestContext, json, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(() => ctx?.close());

const agentBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Archivist', category: 'research', purpose: 'Keeps the project archive tidy.', example_uses: ['Index notes'],
  soul_md: '# Archivist\n\nOrderly and kind.', identity_md: '# Identity', skills: [{ kind: 'local', ref: 'filing' }], model_hint: null,
  runtime_req: { ardent: null, backend: 'any' }, integrations: ['hivemem'], expected_outputs: ['Index'], avatar_preset: { preset: 'silhouette-a', accent: 'blue', emblem: 'book' },
  ...overrides,
});

describe('seed templates', () => {
  it('load the four generic teams with their agent templates, once', async () => {
    ctx = await createTestContext();
    expect(loadSeedTemplates(ctx.store)).toBe(0);
    const teams = ctx.store.templates.list({ kind: 'team', archived: 'false' });
    expect(teams.map(item => item.name).sort()).toEqual(['Adventure Studio', 'Deliberation Panel', 'Development Team', 'Research Team']);
    expect(teams.every(item => item.source === 'seed' && item.latest_version === 1)).toBe(true);
    const agents = ctx.store.templates.list({ kind: 'agent', archived: 'false' });
    expect(agents).toHaveLength(TEAM_SEEDS.reduce((sum, team) => sum + team.roles.length, 0));
  });

  it('match the plan rosters and are valid', async () => {
    ctx = await createTestContext();
    const rosters = Object.fromEntries(TEAM_SEEDS.map(team => [team.name, team.roles.map(role => role.name)]));
    expect(rosters).toEqual({
      'Research Team': ['Lead Researcher', 'Source Scout', 'Analyst', 'Fact Checker', 'Editor'],
      'Development Team': ['Tech Lead', 'Planner', 'Implementer', 'Reviewer', 'Release Writer'],
      'Adventure Studio': ['Story Lead', 'Worldbuilder', 'Cartographer', 'Encounter Designer', 'Continuity Editor', 'Layout Editor'],
      'Deliberation Panel': ['Chair', 'Advocate', 'Skeptic', 'Scribe'],
    });
    for (const summary of ctx.store.templates.list({ archived: 'all' })) {
      const version = ctx.store.templates.version(summary.id, 1)!;
      if (version.kind === 'team') {
        expect(teamTemplateBodySchema.safeParse(version.body).success, summary.slug).toBe(true);
        expect(validateTeam({ mode: 'template', roles: version.body.roles, relationships: version.body.relationships }).issues, summary.slug).toEqual([]);
        for (const role of version.body.roles) expect(ctx.store.templates.version(role.agent_template_ref!.template_id, 1)?.kind).toBe('agent');
      } else {
        expect(agentTemplateBodySchema.safeParse(version.body).success, summary.slug).toBe(true);
      }
    }
  });
});

describe('template routes', () => {
  it('list, filter and read templates and versions', async () => {
    ctx = await createTestContext();
    const all = await json(await ctx.call('GET', '/templates?kind=team'));
    const adventure = all.templates.find((item: { slug: string }) => item.slug === 'adventure-studio');
    expect(adventure).toMatchObject({ kind: 'team', source: 'seed', used_by: 0 });
    const detail = await json(await ctx.call('GET', `/templates/${adventure.id}`));
    expect(detail.latest).toMatchObject({ kind: 'team', version: 1 });
    expect(detail.versions).toHaveLength(1);
    expect((await ctx.call('GET', `/templates/${adventure.id}/versions/1`)).status).toBe(200);
    expect((await ctx.call('GET', `/templates/${adventure.id}/versions/2`)).status).toBe(404);
    expect((await json(await ctx.call('GET', '/templates?q=cartograph'))).templates.map((item: { name: string }) => item.name)).toEqual(['Cartographer']);
  });

  it('create user templates, add immutable versions and refuse a stale base', async () => {
    ctx = await createTestContext();
    const created = await ctx.call('POST', '/templates', { body: { kind: 'agent', body: agentBody() } });
    expect(created.status).toBe(201);
    const template = await json(created);
    expect(template).toMatchObject({ kind: 'agent', slug: 'archivist', source: 'user', latest_version: 1 });
    const v2 = await ctx.call('POST', `/templates/${template.id}/versions`, { body: { base_version: 1, changelog: 'Warmer voice', body: agentBody({ soul_md: '# Archivist\n\nWarm.' }) } });
    expect(v2.status).toBe(201);
    expect((await json(v2)).versions.map((item: { version: number }) => item.version)).toEqual([2, 1]);
    const stale = await ctx.call('POST', `/templates/${template.id}/versions`, { body: { base_version: 1, changelog: 'Late edit', body: agentBody() } });
    expect(stale.status).toBe(409);
    expect((await json(stale)).error).toMatchObject({ code: 'VERSION_CONFLICT', details: { latest_version: 2 } });
    expect((await json(await ctx.call('GET', `/templates/${template.id}/versions/1`))).body.soul_md).toBe('# Archivist\n\nOrderly and kind.');
    const wrongKind = await ctx.call('POST', `/templates/${template.id}/versions`, { body: { base_version: 2, changelog: 'x', body: (await json(await ctx.call('GET', '/templates?kind=team'))).templates[0] } });
    expect(wrongKind.status).toBe(400);
    expect((await ctx.call('POST', '/templates', { body: { kind: 'agent', slug: 'archivist', body: agentBody() } })).status).toBe(409);
  });

  it('archive and unarchive, and refuse versions while archived', async () => {
    ctx = await createTestContext();
    const template = await json(await ctx.call('POST', '/templates', { body: { kind: 'agent', body: agentBody() } }));
    expect((await json(await ctx.call('POST', `/templates/${template.id}/archive`, { body: {} }))).archived).toBe(true);
    expect((await json(await ctx.call('GET', '/templates?kind=agent&source=user'))).templates).toEqual([]);
    expect((await ctx.call('POST', `/templates/${template.id}/versions`, { body: { base_version: 1, changelog: 'x', body: agentBody() } })).status).toBe(409);
    expect((await json(await ctx.call('POST', `/templates/${template.id}/archive`, { body: { archived: false } }))).archived).toBe(false);
  });

  it('refuse credentials and invalid team structures', async () => {
    ctx = await createTestContext();
    const leaked = await ctx.call('POST', '/templates', { body: { kind: 'agent', body: agentBody({ identity_md: `Use key ${'npm_'}${'A'.repeat(36)}` }) } });
    expect(leaked.status).toBe(422);
    expect((await json(leaked)).error).toMatchObject({ code: 'CREDENTIAL_LIKE_VALUE', details: { paths: ['$.identity_md'] } });
    const research = (await json(await ctx.call('GET', '/templates?kind=team'))).templates.find((item: { slug: string }) => item.slug === 'research-team');
    const body = (await json(await ctx.call('GET', `/templates/${research.id}`))).latest.body;
    const noLead = { ...body, roles: body.roles.map((role: Record<string, unknown>) => ({ ...role, coordinator: false })) };
    const invalid = await ctx.call('POST', '/templates', { body: { kind: 'team', body: noLead } });
    expect(invalid.status).toBe(422);
    expect((await json(invalid)).error.code).toBe('TEAM_INVALID');
  });
});
