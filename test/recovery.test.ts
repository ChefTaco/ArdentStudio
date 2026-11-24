import { afterEach, describe, expect, it } from 'vitest';
import { createProject, createTestContext, json, publishTeam, waitFor, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => { await ctx?.close(); });

async function room() {
  ctx = await createTestContext();
  const project = await createProject(ctx);
  await publishTeam(ctx, project.id);
  const team = await json(await ctx.call('POST', `/projects/${project.id}/conversations`, { body: { kind: 'team' } }));
  return { project, team };
}

/** Post a message to the lead and wait until Studio follows its Ardent task. */
async function turn(teamId: string, body = 'Outline the adventure.') {
  const posted = await json(await ctx.call('POST', `/conversations/${teamId}/messages`, { body: { body_md: body } }));
  const taskId = posted.tasks[0].id as string;
  const ardentId = await waitFor(() => ctx.store.tasks.get(taskId)?.ardent.task_id);
  await waitFor(() => ctx.magnus.openStreams(ardentId) > 0);
  return { taskId, ardentId };
}

const task = (id: string) => ctx.store.tasks.get(id)!;
const events = (projectId: string, type: string) => ctx.store.events.after(projectId, 0).filter(event => event.type === type).map(event => event.payload);
const replies = (taskId: string) => ctx.store.room.messages(ctx.store.tasks.get(taskId)!.conversation_id!).filter(message => message.links.task_id === taskId && message.kind !== 'system');
const result = (summary: string) => JSON.stringify({ outcome: 'completed', summary });

describe('task recovery', () => {
  it('holds an interrupted run as unknown with its actions, and mark_not_applied continues it to one completion message', async () => {
    const { project, team } = await room();
    ctx.magnus.enableRuntime('node1~lead');
    const { taskId, ardentId } = await turn(team.id);
    ctx.magnus.text(ardentId, 1, 'Act one: the flood');
    await waitFor(() => replies(taskId).length === 1);

    ctx.magnus.hold(ardentId);
    await waitFor(() => task(taskId).state === 'unknown');
    expect(task(taskId).recovery).toMatchObject({ status: 'awaiting_decision', reason: { code: 'UNSETTLED_EXTERNAL_WRITE' }, supported: true,
      actions: ['mark_applied', 'mark_not_applied', 'retry_with_new_deadline', 'abandon'], checkpoint: { pending_calls: [{ call_id: 'call_1', tool: 'http_post' }] } });
    expect(events(project.id, 'task.recovery')).toMatchObject([{ task_id: taskId, change: 'held', ardent_task_id: ardentId }]);
    // Held is not finished work: the streaming reply is kept for the continuation, nothing is posted.
    expect(replies(taskId)).toMatchObject([{ state: 'streaming' }]);

    const read = await json(await ctx.call('GET', `/tasks/${taskId}/recovery`));
    expect(read).toMatchObject({ supported: true, source: 'live', unavailable: null, recovery: { status: 'awaiting_decision', actions: ['mark_applied', 'mark_not_applied', 'retry_with_new_deadline', 'abandon'] },
      task: { id: taskId, state: 'unknown', recovery: { status: 'awaiting_decision' } } });

    const decided = await ctx.call('POST', `/tasks/${taskId}/recovery`, { body: { action: 'mark_not_applied', call_id: 'call_1', note: 'The webhook log shows no delivery.' } });
    expect(decided.status, await decided.clone().text()).toBe(200);
    const answer = await json(decided);
    const continuation = answer.recovery.continuation_task_id as string;
    expect(continuation).toMatch(/^[0-9a-f-]{36}$/);
    expect(answer.task).toMatchObject({ state: 'running', ardent: { task_id: continuation, attempts: [ardentId] }, recovery: { status: 'resolved', decided: { action: 'mark_not_applied' } } });
    expect(ctx.magnus.recoveryDecisions).toEqual([{ ref: 'node1~lead', target: ardentId, body: { action: 'mark_not_applied', call_id: 'call_1', note: 'The webhook log shows no delivery.' } }]);
    expect(task(taskId)).toMatchObject({ ardent: { task_id: continuation, event_cursor: expect.any(Number) }, ardent_attempts: [ardentId] });
    await waitFor(() => ctx.magnus.openStreams(continuation) > 0);
    expect(events(project.id, 'task.recovery').at(-1)).toMatchObject({ change: 'continued', ardent_task_id: continuation, previous_ardent_task_id: ardentId });

    ctx.magnus.text(continuation, 3, 'Act one: the flood. Act two: the bridge.');
    ctx.magnus.finish(continuation, { state: 'completed', result: result('Three acts: the flood, the bridge, the tower.') });
    await waitFor(() => task(taskId).state === 'completed');
    const [reply, ...more] = replies(taskId);
    expect(more).toEqual([]);
    expect(reply).toMatchObject({ kind: 'reply', state: 'complete', body_md: 'Three acts: the flood, the bridge, the tower.', ardent: { task_id: continuation } });
    expect(ctx.store.tasks.byArdentTask('node1~lead', continuation)?.id).toBe(taskId);
    expect(ctx.store.tasks.byArdentTask('node1~lead', ardentId)).toBeUndefined();
    const audit = ctx.store.db.prepare("SELECT detail_json FROM audit WHERE action = 'task.recovery'").all() as Array<{ detail_json: string }>;
    expect(audit.map(row => JSON.parse(row.detail_json))).toMatchObject([{ action: 'mark_not_applied', ardent_task_id: ardentId, continuation_task_id: continuation }]);
  });

  it('keeps following a run Ardent resumed under the same task, showing it as recovering', async () => {
    const { project, team } = await room();
    ctx.magnus.enableRuntime('node1~lead');
    const { taskId, ardentId } = await turn(team.id);
    ctx.magnus.resumeSameId(ardentId);
    await waitFor(() => (task(taskId).recovery as { status?: string } | null)?.status === 'resumed');
    expect(task(taskId)).toMatchObject({ state: expect.stringMatching(/^(queued|running)$/), ardent: { task_id: ardentId }, ardent_attempts: [] });
    expect(events(project.id, 'task.recovery')).toMatchObject([{ change: 'recovering', recovery: { status: 'resumed', actions: [] } }]);
    ctx.magnus.finish(ardentId, { state: 'completed', result: result('Done after the restart.') });
    await waitFor(() => task(taskId).state === 'completed');
    expect(replies(taskId)).toMatchObject([{ body_md: 'Done after the restart.', ardent: { task_id: ardentId } }]);
    expect(ctx.magnus.recoveryDecisions).toEqual([]);
  });

  it('offers no actions and answers a clear 409 when the agent cannot take recovery decisions', async () => {
    const { team } = await room();
    const { taskId, ardentId } = await turn(team.id);
    ctx.magnus.hold(ardentId);
    await waitFor(() => task(taskId).state === 'unknown');
    // A Magnus agent below studio 4 relays no recovery: the task ends as unknown, as before.
    expect(task(taskId).recovery).toBeNull();
    expect(replies(taskId)).toMatchObject([{ state: 'failed' }]);
    const read = await json(await ctx.call('GET', `/tasks/${taskId}/recovery`));
    expect(read).toMatchObject({ supported: false, recovery: null, source: 'stored', unavailable: { code: 'RECOVERY_UNSUPPORTED' } });
    const refused = await ctx.call('POST', `/tasks/${taskId}/recovery`, { body: { action: 'mark_not_applied' } });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toMatchObject({ code: 'RECOVERY_UNSUPPORTED', details: { capability: 'ardent.recovery.v1', required_level: 1, level: 0 } });
    expect(ctx.magnus.recoveryDecisions).toEqual([]);

    // A task record that does carry a recovery (read while polling) is kept, without actions, and the task still ends.
    ctx.magnus.failStreams = true;
    const posted = await json(await ctx.call('POST', `/conversations/${team.id}/messages`, { body: { body_md: 'Again.' } }));
    const polled = posted.tasks[0].id as string;
    const polledArdent = await waitFor(() => task(polled).ardent.task_id);
    ctx.magnus.hold(polledArdent);
    await waitFor(() => task(polled).state === 'unknown');
    expect(task(polled).recovery).toMatchObject({ status: 'awaiting_decision', supported: false, actions: [] });
    expect(replies(polled)).toMatchObject([{ state: 'failed' }]);
    expect(events(task(polled).project_id, 'task.recovery')).toMatchObject([{ task_id: polled, change: 'unsupported' }]);
  });

  it('maps a profile that turns out older than reported to 409 RECOVERY_UNSUPPORTED, and refuses decisions on tasks that are not held', async () => {
    const { team } = await room();
    ctx.magnus.enableRuntime('node1~lead');
    const running = await turn(team.id);
    const notHeld = await ctx.call('POST', `/tasks/${running.taskId}/recovery`, { body: { action: 'abandon' } });
    expect(notHeld.status).toBe(409);
    expect((await json(notHeld)).error.code).toBe('RECOVERY_UNAVAILABLE');
    ctx.magnus.hold(running.ardentId);
    await waitFor(() => task(running.taskId).state === 'unknown');
    // The cached installation still says recovery 1; Magnus answers for the profile it reaches.
    ctx.magnus.runtime.set('node1~lead', { recovery: 0, lineage: 0, artifact_transfer: 1, version: '3.1.4' });
    const refused = await ctx.call('POST', `/tasks/${running.taskId}/recovery`, { body: { action: 'mark_applied' } });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toMatchObject({ code: 'RECOVERY_UNSUPPORTED', details: { capability: 'ardent.recovery.v1', required_version: '3.2.0', installed_version: '3.1.4' } });
    const invalid = await ctx.call('POST', `/tasks/${running.taskId}/recovery`, { body: { action: 'reboot' } });
    expect(invalid.status).toBe(400);
  });

  it('ends a held task with one message when the recovery is abandoned', async () => {
    const { project, team } = await room();
    ctx.magnus.enableRuntime('node1~lead');
    const { taskId, ardentId } = await turn(team.id);
    ctx.magnus.hold(ardentId);
    await waitFor(() => task(taskId).state === 'unknown');
    const answer = await json(await ctx.call('POST', `/tasks/${taskId}/recovery`, { body: { action: 'abandon', note: 'Not worth retrying.' } }));
    expect(answer.task).toMatchObject({ state: 'unknown', ardent: { task_id: ardentId, attempts: [] }, recovery: { status: 'resolved', actions: [], decided: { action: 'abandon' } } });
    expect(replies(taskId)).toMatchObject([{ state: 'failed', body_md: expect.stringContaining('Recovery abandoned: Not worth retrying.') }]);
    expect(events(project.id, 'task.recovery').map(event => event.change)).toEqual(['held', 'resolved']);
  });

  it('follows a continuation decided elsewhere, also when the decision came while Studio was stopped', async () => {
    const { team } = await room();
    ctx.magnus.enableRuntime('node1~lead');
    const first = await turn(team.id);
    ctx.magnus.hold(first.ardentId);
    await waitFor(() => task(first.taskId).state === 'unknown');
    const elsewhere = ctx.magnus.continueElsewhere(first.ardentId, 'retry_with_new_deadline');
    const read = await json(await ctx.call('GET', `/tasks/${first.taskId}/recovery`));
    expect(read.task).toMatchObject({ state: 'running', ardent: { task_id: elsewhere.id, attempts: [first.ardentId] } });
    ctx.magnus.finish(elsewhere.id, { state: 'completed', result: result('Outline after the retry.') });
    await waitFor(() => task(first.taskId).state === 'completed');
    expect(replies(first.taskId)).toHaveLength(1);

    const second = await turn(team.id, 'Now the epilogue.');
    ctx.magnus.hold(second.ardentId);
    await waitFor(() => task(second.taskId).state === 'unknown');
    await ctx.conductor.stop();
    const later = ctx.magnus.continueElsewhere(second.ardentId);
    ctx.conductor.start();
    await waitFor(() => task(second.taskId).ardent.task_id === later.id && ctx.magnus.openStreams(later.id) > 0);
    ctx.magnus.finish(later.id, { state: 'completed', result: result('The epilogue.') });
    await waitFor(() => task(second.taskId).state === 'completed');
    expect(task(second.taskId).ardent_attempts).toEqual([second.ardentId]);
  });

  it('lets a held workflow node continue its run after the decision', async () => {
    const { project } = await room();
    ctx.magnus.enableRuntime('node1~scout');
    const started = await json(await ctx.call('POST', `/projects/${project.id}/workflow-runs`, { body: { spec: {
      nodes: [{ key: 'research', role: 'writer', prompt: 'Research the valley.' }, { key: 'outline', role: 'lead', prompt: 'Outline it.', needs: ['research'] }], output: 'outline',
    } } }));
    const nodeTaskId = await waitFor(() => ctx.store.tasks.forWorkflowNode(started.id, 'research', 1)?.id);
    const ardentId = await waitFor(() => task(nodeTaskId).ardent.task_id);
    await waitFor(() => ctx.magnus.openStreams(ardentId) > 0);
    ctx.magnus.hold(ardentId);
    await waitFor(() => ctx.store.workflows.run(started.id)?.state === 'blocked');
    const answer = await json(await ctx.call('POST', `/tasks/${nodeTaskId}/recovery`, { body: { action: 'mark_applied' } }));
    const continuation = answer.recovery.continuation_task_id as string;
    await waitFor(() => ctx.store.workflows.node(started.id, 'research')?.state === 'running');
    expect(ctx.store.workflows.run(started.id)?.state).toBe('running');
    await waitFor(() => ctx.magnus.openStreams(continuation) > 0);
    ctx.magnus.finish(continuation, { state: 'completed', result: result('Three drowned villages.') });
    await waitFor(() => ctx.store.workflows.node(started.id, 'research')?.state === 'done');
    expect(ctx.store.workflows.node(started.id, 'research')).toMatchObject({ attempt: 1, task_id: nodeTaskId, result: { summary: 'Three drowned villages.' } });
    await waitFor(() => ctx.store.tasks.forWorkflowNode(started.id, 'outline', 1));
  });
});

describe('task lineage', () => {
  it('aggregates Studio relationships, every Ardent attempt and the Emberpath filter', async () => {
    const { team } = await room();
    ctx.magnus.enableRuntime('node1~scout');
    const posted = await json(await ctx.call('POST', `/conversations/${team.id}/messages`, { body: { body_md: '@writer name the regions', to: { kind: 'roles', roles: ['writer'] } } }));
    const writerTask = posted.tasks[0].id as string;
    const writerArdent = await waitFor(() => task(writerTask).ardent.task_id);
    await waitFor(() => ctx.magnus.openStreams(writerArdent) > 0);
    ctx.magnus.event(writerArdent, 'team_handoff', { to_role: 'mapper', objective: 'Draw the regions.' });
    const mapperTask = await waitFor(() => ctx.store.tasks.list(task(writerTask).project_id).find(item => item.source.from_task === writerTask)?.id);
    ctx.magnus.hold(writerArdent);
    await waitFor(() => task(writerTask).state === 'unknown');
    const decided = await json(await ctx.call('POST', `/tasks/${writerTask}/recovery`, { body: { action: 'mark_not_applied' } }));
    const continuation = decided.recovery.continuation_task_id as string;

    const lineage = await json(await ctx.call('GET', `/tasks/${writerTask}/lineage`));
    const writer = task(writerTask);
    expect(lineage).toMatchObject({
      task_id: writerTask,
      studio: { self: writer.execution!.self, root: writer.root_ref, parent: writer.parent_ref, reassigned_from: null, reassigned_to: [], assignment_revision: 1, workflow: null,
        children: [{ task_id: mapperTask, role_key: 'mapper' }], handoffs: [{ task_id: mapperTask, direction: 'to' }] },
      ardent: { agent_ref: 'node1~scout', attempts: [
        { ardent_task_id: writerArdent, current: false, ref: `hx1:ardent:node1.scout:task:${writerArdent}`, error: null,
          lineage: { task_id: writerArdent, continuations: [{ local_task_id: continuation }] } },
        { ardent_task_id: continuation, current: true, error: null, lineage: { task_id: continuation, parent: { local_task_id: writerArdent } } },
      ] },
      ardent_unavailable: null,
      emberpath: { filter: { executionRoot: writer.root_ref } },
    });
    expect(writer.root_ref).toMatch(/^hx1:studio:local:request:/);

    // The hand-off's agent cannot answer lineage: Studio still answers its own part.
    const mapper = await json(await ctx.call('GET', `/tasks/${mapperTask}/lineage`));
    expect(mapper).toMatchObject({ studio: { parent: writer.execution!.self, handoffs: [{ task_id: writerTask, direction: 'from' }] }, emberpath: { filter: { executionRoot: writer.root_ref } } });
    expect(mapper.ardent).toBeNull();
    expect(['LINEAGE_UNSUPPORTED', 'NOT_STARTED']).toContain(mapper.ardent_unavailable.code);
  });
});
