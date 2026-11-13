import { afterEach, describe, expect, it } from 'vitest';
import { createProject, createTestContext, json, profile, teamRole, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(() => ctx?.close());

async function setup(deliverables: unknown[] = [{ name: 'Research Report', kind: 'document', formats: ['md'] }]) {
  ctx = await createTestContext();
  const project = await createProject(ctx, { deliverables });
  const research = (await json(await ctx.call('GET', '/templates?kind=team'))).templates.find((item: { slug: string }) => item.slug === 'research-team');
  return { project, research };
}

const bindAll = (draft: any, refs: Record<string, string>) => ({
  roles: draft.body.roles.map((role: any) => { const { binding_id: _binding, ...rest } = role; return { ...rest, agent_ref: refs[role.key] ?? null }; }),
  relationships: draft.body.relationships, stages: draft.body.stages,
});

describe('team assignment', () => {
  it('applies a template as a draft, binds agents, validates and publishes', async () => {
    const { project, research } = await setup();
    const applied = await json(await ctx.call('POST', `/projects/${project.id}/team/apply-template`, { body: { template_id: research.id, version: 1 } }));
    expect(applied.current).toBeNull();
    expect(applied.draft).toMatchObject({ revision: 1, status: 'draft', source_template: { template_id: research.id, version: 1 } });
    expect(applied.validation.issues.filter((issue: { code: string }) => issue.code === 'unbound_role')).toHaveLength(5);
    expect(applied.validation.can_start_room).toBe(false);
    expect((await json(await ctx.call('GET', `/templates/${research.id}`))).used_by).toBe(1);

    const refs = { lead_researcher: 'node1~lead', source_scout: 'node1~scout', analyst: 'node2~mapper', fact_checker: 'node1~scout', editor: 'node1~scout' };
    const saved = await json(await ctx.call('PUT', `/projects/${project.id}/team/draft`, { body: { base_revision: null, body: bindAll(applied.draft, refs) } }));
    expect(saved.draft.body.roles.every((role: { binding_id: string | null }) => role.binding_id?.startsWith('bnd_'))).toBe(true);
    expect(saved.validation).toMatchObject({ can_publish: true, can_start_room: true, agent_facts: 'complete' });
    // The editor and the fact checker share an agent, and the fact checker reviews the editor's only output.
    expect(saved.validation.issues.map((issue: { code: string }) => issue.code)).toEqual(['reviewer_is_only_producer']);

    const published = await json(await ctx.call('POST', `/projects/${project.id}/team/publish`, { body: { draft_revision: 1 } }));
    expect(published.current).toMatchObject({ revision: 1, status: 'published', published_by: 'operator' });
    expect(published.draft).toBeNull();
    const types = ctx.store.events.after(project.id, 0).map(event => event.type);
    expect(types).toEqual(expect.arrayContaining(['team.draft.updated', 'team.revision.published']));

    const agents = await json(await ctx.call('GET', '/agents'));
    expect(agents.agents.find((agent: { agent_ref: string }) => agent.agent_ref === 'node1~scout').roles.map((role: { role_key: string }) => role.role_key).sort())
      .toEqual(['editor', 'fact_checker', 'source_scout']);
  });

  it('keeps published revisions immutable and supersedes them on the next publish', async () => {
    const { project, research } = await setup();
    const applied = await json(await ctx.call('POST', `/projects/${project.id}/team/apply-template`, { body: { template_id: research.id, version: 1 } }));
    await ctx.call('POST', `/projects/${project.id}/team/publish`, { body: { draft_revision: 1 } });
    const conflict = await ctx.call('PUT', `/projects/${project.id}/team/draft`, { body: { base_revision: null, body: bindAll(applied.draft, {}) } });
    expect(conflict.status).toBe(409);
    const r2 = await json(await ctx.call('PUT', `/projects/${project.id}/team/draft`, { body: { base_revision: 1, body: bindAll(applied.draft, { lead_researcher: 'node1~lead' }) } }));
    expect(r2.draft.revision).toBe(2);
    expect(() => ctx.store.db.prepare("UPDATE team_assignment_revisions SET body_json = '{}' WHERE revision = 1").run()).toThrow(/immutable/);
    const published = await json(await ctx.call('POST', `/projects/${project.id}/team/publish`, { body: { draft_revision: 2 } }));
    expect(published.current.revision).toBe(2);
    expect(ctx.store.team.revision(project.id, 1)!.status).toBe('superseded');
    expect((await ctx.call('POST', `/projects/${project.id}/team/publish`, { body: { draft_revision: 2 } })).status).toBe(409);
  });

  it('blocks publishing a team with errors and refuses to overwrite a draft unasked', async () => {
    const { project, research } = await setup([{ name: 'Region Map', kind: 'map', formats: ['svg'] }]);
    await ctx.call('POST', `/projects/${project.id}/team/apply-template`, { body: { template_id: research.id, version: 1 } });
    const blocked = await ctx.call('POST', `/projects/${project.id}/team/publish`, { body: { draft_revision: 1 } });
    expect(blocked.status).toBe(409);
    const error = (await json(blocked)).error;
    expect(error.code).toBe('TEAM_INVALID');
    expect(error.details.validation.issues.map((issue: { code: string }) => issue.code)).toContain('deliverable_without_producer');
    expect((await ctx.call('POST', `/projects/${project.id}/team/apply-template`, { body: { template_id: research.id, version: 1 } })).status).toBe(409);
    expect((await ctx.call('POST', `/projects/${project.id}/team/apply-template`, { body: { template_id: research.id, version: 1, replace_draft: true } })).status).toBe(200);
  });

  it('publishes only the draft body it validated', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const body = { roles: [teamRole('lead', 'Story Lead', 'node1~lead', { coordinator: true })], relationships: [], stages: [] };
    expect((await ctx.call('PUT', `/projects/${project.id}/team/draft`, { body: { base_revision: null, body } })).status).toBe(200);
    // Someone else saves the draft (same revision number, no bound agent) while publish waits for Magnus.
    const memoryStatus = ctx.magnusClient.memoryStatus.bind(ctx.magnusClient);
    let saves = 0;
    ctx.magnusClient.memoryStatus = async (...args) => {
      const answer = await memoryStatus(...args);
      if (saves++ === 0) {
        const draft = ctx.store.team.draft(project.id)!;
        ctx.store.tx(() => ctx.store.team.saveDraft(project.id, { baseRevision: null, sourceTemplate: undefined, userId: 'viewer',
          body: { ...draft.body, roles: draft.body.roles.map(role => ({ ...role, agent_ref: null, binding_id: null })) } }));
      }
      return answer;
    };
    const published = await ctx.call('POST', `/projects/${project.id}/team/publish`, { body: { draft_revision: 1 } });
    expect(saves).toBeGreaterThan(0);
    expect(published.status).toBe(409);
    expect((await json(published)).error.code).toBe('TEAM_REVISION_CONFLICT');
    expect(ctx.store.team.pointers(project.id)).toEqual({ current: null, draft: 1 });
    expect(ctx.store.team.draft(project.id)!.body.roles[0]!.agent_ref).toBeNull();
  });

  it('validates an arbitrary body without saving and reports what Magnus cannot answer', async () => {
    const { project, research } = await setup();
    const applied = await json(await ctx.call('POST', `/projects/${project.id}/team/apply-template`, { body: { template_id: research.id, version: 1 } }));
    ctx.magnus.profiles = [profile('node1', 'lead', { running: false })];
    ctx.magnus.memory.set('node1~lead', 'degraded');
    const offline = await json(await ctx.call('POST', `/projects/${project.id}/team/validate`, { body: { body: bindAll(applied.draft, { lead_researcher: 'node1~lead' }) } }));
    expect(offline.issues.map((issue: { code: string }) => issue.code)).toContain('agent_unavailable');
    expect(offline.can_start_room).toBe(false);
    ctx.magnus.fail = true;
    const unknown = await json(await ctx.call('POST', `/projects/${project.id}/team/validate`, { body: { body: bindAll(applied.draft, { lead_researcher: 'node9~gone' }) } }));
    expect(unknown.agent_facts).toBe('unavailable');
    expect(ctx.store.team.draft(project.id)!.body.roles.every(role => role.agent_ref === null)).toBe(true);
    const foreign = await ctx.call('POST', `/projects/${project.id}/team/validate`, { body: { body: { ...bindAll(applied.draft, {}), roles: [{ ...bindAll(applied.draft, {}).roles[0], knowledge: ['fil_01JABCDEFGHJKMNPQRSTVWXYZ0'] }] } } });
    expect(foreign.status).toBe(422);
  });

  it('saves a team as a new user template without bindings, then as its next version', async () => {
    const { project, research } = await setup();
    const applied = await json(await ctx.call('POST', `/projects/${project.id}/team/apply-template`, { body: { template_id: research.id, version: 1 } }));
    await ctx.call('PUT', `/projects/${project.id}/team/draft`, { body: { base_revision: null, body: bindAll(applied.draft, { lead_researcher: 'node1~lead' }) } });
    const saved = await ctx.call('POST', `/projects/${project.id}/team/save-as-template`, { body: { from: 'draft', name: 'Research Team (short)' } });
    expect(saved.status).toBe(201);
    const template = await json(saved);
    expect(template).toMatchObject({ kind: 'team', source: 'user', slug: 'research-team-short', latest_version: 1 });
    expect(JSON.stringify(template.latest.body)).not.toContain('node1~lead');
    expect(template.latest.body.roles[0]).not.toHaveProperty('agent_ref');
    const v2 = await json(await ctx.call('POST', `/projects/${project.id}/team/save-as-template`, { body: { from: 'draft', name: 'Research Team (short)', template_id: template.id, base_version: 1 } }));
    expect(v2.latest_version).toBe(2);
    expect((await ctx.call('POST', `/projects/${project.id}/team/save-as-template`, { body: { from: 'draft', name: 'x', template_id: research.id, base_version: 1 } })).status).toBe(409);
    expect((await ctx.call('POST', `/projects/${project.id}/team/save-as-template`, { body: { from: 'current', name: 'x' } })).status).toBe(404);
  });
});
