import { afterEach, describe, expect, it } from 'vitest';
import { checkProposal, extractJson, type ProposalRequest } from '../src/team/proposals.js';
import { createProject, createTestContext, json, teamRole, waitFor, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => { await ctx?.close(); });

const DELIVERABLES = [{ name: 'Adventure Text', kind: 'document', formats: ['md'] }, { name: 'Region Map', kind: 'map', formats: ['svg'] }];

const VALID = {
  rationale: 'A lead who writes and a cartographer who maps.',
  source_template: null,
  roles: [
    { key: 'lead', name: 'Story Lead', coordinator: true, responsibilities_md: 'Leads and writes.', deliverables: ['Adventure Text'], rationale: 'Owns the story.' },
    { key: 'mapper', name: 'Cartographer', responsibilities_md: 'Draws maps.', deliverables: ['Region Map'] },
  ],
  relationships: [{ from: 'mapper', to: 'lead', type: 'reports_to' }, { from: 'lead', to: 'mapper', type: 'delegates_to' }],
  stages: ['create', 'review'],
  bindings: [{ role_key: 'lead', agent_ref: 'node1~lead', reason: 'Already the coordinator.' }, { role_key: 'mapper', agent_ref: 'node2~mapper' }],
};
const TWO_COORDINATORS = { ...VALID, roles: VALID.roles.map(role => ({ ...role, coordinator: true })) };
const fenced = (value: unknown) => `Here is the team.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;

/** A project whose draft team has the coordinator bound to node1~lead (not published). */
async function draftProject() {
  const project = await createProject(ctx, { deliverables: DELIVERABLES });
  const saved = await ctx.call('PUT', `/projects/${project.id}/team/draft`, { body: { base_revision: null, body: {
    roles: [teamRole('lead', 'Story Lead', 'node1~lead', { coordinator: true })], relationships: [], stages: [] } } });
  expect(saved.status).toBe(200);
  return project;
}

const proposalEvents = (projectId: string) => ctx.store.events.after(projectId, 0).filter(event => event.type === 'team.proposal.updated')
  .map(event => (event.payload.proposal as { state: string }).state);

describe('team proposals', () => {
  it('asks the bound coordinator with a mission and stores a validated proposal without applying it', async () => {
    ctx = await createTestContext();
    const project = await draftProject();
    const created = await ctx.call('POST', `/projects/${project.id}/team/propose`, { body: {} });
    expect(created.status).toBe(201);
    const record = await json(created);
    expect(record).toMatchObject({ agent_ref: 'node1~lead', role_key: 'lead', state: 'queued', basis: { current_revision: null, draft_revision: 1 }, proposal: null,
      attempts: [{ attempt: 1, outcome: 'pending' }] });

    const [ardent] = await ctx.magnus.submitted(1);
    expect(ardent).toMatchObject({ ref: 'node1~lead', context: 'mission', session_id: null });
    const body = ardent!.body as { objective: string; mission: { allowed_actions: string[]; resources: string[] }; context_items: Array<{ title: string; text: string }>; labels: Record<string, string> };
    expect(body.objective).toContain('Reply with exactly one JSON object');
    expect(body.objective).toContain('Project: Emberfall One-Shot');
    expect(body.objective).toContain('- Region Map (map; svg)');
    expect(body.mission).toMatchObject({ allowed_actions: ['observe', 'analyze'], resources: [`project:${project.id.toLowerCase()}`], expected_artifacts: [] });
    expect(body.labels).toMatchObject({ 'studio.mode': 'team_proposal', 'studio.project': project.id });
    const agents = body.context_items.find(item => item.title === 'Available agents')!;
    expect(agents.text).toContain('- node2~mapper: mapper, llamacpp, available');
    expect(body.context_items.find(item => item.title === 'Team templates')!.text).toMatch(/template_id tpl_/);

    const task = ctx.store.tasks.get(record.task_id)!;
    expect(task).toMatchObject({ mode: 'team_proposal', conversation_id: null, source: { proposal_id: record.id, attempt: 1 } });
    await waitFor(() => task.id && ctx.store.tasks.get(task.id)!.ardent.task_id && ctx.magnus.openStreams(ardent!.id));
    ctx.magnus.event(ardent!.id, 'model_started', {});
    await waitFor(() => ctx.store.proposals.get(record.id)!.state === 'running');
    ctx.magnus.text(ardent!.id, 1, '{"rationale": "A lead');
    ctx.magnus.finish(ardent!.id, { state: 'completed', result: JSON.stringify({ outcome: 'partial', summary: fenced(VALID) }) });
    const ready = await waitFor(async () => {
      const response = await json(await ctx.call('GET', `/projects/${project.id}/team/proposals/${record.id}`));
      return response.state === 'ready' ? response : undefined;
    });
    expect(ready).toMatchObject({ progress: 'Proposed 2 roles', error: null, attempts: [{ attempt: 1, outcome: 'valid', error: null }],
      proposal: { rationale: VALID.rationale, roles: [{ key: 'lead', coordinator: true, rationale: 'Owns the story.' }, { key: 'mapper', coordinator: false, skills: [], stage: null }] } });
    expect(ready.draft_body.roles).toEqual([
      expect.objectContaining({ key: 'lead', agent_ref: 'node1~lead', knowledge: [], agent_template_ref: null }),
      expect.objectContaining({ key: 'mapper', agent_ref: 'node2~mapper', knowledge: [] }),
    ]);
    expect(ready.draft_body.roles[0]).not.toHaveProperty('rationale');

    // Nothing applied: the draft is unchanged, no room message was written, and the draft body is accepted by PUT team/draft.
    expect(ctx.store.team.draft(project.id)!.body.roles.map(role => role.key)).toEqual(['lead']);
    expect(ctx.store.room.teamConversation(project.id)).toBeUndefined();
    expect(ctx.store.tasks.get(task.id)!.state).toBe('completed');
    expect(proposalEvents(project.id)).toEqual(['queued', 'running', 'ready']);
    const applied = await ctx.call('PUT', `/projects/${project.id}/team/draft`, { body: { base_revision: null, body: ready.draft_body } });
    expect(applied.status).toBe(200);
    expect((await json(await ctx.call('GET', `/projects/${project.id}/team/proposals`))).proposals.map((item: { id: string }) => item.id)).toEqual([record.id]);
    expect(ctx.store.audit.list({ targetId: project.id }).map(entry => entry.action)).toContain('team.propose');
  });

  it('retries once with the validation error through task-submit, then fails visibly', async () => {
    ctx = await createTestContext();
    ctx.magnus.studio.set('node2', 1);
    const project = await draftProject();
    const record = await json(await ctx.call('POST', `/projects/${project.id}/team/propose`, { body: { agent_ref: 'node2~mapper' } }));
    expect(record).toMatchObject({ agent_ref: 'node2~mapper', role_key: null });
    const [first] = await ctx.magnus.submitted(1);
    expect(first).toMatchObject({ context: 'direct', ref: 'node2~mapper' });
    expect(first!.prompt).toContain('Available agents:\n- node1~lead');
    await waitFor(() => ctx.store.tasks.get(record.task_id)!.ardent.task_id && ctx.magnus.openStreams(first!.id));
    ctx.magnus.finish(first!.id, { state: 'completed', result: fenced(TWO_COORDINATORS) });

    const [, second] = await ctx.magnus.submitted(2);
    expect(second!.prompt).toContain('Your previous reply could not be used:');
    expect(second!.prompt).toContain('Exactly one role must be the coordinator (found 2)');
    const retrying = ctx.store.proposals.get(record.id)!;
    expect(retrying).toMatchObject({ state: 'queued', progress: 'Asked the agent again with the validation error', attempts: [{ outcome: 'invalid' }, { outcome: 'pending' }] });
    const retryTask = ctx.store.tasks.get(retrying.task_id!)!;
    expect(retryTask.source).toMatchObject({ attempt: 2, previous_error: expect.stringContaining('coordinator') });
    await waitFor(() => ctx.store.tasks.get(retryTask.id)!.ardent.task_id && ctx.magnus.openStreams(second!.id));
    ctx.magnus.finish(second!.id, { state: 'completed', result: 'I would rather discuss this first.' });

    const failed = await waitFor(() => { const current = ctx.store.proposals.get(record.id)!; return current.state === 'failed' ? current : undefined; });
    expect(failed).toMatchObject({ proposal: null, draft_body: null, progress: 'The agent did not return a valid proposal',
      attempts: [{ attempt: 1, outcome: 'invalid' }, { attempt: 2, outcome: 'invalid', error: 'The reply does not contain a JSON object.' }] });
    expect(failed.error).toContain('not a valid team proposal after 2 attempts');
    expect(ctx.magnus.tasks.size).toBe(2);
    expect(proposalEvents(project.id)).toEqual(['queued', 'queued', 'failed']);
  });

  it('refuses requests it cannot ask, and ends with the task when it is cancelled or fails', async () => {
    ctx = await createTestContext();
    const bare = await createProject(ctx, { name: 'No team yet' });
    expect((await json(await ctx.call('POST', `/projects/${bare.id}/team/propose`, { body: {} }))).error.code).toBe('NO_COORDINATOR');
    expect((await json(await ctx.call('POST', `/projects/${bare.id}/team/propose`, { body: { agent_ref: 'node9~ghost' } }))).error.code).toBe('UNKNOWN_AGENT');
    ctx.magnus.profiles.push({ ...ctx.magnus.profiles[0]!, id: 'sleepy', running: false });
    expect((await json(await ctx.call('POST', `/projects/${bare.id}/team/propose`, { body: { agent_ref: 'node1~sleepy' } }))).error.code).toBe('AGENT_UNAVAILABLE');
    ctx.magnus.fail = true;
    const down = await ctx.call('POST', `/projects/${bare.id}/team/propose`, { body: { agent_ref: 'node1~lead' } });
    expect(down.status).toBe(503);
    ctx.magnus.fail = false;
    expect((await ctx.call('GET', `/projects/${bare.id}/team/proposals/prp_01JABCDEFGHJKMNPQRSTVWXYZ0`)).status).toBe(404);

    const project = await draftProject();
    const record = await json(await ctx.call('POST', `/projects/${project.id}/team/propose`, { body: {} }));
    const busy = await ctx.call('POST', `/projects/${project.id}/team/propose`, { body: {} });
    expect(busy.status).toBe(409);
    expect((await json(busy)).error).toMatchObject({ code: 'PROPOSAL_IN_PROGRESS', details: { proposal_id: record.id } });
    expect((await json(await ctx.call('GET', `/projects/${project.id}/snapshot`))).team_proposals.map((item: { id: string }) => item.id)).toEqual([record.id]);
    const [ardent] = await ctx.magnus.submitted(1);
    await waitFor(() => ctx.store.tasks.get(record.task_id)!.ardent.task_id);
    expect((await json(await ctx.call('POST', `/tasks/${record.task_id}/reassign`, { body: { role_key: 'lead' } }))).error.code).toBe('NOT_REASSIGNABLE');
    expect((await ctx.call('POST', `/tasks/${record.task_id}/cancel`)).status).toBe(200);
    expect(ctx.magnus.tasks.get(ardent!.id)!.state).toBe('cancelled');
    await waitFor(() => ctx.store.proposals.get(record.id)!.state === 'cancelled');
    expect((await json(await ctx.call('GET', `/projects/${project.id}/snapshot`))).team_proposals).toEqual([]);

    const again = await json(await ctx.call('POST', `/projects/${project.id}/team/propose`, { body: {} }));
    const [, next] = await ctx.magnus.submitted(2);
    await waitFor(() => ctx.store.tasks.get(again.task_id)!.ardent.task_id && ctx.magnus.openStreams(next!.id));
    ctx.magnus.finish(next!.id, { state: 'failed', error: 'Model backend unavailable' });
    const failed = await waitFor(() => { const current = ctx.store.proposals.get(again.id)!; return current.state === 'failed' ? current : undefined; });
    expect(failed).toMatchObject({ error: 'The agent could not answer: Model backend unavailable', attempts: [{ outcome: 'failed' }] });
    expect(ctx.magnus.tasks.size).toBe(2);
  });
});

describe('proposal validation', () => {
  const request: ProposalRequest = {
    project: { name: 'P', audience: null, constraints: [], brief_md: '', deliverables: [{ name: 'Region Map', kind: 'map', formats: ['svg'], stage: null }] },
    basis_team: null, team_templates: [], agent_templates: [],
    agents: [{ agent_ref: 'node1~lead', display_name: 'lead', backend: 'llamacpp', available: true, roles: [] }],
  };
  const templates = { team: () => false, agent: () => false };
  const base = { roles: [{ key: 'lead', name: 'Lead', coordinator: true, deliverables: ['Region Map'] }, { key: 'scout', name: 'Scout' }],
    relationships: [{ from: 'scout', to: 'lead', type: 'reports_to' }] };

  it('reads bare, fenced, wrapped and embedded JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Sure:\n```json\n{"a":2}\n```\nDone.')).toEqual({ a: 2 });
    expect(extractJson('Answer: {"a":3} end')).toEqual({ a: 3 });
    expect(() => extractJson('no json here')).toThrow('does not contain a JSON object');
    expect(checkProposal(JSON.stringify({ team_proposal: base }), request, templates)).toMatchObject({ ok: true });
  });

  it('reports every rule a reply breaks', () => {
    const check = (value: unknown) => checkProposal(JSON.stringify(value), request, templates);
    expect(check({ ...base, bindings: [{ role_key: 'lead', agent_ref: 'node7~stranger' }] })).toMatchObject({ ok: false, error: expect.stringContaining('not one of the available agents') });
    expect(check({ ...base, source_template: { template_id: 'tpl_01JABCDEFGHJKMNPQRSTVWXYZ0', version: 1 } })).toMatchObject({ ok: false, error: expect.stringContaining('not a listed team template') });
    expect(check({ ...base, roles: [{ ...base.roles[0], deliverables: [] }, base.roles[1]] })).toMatchObject({ ok: false, error: expect.stringContaining('No role produces the deliverable Region Map') });
    expect(check({ ...base, relationships: [{ from: 'lead', to: 'scout', type: 'reports_to' }, { from: 'scout', to: 'lead', type: 'reports_to' }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining('cannot report') });
    expect(check({ ...base, roles: [...base.roles, { key: 'lead', name: 'Again' }] })).toMatchObject({ ok: false, error: expect.stringContaining('Duplicate role key "lead"') });
    expect(check({ ...base, relationships: [{ from: 'scout', to: 'nobody', type: 'reports_to' }] })).toMatchObject({ ok: false, error: expect.stringContaining('Unknown role "nobody"') });
    expect(check({ ...base, bindings: [{ role_key: 'lead', agent_ref: 'node1~lead' }, { role_key: 'lead', agent_ref: 'node1~lead' }] }))
      .toMatchObject({ ok: false, error: expect.stringContaining('more than one binding') });
    expect(checkProposal('', request, templates)).toEqual({ ok: false, error: 'The reply was empty.' });
  });
});
