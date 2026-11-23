import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDirectory } from '../src/agents/directory.js';
import { BlobStore } from '../src/blobs/store.js';
import { Conductor } from '../src/conductor/conductor.js';
import { openDatabase } from '../src/db/database.js';
import { Store } from '../src/db/store.js';
import { EventBus } from '../src/events/bus.js';
import { silentLogger } from '../src/logger.js';
import { attachReview } from '../src/review/index.js';
import type { ArtifactImporter } from '../src/review/importer.js';
import { createProject, createTestContext, json, publishTeam, waitFor, type TestContext } from './helpers.js';

let ctx: TestContext;
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; await ctx?.close(); });

/** Two research branches joined by a synthesis: writer (node1~scout) and mapper (node2~mapper) research, lead (node1~lead) writes. */
const SPEC = {
  name: 'Valley research',
  nodes: [
    { key: 'research_a', role: 'writer', prompt: 'Research the drowned valley villages.' },
    { key: 'research_b', role: 'mapper', prompt: 'Map the flooded roads.' },
    { key: 'synthesis', role: 'lead', prompt: 'Write the adventure outline from both research notes.', needs: ['research_a', 'research_b'] },
  ],
  output: 'synthesis',
};

async function project() {
  ctx = await createTestContext();
  const created = await createProject(ctx);
  await publishTeam(ctx, created.id);
  return created;
}

async function start(projectId: string, body: Record<string, unknown>) {
  const response = await ctx.call('POST', `/projects/${projectId}/workflow-runs`, { body });
  expect(response.status, await response.clone().text()).toBe(201);
  return json(response);
}

const runView = async (projectId: string, runId: string) => json(await ctx.call('GET', `/projects/${projectId}/workflow-runs/${runId}`));
const act = (projectId: string, runId: string, key: string, action: string) =>
  ctx.call('POST', `/projects/${projectId}/workflow-runs/${runId}/nodes/${key}/actions`, { body: { action } });

/** The Studio task of a node once it runs, and its Ardent task once Magnus accepted it. */
async function nodeTask(store: Store, runId: string, key: string, attempt = 1) {
  const taskId = await waitFor(() => store.tasks.forWorkflowNode(runId, key, attempt)?.id);
  const ardentId = await waitFor(() => store.tasks.get(taskId)?.ardent.task_id);
  return { taskId, ardentId };
}

/** Finish an Ardent task with a TeamResult, after registering an artifact when given. */
function complete(ardentId: string, summary: string, artifact?: { name: string; text: string }): string | undefined {
  let sha: string | undefined;
  if (artifact) {
    sha = ctx.magnus.addArtifact(new TextEncoder().encode(artifact.text), 'text/markdown');
    ctx.magnus.event(ardentId, 'artifact_registered', { artifact_id: `art-${sha.slice(0, 8)}`, name: artifact.name, mime: 'text/markdown', sha256: sha, size: artifact.text.length });
  }
  ctx.magnus.finish(ardentId, { state: 'completed', result: JSON.stringify({ outcome: 'completed', summary, ...(artifact ? { artifacts: [{ name: artifact.name, sha256: sha }] } : {}) }) });
  return sha;
}

const missionOf = (ardentId: string) => ctx.magnus.tasks.get(ardentId)!.body as { objective: string; context_items?: Array<{ title: string; mime?: string; text: string }>; mission: { id: string } };
const submissionsFor = (taskId: string) => ctx.magnus.calls.filter(call => (call.body as { action?: string; body?: { mission?: { id?: string } } } | undefined)?.action === 'mission-submit'
  && (call.body as { body: { mission: { id: string } } }).body.mission.id === taskId);
const eventTypes = (store: Store, projectId: string) => store.events.after(projectId, 0).map(event => event.type);

describe('workflow runs', () => {
  it('joins two research branches: the synthesis starts only after both are done, with their results and artifact references as data', async () => {
    const { id } = await project();
    const run = await start(id, { spec: SPEC, inputs: { tone: 'grim' } });
    expect(run).toMatchObject({ project_id: id, name: 'Valley research', state: 'running', output: 'synthesis', root_ref: `hx1:studio:local:workflow:${run.id}`, source_template: null });
    expect(run.nodes.map((node: { key: string; state: string }) => [node.key, node.state])).toEqual([['research_a', 'running'], ['research_b', 'running'], ['synthesis', 'waiting']]);

    const a = await nodeTask(ctx.store, run.id, 'research_a');
    const b = await nodeTask(ctx.store, run.id, 'research_b');
    const taskA = ctx.store.tasks.get(a.taskId)!;
    expect(taskA).toMatchObject({ mode: 'assignment', role_key: 'writer', instructions_md: SPEC.nodes[0]!.prompt, source: { workflow: { run_id: run.id, node_key: 'research_a', attempt: 1 } } });
    expect(taskA.execution).toMatchObject({ root: run.root_ref, parent: run.root_ref, self: `hx1:studio:local:task:${a.taskId}`, attempt: 1 });
    expect(missionOf(a.ardentId).objective).toContain('Research the drowned valley villages.');
    expect(missionOf(a.ardentId).context_items?.map(item => item.title)).toContain('Workflow inputs (data)');

    const sha = complete(a.ardentId, 'Three villages: Fenmarch, Saltreach, the Steps.', { name: 'villages.md', text: '# Villages\n' })!;
    await waitFor(() => ctx.store.workflows.node(run.id, 'research_a')?.state === 'done');
    await waitFor(() => ctx.store.review.taskImports(a.taskId).imported.length === 1);
    // Research B is still running: the join waits.
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(ctx.store.workflows.node(run.id, 'synthesis')?.state).toBe('waiting');
    expect(ctx.magnus.tasks.size).toBe(2);

    complete(b.ardentId, 'The east road is under water.');
    const synthesis = await nodeTask(ctx.store, run.id, 'synthesis');
    const items = missionOf(synthesis.ardentId).context_items ?? [];
    const resultA = items.find(item => item.title === 'Workflow result: research_a (data)');
    const resultB = items.find(item => item.title === 'Workflow result: research_b (data)');
    expect(resultA?.mime).toBe('application/json');
    expect(JSON.parse(resultA!.text)).toMatchObject({ node: 'research_a', role: 'writer', task: `hx1:studio:local:task:${a.taskId}`, state: 'completed',
      summary: 'Three villages: Fenmarch, Saltreach, the Steps.', artifacts: [{ ref: `ardent-artifact:${sha}`, name: 'villages.md', sha256: sha, mime: 'text/markdown' }] });
    expect(JSON.parse(resultB!.text)).toMatchObject({ node: 'research_b', summary: 'The east road is under water.', artifacts: [] });
    expect(ctx.store.tasks.get(synthesis.taskId)!.execution).toMatchObject({
      root: run.root_ref, parent: run.root_ref, inputs: [`hx1:studio:local:task:${a.taskId}`, `hx1:studio:local:task:${b.taskId}`],
    });

    complete(synthesis.ardentId, 'Act one: the flood.');
    await waitFor(() => ctx.store.workflows.run(run.id)?.state === 'completed');
    const done = await runView(id, run.id);
    expect(done).toMatchObject({ state: 'completed', finished_at: expect.any(String) });
    expect(done.nodes.find((node: { key: string }) => node.key === 'synthesis')).toMatchObject({ state: 'done', actions: [], result: { task_id: synthesis.taskId, state: 'completed', summary: 'Act one: the flood.' } });
    expect(done.nodes.find((node: { key: string }) => node.key === 'research_a').result.artifacts).toEqual([expect.objectContaining({ ref: `ardent-artifact:${sha}` })]);
    const types = eventTypes(ctx.store, id);
    expect(types).toContain('workflow.run.created');
    expect(types).toContain('workflow.node.updated');
    expect(types.filter(type => type === 'workflow.run.updated')).toHaveLength(1);
    const list = await json(await ctx.call('GET', `/projects/${id}/workflow-runs?state=finished`));
    expect(list.runs.map((item: { id: string }) => item.id)).toEqual([run.id]);
    expect((await json(await ctx.call('GET', `/projects/${id}/workflow-runs?state=active`))).runs).toEqual([]);
  });

  it('reuses completed branches after a restart: A is not resubmitted, B is followed, the synthesis runs', async () => {
    const { id } = await project();
    const run = await start(id, { spec: SPEC });
    const a = await nodeTask(ctx.store, run.id, 'research_a');
    const b = await nodeTask(ctx.store, run.id, 'research_b');
    complete(a.ardentId, 'Villages noted.');
    await waitFor(() => ctx.store.workflows.node(run.id, 'research_a')?.state === 'done');

    // Kill Studio: stop its workers and close the database.
    await ctx.conductor.stop();
    await ctx.importer.stop();
    ctx.store.db.close();

    // Restart on the same data directory.
    const db = openDatabase(join(ctx.dir, 'studio.sqlite'));
    const store = new Store(db, { now: () => new Date() }, new EventBus());
    const blobs = new BlobStore(db, ctx.dir, 64 * 1024 * 1024, { now: () => new Date() });
    const conductor = new Conductor({ store, blobs, magnus: ctx.magnusClient, agents: new AgentDirectory(ctx.magnusClient, store, { cacheMs: 0 }), live: ctx.live,
      logger: silentLogger, presenceMs: 3_600_000, submitRetryMs: 20, follower: { pollMinMs: 20, pollMaxMs: 50, pollWindowMs: 300, reconnectMs: 10 } });
    const importer: ArtifactImporter = attachReview({ store, blobs, magnus: ctx.magnusClient, conductor, logger: silentLogger, retryMs: 20, maxAttempts: 2 });
    conductor.start();
    importer.start();
    cleanup = async () => { await conductor.stop(); await importer.stop(); db.close(); };

    expect(store.workflows.node(run.id, 'research_a')).toMatchObject({ state: 'done', task_id: a.taskId });
    expect(store.workflows.node(run.id, 'research_b')).toMatchObject({ state: 'running', task_id: b.taskId });
    await waitFor(() => ctx.magnus.openStreams(b.ardentId) > 0);
    complete(b.ardentId, 'Roads mapped.');
    const synthesis = await nodeTask(store, run.id, 'synthesis');
    complete(synthesis.ardentId, 'Outline written.');
    await waitFor(() => store.workflows.run(run.id)?.state === 'completed');

    expect(submissionsFor(a.taskId)).toHaveLength(1);
    expect(submissionsFor(b.taskId)).toHaveLength(1);
    expect(submissionsFor(synthesis.taskId)).toHaveLength(1);
    expect(ctx.magnus.tasks.size).toBe(3);
    expect(store.tasks.inWorkflowRun(run.id)).toHaveLength(3);
    const items = missionOf(synthesis.ardentId).context_items ?? [];
    expect(items.map(item => item.title)).toEqual(['Workflow result: research_a (data)', 'Workflow result: research_b (data)']);
  });

  it('blocks the run when a branch fails, and a retry runs attempt 2 as a new task to completion', async () => {
    const { id } = await project();
    const run = await start(id, { spec: SPEC });
    const a = await nodeTask(ctx.store, run.id, 'research_a');
    const b = await nodeTask(ctx.store, run.id, 'research_b');
    complete(a.ardentId, 'Villages noted.');
    ctx.magnus.finish(b.ardentId, { state: 'failed', error: 'The map tool crashed' });
    await waitFor(() => ctx.store.workflows.run(run.id)?.state === 'blocked');

    const blocked = await runView(id, run.id);
    const nodeB = blocked.nodes.find((node: { key: string }) => node.key === 'research_b');
    const synthesis = blocked.nodes.find((node: { key: string }) => node.key === 'synthesis');
    expect(nodeB).toMatchObject({ state: 'failed', attempt: 1, error: 'The map tool crashed', actions: ['retry', 'cancel_run'] });
    expect(synthesis).toMatchObject({ state: 'blocked', blocked_by: ['research_b'], actions: ['cancel_run'] });
    expect(ctx.store.tasks.forWorkflowNode(run.id, 'synthesis', 1)).toBeUndefined();

    const refused = await act(id, run.id, 'research_a', 'retry');
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toMatchObject({ code: 'ACTION_UNAVAILABLE', details: { actions: ['cancel_run'] } });

    const retried = await act(id, run.id, 'research_b', 'retry');
    expect(retried.status).toBe(200);
    const after = await json(retried);
    expect(after.state).toBe('running');
    expect(after.nodes.find((node: { key: string }) => node.key === 'research_b')).toMatchObject({ state: 'running', attempt: 2 });
    expect(after.nodes.find((node: { key: string }) => node.key === 'synthesis')).toMatchObject({ state: 'waiting', blocked_by: [] });
    const second = await nodeTask(ctx.store, run.id, 'research_b', 2);
    expect(second.taskId).not.toBe(b.taskId);
    const retryTask = ctx.store.tasks.get(second.taskId)!;
    expect(retryTask.source).toEqual({ workflow: { run_id: run.id, node_key: 'research_b', attempt: 2, retry_of: b.taskId } });
    expect(retryTask.execution).toMatchObject({ parent: run.root_ref, attempt: 2 });

    complete(second.ardentId, 'Roads mapped on the second try.');
    const join = await nodeTask(ctx.store, run.id, 'synthesis');
    expect(JSON.parse((missionOf(join.ardentId).context_items ?? []).find(item => item.title === 'Workflow result: research_b (data)')!.text))
      .toMatchObject({ task: `hx1:studio:local:task:${second.taskId}`, summary: 'Roads mapped on the second try.' });
    complete(join.ardentId, 'Outline written.');
    await waitFor(() => ctx.store.workflows.run(run.id)?.state === 'completed');
    const final = await runView(id, run.id);
    expect(final.nodes.find((node: { key: string }) => node.key === 'research_b').attempts).toEqual([{ attempt: 1, task_id: b.taskId }, { attempt: 2, task_id: second.taskId }]);
    const actions = ctx.store.db.prepare("SELECT action FROM audit WHERE target_type = 'workflow_run' AND target_id = ?").all(run.id) as Array<{ action: string }>;
    expect(actions.map(row => row.action)).toEqual(['workflow.start', 'workflow.retry']);
  });

  it('skips an optional node: its task is cancelled and the synthesis goes on without its result', async () => {
    const { id } = await project();
    const spec = { ...SPEC, nodes: SPEC.nodes.map(node => node.key === 'research_b' ? { ...node, required: false } : node) };
    const run = await start(id, { spec });
    const a = await nodeTask(ctx.store, run.id, 'research_a');
    const b = await nodeTask(ctx.store, run.id, 'research_b');
    expect((await json(await act(id, run.id, 'research_a', 'skip'))).error).toMatchObject({ code: 'ACTION_UNAVAILABLE' });

    const skipped = await json(await act(id, run.id, 'research_b', 'skip'));
    expect(skipped.nodes.find((node: { key: string }) => node.key === 'research_b')).toMatchObject({ state: 'skipped', actions: ['cancel_run'] });
    await waitFor(() => ctx.store.tasks.get(b.taskId)?.state === 'cancelled');
    expect(ctx.magnus.tasks.get(b.ardentId)?.state).toBe('cancelled');
    expect(ctx.store.workflows.node(run.id, 'research_b')?.state).toBe('skipped');

    complete(a.ardentId, 'Villages noted.');
    const synthesis = await nodeTask(ctx.store, run.id, 'synthesis');
    const item = (missionOf(synthesis.ardentId).context_items ?? []).find(entry => entry.title === 'Workflow result: research_b (data)');
    expect(JSON.parse(item!.text)).toMatchObject({ node: 'research_b', state: 'skipped', result: null });
    expect(ctx.store.tasks.get(synthesis.taskId)!.execution?.inputs).toEqual([`hx1:studio:local:task:${a.taskId}`]);
    complete(synthesis.ardentId, 'Outline without roads.');
    await waitFor(() => ctx.store.workflows.run(run.id)?.state === 'completed');
  });

  it('follows a node through a clarification: the answer task completes the node', async () => {
    const { id } = await project();
    const run = await start(id, { spec: SPEC });
    const a = await nodeTask(ctx.store, run.id, 'research_a');
    const b = await nodeTask(ctx.store, run.id, 'research_b');
    ctx.magnus.event(a.ardentId, 'team_ask_user', { question: 'Which century?' });
    const clarification = await waitFor(() => ctx.store.room.messages(ctx.store.tasks.get(a.taskId)!.conversation_id!).find(message => message.kind === 'clarification'));
    ctx.magnus.finish(a.ardentId, { state: 'completed', result: JSON.stringify({ outcome: 'input_required', summary: 'Which century?' }) });
    await waitFor(() => ctx.store.tasks.get(a.taskId)?.state === 'input_required');
    expect(ctx.store.workflows.node(run.id, 'research_a')).toMatchObject({ state: 'running', task_id: a.taskId });

    const answered = await json(await ctx.call('POST', `/messages/${clarification.id}/answer`, { body: { body_md: 'The twelfth.' } }));
    const answerTask = answered.tasks[0].id as string;
    expect(ctx.store.workflows.node(run.id, 'research_a')).toMatchObject({ state: 'running', task_id: answerTask });
    const ardentAnswer = await waitFor(() => ctx.store.tasks.get(answerTask)?.ardent.task_id);
    complete(ardentAnswer, 'Twelfth-century villages.');
    complete(b.ardentId, 'Roads mapped.');
    const synthesis = await nodeTask(ctx.store, run.id, 'synthesis');
    expect(JSON.parse((missionOf(synthesis.ardentId).context_items ?? []).find(item => item.title === 'Workflow result: research_a (data)')!.text))
      .toMatchObject({ task: `hx1:studio:local:task:${answerTask}`, summary: 'Twelfth-century villages.' });
  });

  it('cancels a run with its active node tasks through the existing cancel path', async () => {
    const { id } = await project();
    const run = await start(id, { spec: SPEC });
    const a = await nodeTask(ctx.store, run.id, 'research_a');
    const b = await nodeTask(ctx.store, run.id, 'research_b');
    const response = await act(id, run.id, 'synthesis', 'cancel_run');
    expect(response.status).toBe(200);
    const cancelled = await json(response);
    expect(cancelled).toMatchObject({ state: 'cancelled', finished_at: expect.any(String) });
    expect(cancelled.nodes.map((node: { state: string; actions: string[] }) => [node.state, node.actions])).toEqual([['cancelled', []], ['cancelled', []], ['cancelled', []]]);
    await waitFor(() => ctx.store.tasks.get(a.taskId)?.state === 'cancelled' && ctx.store.tasks.get(b.taskId)?.state === 'cancelled');
    expect([ctx.magnus.tasks.get(a.ardentId)?.state, ctx.magnus.tasks.get(b.ardentId)?.state]).toEqual(['cancelled', 'cancelled']);
    expect(ctx.store.tasks.forWorkflowNode(run.id, 'synthesis', 1)).toBeUndefined();
    expect((await act(id, run.id, 'synthesis', 'cancel_run')).status).toBe(409);
  });

  it('rejects cyclic, unknown-need, two-output and oversized specs with 400, and roles the team does not have with 422', async () => {
    const { id } = await project();
    const node = (key: string, needs: string[] = [], role = 'writer') => ({ key, role, prompt: `Do ${key}.`, needs });
    const cases: Array<[string, unknown, RegExp]> = [
      ['cycle', { nodes: [node('a', ['c']), node('b', ['a']), node('c', ['b']), node('out', ['c'])], output: 'out' }, /cycle/],
      ['unknown need', { nodes: [node('a', ['ghost']), node('out', ['a'])], output: 'out' }, /unknown node "ghost"/],
      ['two outputs', { nodes: [node('a'), node('b'), node('out', ['a'])], output: 'out' }, /exactly one output/],
      ['output list', { nodes: [node('a'), node('out', ['a'])], output: ['a', 'out'] }, /.+/],
      ['unknown output', { nodes: [node('a')], output: 'missing' }, /not a node/],
      ['too many nodes', { nodes: Array.from({ length: 17 }, (_, index) => node(`n${index}`, index ? [`n${index - 1}`] : [])), output: 'n16' }, /.+/],
    ];
    for (const [name, spec, message] of cases) {
      const response = await ctx.call('POST', `/projects/${id}/workflow-runs`, { body: { spec } });
      expect(response.status, name).toBe(400);
      const body = await json(response);
      expect(body.error.code, name).toBe('VALIDATION_ERROR');
      expect((body.error.details as Array<{ message: string }>).map(issue => issue.message).join('\n'), name).toMatch(message);
    }
    const neither = await ctx.call('POST', `/projects/${id}/workflow-runs`, { body: { inputs: {} } });
    expect(neither.status).toBe(400);
    const unknownRole = await ctx.call('POST', `/projects/${id}/workflow-runs`, { body: { spec: { nodes: [node('a', [], 'bard')], output: 'a' } } });
    expect(unknownRole.status).toBe(422);
    expect((await json(unknownRole)).error).toMatchObject({ code: 'UNKNOWN_ROLE', details: { node: 'a', role: 'bard' } });
    expect(ctx.store.workflows.runs(id)).toEqual([]);
    expect(ctx.magnus.tasks.size).toBe(0);
  });

  it('starts a workflow a team template defines, and refuses template workflows with roles the template lacks', async () => {
    const { id } = await project();
    const role = (key: string, name: string, coordinator = false) => ({ key, name, coordinator, responsibilities_md: '', instructions_md: '', contributions: [], deliverables: [],
      agent_template_ref: null, skills: [], stage: null });
    const body = {
      name: 'Research team', category: 'research', purpose: 'Researches and writes.', example_uses: [],
      roles: [role('lead', 'Story Lead', true), role('writer', 'Worldbuilder'), role('mapper', 'Cartographer')],
      relationships: [{ from: 'writer', to: 'lead', type: 'reports_to' }, { from: 'mapper', to: 'lead', type: 'reports_to' }],
      stages: [], integrations: ['hivemem'], runtime_req: { ardent: null, backend: 'any' },
      workflows: [{ key: 'valley', name: 'Valley research', spec: { ...SPEC, name: undefined } }],
    };
    const bad = await ctx.call('POST', '/templates', { body: { kind: 'team', body: { ...body, workflows: [{ key: 'bad', name: 'Bad', spec: { nodes: [{ key: 'a', role: 'bard', prompt: 'Sing.' }], output: 'a' } }] } } });
    expect(bad.status).toBe(422);
    expect((await json(bad)).error.code).toBe('WORKFLOW_INVALID');
    const created = await ctx.call('POST', '/templates', { body: { kind: 'team', body } });
    expect(created.status).toBe(201);
    const template = await json(created);
    expect(template.latest.body.workflows[0]).toMatchObject({ key: 'valley', purpose: '', spec: { output: 'synthesis' } });

    const missing = await ctx.call('POST', `/projects/${id}/workflow-runs`, { body: { template_ref: { template_id: template.id, version: 1 }, workflow: 'nope' } });
    expect(missing.status).toBe(422);
    const run = await start(id, { template_ref: { template_id: template.id, version: 1 }, workflow: 'valley' });
    expect(run).toMatchObject({ name: 'Valley research', source_template: { template_id: template.id, version: 1, workflow: 'valley' }, state: 'running' });
    await nodeTask(ctx.store, run.id, 'research_a');
    await nodeTask(ctx.store, run.id, 'research_b');
  });

  it('needs the permission to create tasks in the project, and an idempotency key that replays the first answer', async () => {
    const { id } = await project();
    const viewer = await ctx.token({ sub: 'subject-viewer', permissions: ['ardentstudio:projects:read', 'ardentstudio:templates:read'] });
    const denied = await ctx.call('POST', `/projects/${id}/workflow-runs`, { token: viewer, body: { spec: SPEC } });
    expect(denied.status).toBe(403);
    expect(ctx.store.workflows.runs(id)).toEqual([]);
    expect((await ctx.call('POST', `/projects/${id}/workflow-runs`, { key: null, body: { spec: SPEC } })).status).toBe(400);

    const first = await ctx.call('POST', `/projects/${id}/workflow-runs`, { key: 'fixture-workflow-1', body: { spec: SPEC } });
    const again = await ctx.call('POST', `/projects/${id}/workflow-runs`, { key: 'fixture-workflow-1', body: { spec: SPEC } });
    expect(first.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect((await json(again)).id).toBe((await json(first)).id);
    expect(ctx.store.workflows.runs(id)).toHaveLength(1);
    const run = ctx.store.workflows.runs(id)[0]!;
    expect((await ctx.call('GET', `/projects/${id}/workflow-runs/${run.id}`, { token: viewer })).status).toBe(200);
    expect((await act(id, run.id, 'synthesis', 'cancel_run').then(async () => ctx.call('POST', `/projects/${id}/workflow-runs/${run.id}/nodes/synthesis/actions`, { token: viewer, body: { action: 'retry' } }))).status).toBe(403);

    // Node tasks follow their spec's role: reassigning one is refused.
    const other = await start(id, { spec: SPEC });
    const a = await nodeTask(ctx.store, other.id, 'research_a');
    const reassign = await ctx.call('POST', `/tasks/${a.taskId}/reassign`, { body: { role_key: 'mapper' } });
    expect(reassign.status).toBe(409);
    expect((await json(reassign)).error.code).toBe('NOT_REASSIGNABLE');
  });
});
