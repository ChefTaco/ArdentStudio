import { decodeExecutionHeader, EXECUTION_HEADER } from '@hivemagnus/hive-common/execution';
import { isValidTraceparent } from '@hivemagnus/hive-common/context';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDirectory } from '../src/agents/directory.js';
import { Conductor, type ConductorOptions } from '../src/conductor/conductor.js';
import { silentLogger } from '../src/logger.js';
import { createProject, createTestContext, json, publishTeam, waitFor, type TestContext } from './helpers.js';

let ctx: TestContext;
let restarted: Conductor | undefined;
afterEach(async () => { await restarted?.stop(); restarted = undefined; await ctx?.close(); });

async function room(options: Parameters<typeof createTestContext>[0] = {}) {
  ctx = await createTestContext(options);
  const project = await createProject(ctx, { brief_md: 'Emberfall is a one-shot adventure in a drowned valley.' });
  await publishTeam(ctx, project.id);
  const team = await json(await ctx.call('POST', `/projects/${project.id}/conversations`, { body: { kind: 'team' } }));
  return { project, team };
}

async function post(conversationId: string, body: Record<string, unknown>) {
  const response = await ctx.call('POST', `/conversations/${conversationId}/messages`, { body });
  expect(response.status).toBe(201);
  return { ...(await json(response)), requestId: response.headers.get('x-request-id') };
}

/** A new conductor on the same database, as after a Studio restart. */
function restart(options: Partial<ConductorOptions> = {}): Conductor {
  restarted = new Conductor({ store: ctx.store, blobs: ctx.blobs, magnus: ctx.magnusClient, agents: new AgentDirectory(ctx.magnusClient, ctx.store, { cacheMs: 0 }),
    live: ctx.live, logger: silentLogger, presenceMs: 3_600_000, follower: { pollMinMs: 20, pollMaxMs: 50, pollWindowMs: 300, reconnectMs: 10 }, ...options });
  restarted.start();
  return restarted;
}

const studioTask = (id: string) => ctx.store.tasks.get(id)!;
const submits = () => ctx.magnus.calls.filter(call => ['task-submit', 'mission-submit'].includes(String((call.body as { action?: string } | undefined)?.action)));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('frozen submissions', () => {
  it('resends the byte-identical body after a lost answer and a restart: one Ardent task, no idempotency conflict', async () => {
    const { team } = await room({ conductor: { submitRetryMs: 5_000, random: () => 1 } });
    ctx.magnus.dropSubmitResponses = 1;
    const posted = await post(team.id, { body_md: 'Outline the adventure.' });
    const id = posted.tasks[0].id as string;
    // Magnus took the submission, but Studio never saw the answer.
    await waitFor(() => studioTask(id).submit_attempts === 1);
    expect(ctx.magnus.tasks.size).toBe(1);
    const lost = studioTask(id);
    expect(lost.ardent.task_id).toBeNull();
    expect(lost.submit_payload).toMatchObject({ v: 1, agent_ref: 'node1~lead', action: 'mission-submit', dispatch: 'mission' });
    expect(lost.submit_next_at).toBeGreaterThan(Date.now() + 4_000);
    await ctx.conductor.stop();

    // While Studio is down the room moves on: a turn planned now would show the agent this message.
    ctx.store.tx(() => ctx.store.room.addMessage({ conversationId: team.id, author: { kind: 'user', user_id: 'operator' }, kind: 'message', bodyMd: 'Also add a ferry.', state: 'complete' }));
    // The backoff window ends while it is down.
    ctx.store.db.prepare('UPDATE tasks SET submit_next_at = ? WHERE id = ?').run(Date.now(), id);
    restart();
    await waitFor(() => studioTask(id).ardent.task_id);

    const [first, second] = submits();
    expect(submits()).toHaveLength(2);
    expect(second!.raw).toBe(first!.raw);
    expect(second!.raw).toBe(lost.submit_payload!.request);
    expect(second!.raw).not.toContain('Also add a ferry.');
    expect(ctx.magnus.conflicts).toBe(0);
    expect(ctx.magnus.tasks.size).toBe(1);
    const accepted = studioTask(id);
    expect(accepted).toMatchObject({ dispatch: 'mission', submit_next_at: null, ardent: { agent_ref: 'node1~lead', task_id: ctx.magnus.task(0).id } });
    expect(ctx.magnus.calls.filter(call => (call.body as { action?: string } | undefined)?.action === 'session-open')).toHaveLength(1);
    await waitFor(() => ctx.magnus.openStreams(accepted.ardent.task_id!) > 0);
  });

  it('waits for submit_next_at after a restart inside the backoff window, then sends the same body', async () => {
    const { team } = await room({ conductor: { submitRetryMs: 600, random: () => 1 } });
    ctx.magnus.failSubmissions = 1;
    const posted = await post(team.id, { body_md: 'Outline the adventure.' });
    const id = posted.tasks[0].id as string;
    await waitFor(() => studioTask(id).submit_attempts === 1);
    const nextAt = studioTask(id).submit_next_at!;
    expect(nextAt).toBeGreaterThan(Date.now() + 300);
    await ctx.conductor.stop();

    restart({ submitRetryMs: 600, random: () => 1 });
    await sleep(200);
    expect(submits()).toHaveLength(1);
    await waitFor(() => studioTask(id).ardent.task_id, 3_000);
    const [failed, retried] = submits();
    expect(retried!.at).toBeGreaterThanOrEqual(nextAt);
    expect(retried!.raw).toBe(failed!.raw);
    expect(studioTask(id).submit_next_at).toBeNull();
  });

  it('honours Retry-After from Magnus', async () => {
    const { team } = await room({ conductor: { random: () => 0 } });
    ctx.magnus.retryAfterSubmissions = { count: 1, seconds: 1 };
    const posted = await post(team.id, { body_md: 'Outline the adventure.' });
    const id = posted.tasks[0].id as string;
    await waitFor(() => studioTask(id).submit_attempts === 1);
    const failedAt = submits()[0]!.at;
    expect(studioTask(id).submit_next_at! - failedAt).toBeGreaterThanOrEqual(900);
    await waitFor(() => studioTask(id).ardent.task_id, 3_000);
    expect(submits()[1]!.at - failedAt).toBeGreaterThanOrEqual(900);
  });

  it('fails the task once the attempts are used up', async () => {
    const { team } = await room({ conductor: { maxSubmitAttempts: 2, submitRetryMs: 10 } });
    ctx.magnus.failSubmissions = 5;
    const posted = await post(team.id, { body_md: 'Outline the adventure.' });
    await waitFor(() => studioTask(posted.tasks[0].id).state === 'failed');
    expect(studioTask(posted.tasks[0].id).submit_attempts).toBe(2);
    expect(new Set(submits().map(call => call.raw)).size).toBe(1);
  });
});

describe('execution context on Magnus calls', () => {
  it('sends request id, traceparent and the task execution context, and keeps `execution` out of the body without lineage', async () => {
    const { team } = await room();
    const posted = await post(team.id, { body_md: 'Outline the adventure.' });
    const id = posted.tasks[0].id as string;
    await ctx.magnus.submitted(1);
    const task = studioTask(id);
    expect(task.root_ref).toBe(`hx1:studio:local:request:${posted.message.id}`);
    expect(task.parent_ref).toBe(`hx1:studio:local:request:${posted.message.id}`);
    expect(task.execution).toMatchObject({ v: 1, self: `hx1:studio:local:task:${id}`, attempt: 1, request_id: posted.requestId });
    const mission = JSON.parse(task.submit_payload!.request) as { body: { mission: { deadline: number; parent_task: unknown } } };
    expect(mission.body.mission.parent_task).toBeNull();
    expect(task.execution!.deadline_ms).toBe(mission.body.mission.deadline * 1000);

    const [submit] = submits();
    expect(submit!.body).not.toHaveProperty('execution');
    expect(submit!.headers['x-request-id']).toMatch(/^[A-Za-z0-9._:@/+=-]{1,128}$/);
    expect(isValidTraceparent(submit!.headers.traceparent as string)).toBe(true);
    expect(decodeExecutionHeader(submit!.headers[EXECUTION_HEADER] as string)).toEqual(task.execution);
    // Every call carries a request id and trace, background reads included.
    for (const call of ctx.magnus.calls) {
      expect(call.headers['x-request-id'], call.path).toBeTruthy();
      expect(isValidTraceparent(call.headers.traceparent as string), call.path).toBe(true);
    }
  });

  it('puts `execution` in the action request when the node agent reports lineage >= 1', async () => {
    const { team } = await room();
    ctx.magnus.lineage.set('node1', 1);
    const posted = await post(team.id, { body_md: 'Outline the adventure.' });
    await ctx.magnus.submitted(1);
    await waitFor(() => studioTask(posted.tasks[0].id).ardent.task_id);
    const [submit] = submits();
    const execution = studioTask(posted.tasks[0].id).execution;
    expect((submit!.body as { execution?: unknown }).execution).toEqual(execution);
    expect(Object.keys(submit!.body as object)).toEqual(['action', 'body', 'execution']);
    // Attribution only: the references never enter what the agent is told or the mission it runs under.
    expect(JSON.stringify((submit!.body as { body: unknown }).body)).not.toContain('hx1:');
    expect(decodeExecutionHeader(submit!.headers[EXECUTION_HEADER] as string)).toEqual(execution);

    ctx.magnus.lineage.set('node1', 0);
    ctx.magnus.studio.set('node1', 1);
    // A cached capability is reused for a minute; a lineage-0 node gets no field (a direct task here).
    const fresh = restart({ capabilityCacheMs: 0 });
    await ctx.conductor.stop();
    const second = await post(team.id, { body_md: '@writer name the regions.' });
    fresh.kick();
    await waitFor(() => studioTask(second.tasks[0].id).ardent.task_id);
    expect(submits().at(-1)!.body).not.toHaveProperty('execution');
  });

  it('links a hand-off to its source: parent = the Studio task, input = the source Ardent task', async () => {
    const { project, team } = await room();
    ctx.magnus.lineage.set('node2', 1);
    const posted = await post(team.id, { body_md: '@writer draft the regions.' });
    const [writer] = await ctx.magnus.submitted(1);
    await waitFor(() => studioTask(posted.tasks[0].id).ardent.task_id && ctx.magnus.openStreams(writer!.id) > 0);
    ctx.magnus.event(writer!.id, 'team_handoff', { to_role: 'mapper', objective: 'Draw the three regions as an SVG map.' });
    const [, mapper] = await ctx.magnus.submitted(2);
    const assignment = ctx.store.tasks.list(project.id).find(task => task.mode === 'assignment')!;
    const source = studioTask(posted.tasks[0].id);
    expect(assignment.root_ref).toBe(source.root_ref);
    expect(assignment.parent_ref).toBe(`hx1:studio:local:task:${source.id}`);
    expect(assignment.execution!.inputs).toEqual([`hx1:ardent:node1.scout:task:${writer!.id}`]);
    expect(assignment.execution!.request_id).toBe(source.execution!.request_id);
    await waitFor(() => submits().length === 2);
    const submit = submits()[1]!;
    expect(mapper!.ref).toBe('node2~mapper');
    expect((submit.body as { execution?: { parent?: string } }).execution?.parent).toBe(`hx1:studio:local:task:${source.id}`);
    expect((submit.body as { body: { mission: { parent_task: unknown } } }).body.mission.parent_task).toBeNull();
  });

  it('names the configured Studio instance in its references', async () => {
    const { team } = await room({ conductor: { studioInstanceId: 'studio-a1' } });
    const posted = await post(team.id, { body_md: 'Outline the adventure.' });
    await ctx.magnus.submitted(1);
    expect(studioTask(posted.tasks[0].id).root_ref).toBe(`hx1:studio:studio-a1:request:${posted.message.id}`);
  });
});
