import { afterEach, describe, expect, it } from 'vitest';
import { Conductor } from '../src/conductor/conductor.js';
import { silentLogger } from '../src/logger.js';
import type { BusMessage } from '../src/events/bus.js';
import { AgentDirectory } from '../src/agents/directory.js';
import { createProject, createTestContext, json, publishTeam, teamRole, waitFor, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => { await ctx?.close(); });

async function room(options: Parameters<typeof createTestContext>[0] = {}) {
  ctx = await createTestContext(options);
  const project = await createProject(ctx, { brief_md: 'Emberfall is a one-shot adventure in a drowned valley.', constraints: ['Keep it under 20 pages'] });
  await publishTeam(ctx, project.id);
  const team = await json(await ctx.call('POST', `/projects/${project.id}/conversations`, { body: { kind: 'team' } }));
  return { project, team };
}

async function post(conversationId: string, body: Record<string, unknown>) {
  const response = await ctx.call('POST', `/conversations/${conversationId}/messages`, { body });
  expect(response.status).toBe(201);
  return json(response);
}

const studioTask = (id: string) => ctx.store.tasks.get(id)!;
const followed = (id: string) => waitFor(() => ctx.store.tasks.get(id)?.ardent.task_id && ctx.magnus.openStreams(ctx.store.tasks.get(id)!.ardent.task_id!) > 0);

describe('conductor dispatch', () => {
  it('sends a Team message to the coordinator as a mission in its own session, with the brief on the first turn only', async () => {
    const { project, team } = await room();
    const first = await post(team.id, { body_md: 'Outline the adventure.' });
    expect(first.message).toMatchObject({ kind: 'message', addressees: ['lead'], author: { kind: 'user', user_id: 'operator' } });
    expect(first.tasks).toMatchObject([{ mode: 'turn', role_key: 'lead', state: 'queued', trigger_message_id: first.message.id }]);
    const [submitted] = await ctx.magnus.submitted(1);
    expect(submitted).toMatchObject({ ref: 'node1~lead', context: 'mission' });
    const mission = submitted!.body as Record<string, any>;
    expect(mission.objective).toContain('Story Lead project instructions.');
    expect(mission.objective).toContain('Emberfall is a one-shot adventure');
    expect(mission.objective).toContain('Message for you from operator:\nOutline the adventure.');
    expect(mission.mission).toMatchObject({ id: first.tasks[0].id, revision: 1, parent_task: null, allowed_actions: ['observe', 'analyze', 'create_artifact', 'create_draft'] });
    expect(mission.mission.resources).toEqual(['tool:team_handoff', 'tool:team_ask_user', 'tool:team_propose_decision', 'tool:artifact_write', 'tool:document_render',
      'tool:development_note', `project:${project.id.toLowerCase()}`]);
    expect(mission.labels).toEqual({ 'studio.project': project.id, 'studio.task': first.tasks[0].id, 'studio.conversation': team.id, 'studio.role': 'lead' });
    const session = [...ctx.magnus.sessions.values()][0]!;
    expect(session).toMatchObject({ key: `studio:${project.id}:${team.id}:lead`, context: 'mission' });
    expect(submitted!.session_id).toBe(session.id);
    await waitFor(() => studioTask(first.tasks[0].id).ardent.task_id);
    expect(studioTask(first.tasks[0].id)).toMatchObject({ dispatch: 'mission', ardent: { agent_ref: 'node1~lead', task_id: submitted!.id, session_id: session.id } });

    ctx.magnus.finish(submitted!.id, { state: 'completed', result: JSON.stringify({ outcome: 'partial', summary: 'Three acts: the flood, the bridge, the tower.' }) });
    await waitFor(() => studioTask(first.tasks[0].id).state === 'completed');
    const second = await post(team.id, { body_md: 'Make act two shorter.' });
    const [, next] = await ctx.magnus.submitted(2);
    expect(next!.session_id).toBe(session.id);
    const objective = (next!.body as { objective: string }).objective;
    expect(objective).not.toContain('Emberfall is a one-shot adventure');
    expect(objective).toContain('Story Lead project instructions.');
    expect(objective).toContain('Message for you from operator:\nMake act two shorter.');
    // The agent's own reply is in its session already; nothing else is new.
    expect(objective).not.toContain('Room messages since your last turn');
    expect(second.tasks[0].role_key).toBe('lead');
  });

  it('runs @mentioned roles one after another so each sees the replies before theirs', async () => {
    const { team } = await room();
    const posted = await post(team.id, { body_md: '@writer propose three region names, then @mapper sketch them.' });
    expect(posted.tasks.map((task: { role_key: string; group_position: number }) => [task.role_key, task.group_position])).toEqual([['writer', 0], ['mapper', 1]]);
    const [writer] = await ctx.magnus.submitted(1);
    expect(writer!.ref).toBe('node1~scout');
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(ctx.magnus.tasks.size).toBe(1);
    expect(ctx.store.room.activity(posted.message.project_id).find(item => item.binding_id === posted.tasks[1].binding_id))
      .toMatchObject({ state: 'waiting', label: 'Waiting for Worldbuilder' });
    ctx.magnus.finish(writer!.id, { state: 'completed', result: JSON.stringify({ outcome: 'partial', summary: 'Fenmarch, Saltreach and the Drowned Steps.' }) });
    const [, mapper] = await ctx.magnus.submitted(2);
    expect(mapper!.ref).toBe('node2~mapper');
    expect((mapper!.body as { objective: string }).objective).toContain('[Worldbuilder] Fenmarch, Saltreach and the Drowned Steps.');
  });

  it('sends a mission even when the fleet profile list cannot be read', async () => {
    const { team } = await room();
    ctx.magnus.failProfiles = true;
    const posted = await post(team.id, { body_md: 'Outline the adventure.' });
    const [mission] = await ctx.magnus.submitted(1);
    expect(mission!.context).toBe('mission');
    await waitFor(() => studioTask(posted.tasks[0].id).dispatch === 'mission');
  });

  it('falls back to task-submit with a composed prompt on agents without missions, and without a session below studio 1', async () => {
    const { project, team } = await room();
    ctx.magnus.studio.set('node1', 1);
    await post(team.id, { body_md: 'Outline the adventure.' });
    const [turn] = await ctx.magnus.submitted(1);
    expect(turn!.context).toBe('direct');
    expect(turn!.prompt).toContain('Emberfall is a one-shot adventure');
    expect(turn!.prompt).toContain('You cannot hand work to other roles');
    expect(turn!.prompt.length).toBeLessThanOrEqual(16_000);
    expect(turn!.session_id).toBe([...ctx.magnus.sessions.values()][0]!.id);
    expect([...ctx.magnus.sessions.values()][0]).toMatchObject({ key: `studio:${project.id}:${team.id}:lead`, context: 'direct' });
    expect(turn!.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await waitFor(() => ctx.store.tasks.list(project.id)[0]!.dispatch === 'turn');

    ctx.magnus.studio.set('node2', 0);
    await post(team.id, { body_md: '@mapper draw the valley' });
    const [, plain] = await ctx.magnus.submitted(2);
    expect(plain!.session_id).toBeNull();
    expect(ctx.magnus.calls.filter(call => (call.body as { action?: string } | undefined)?.action === 'session-open')).toHaveLength(1);
  });

  it('retries a submission Magnus could not take with the same idempotency key, then reports a failure in the room', async () => {
    const { project, team } = await room({ conductor: { maxSubmitAttempts: 3 } });
    ctx.magnus.failSubmissions = 1;
    await post(team.id, { body_md: 'Outline it.' });
    const [submitted] = await ctx.magnus.submitted(1);
    const task = ctx.store.tasks.list(project.id)[0]!;
    await waitFor(() => studioTask(task.id).ardent.task_id === submitted!.id);
    expect(studioTask(task.id).submit_attempts).toBe(1);

    ctx.magnus.failSubmissions = 5;
    const second = await post(team.id, { body_md: 'Again.' });
    await waitFor(() => studioTask(second.tasks[0].id).state === 'failed');
    expect(studioTask(second.tasks[0].id).submit_attempts).toBe(3);
    const note = ctx.store.room.messages(team.id).at(-1)!;
    expect(note).toMatchObject({ kind: 'system', author: { kind: 'system' } });
    expect(note.body_md).toContain('Magnus could not start the turn: Ardent node unavailable');
  });

  it('refuses messages without a published team or with unbound roles', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const team = await json(await ctx.call('POST', `/projects/${project.id}/conversations`, { body: { kind: 'team' } }));
    expect((await json(await ctx.call('POST', `/projects/${project.id}/conversations`, { body: { kind: 'team' } }))).id).toBe(team.id);
    const none = await ctx.call('POST', `/conversations/${team.id}/messages`, { body: { body_md: 'Hello' } });
    expect(none.status).toBe(409);
    expect((await json(none)).error.code).toBe('TEAM_NOT_READY');
    await publishTeam(ctx, project.id, { roles: [teamRole('lead', 'Lead', 'node1~lead', { coordinator: true }), teamRole('mapper', 'Mapper', null)], relationships: [{ from: 'mapper', to: 'lead', type: 'reports_to' }] });
    const unbound = await ctx.call('POST', `/conversations/${team.id}/messages`, { body: { body_md: 'Hi', to: { kind: 'roles', roles: ['mapper'] } } });
    expect(unbound.status).toBe(409);
    expect((await json(unbound)).error.details).toEqual({ roles: ['mapper'] });
  });
});

describe('conductor following', () => {
  it('relays live text as ephemeral deltas in order and completes the message once with the authoritative final text', async () => {
    const { project, team } = await room();
    const seen: BusMessage[] = [];
    ctx.bus.subscribe(project.id, message => seen.push(message));
    const posted = await post(team.id, { body_md: 'Outline it.' });
    const [ardent] = await ctx.magnus.submitted(1);
    await followed(posted.tasks[0].id);
    ctx.magnus.event(ardent!.id, 'model_started', {});
    ctx.magnus.delta(ardent!.id, 1, 'The Fen');
    ctx.magnus.delta(ardent!.id, 1, 'march ');
    ctx.magnus.delta(ardent!.id, 1, 'floods.');
    const message = await waitFor(() => ctx.store.room.messageForArdentTask(ardent!.id));
    await waitFor(() => ctx.live.get(message.id)?.text === 'The Fenmarch floods.');
    expect(message).toMatchObject({ state: 'streaming', kind: 'reply', author: { kind: 'agent', role_key: 'lead' }, reply_to: posted.message.id });
    ctx.magnus.finish(ardent!.id, { state: 'completed', result: JSON.stringify({ outcome: 'partial', summary: 'The Fenmarch floods every spring.' }) });
    await waitFor(() => studioTask(posted.tasks[0].id).state === 'completed');

    const relevant = seen.filter(item => item.kind === 'ephemeral' ? item.type === 'message.delta' : ['message.created', 'message.updated'].includes(item.event.type) && (item.event.payload.message as { id: string }).id === message.id);
    expect(relevant.map(item => item.kind === 'ephemeral' ? `delta:${String(item.payload.mode)}:${String(item.payload.text)}` : item.event.type)).toEqual([
      'message.created', 'delta:append:The Fen', 'delta:append:march ', 'delta:append:floods.', 'message.updated',
    ]);
    expect(relevant.filter(item => item.kind === 'ephemeral').every(item => item.kind === 'ephemeral' && item.payload.message_id === message.id)).toBe(true);
    expect(ctx.store.room.message(message.id)).toMatchObject({ state: 'complete', body_md: 'The Fenmarch floods every spring.' });
    expect(ctx.live.get(message.id)).toBeUndefined();
    expect(studioTask(posted.tasks[0].id).outcome).toMatchObject({ ardent_state: 'completed', reply_message_id: message.id, team_result: { outcome: 'partial' } });

    // A replayed completion (a second follower, a poll) changes nothing.
    ctx.conductor.complete(posted.tasks[0].id, { id: ardent!.id, state: 'completed', result: '{"outcome":"partial","summary":"Different text"}' });
    expect(ctx.store.room.message(message.id)!.body_md).toBe('The Fenmarch floods every spring.');
    expect(ctx.store.room.messages(team.id).filter(item => item.ardent?.task_id === ardent!.id)).toHaveLength(1);
  });

  it('writes a reply that never streamed, and reports a failed task in its message', async () => {
    const { team } = await room();
    const posted = await post(team.id, { body_md: '@writer and @mapper, go.' });
    const [writer] = await ctx.magnus.submitted(1);
    await followed(posted.tasks[0].id);
    ctx.magnus.finish(writer!.id, { state: 'completed', result: JSON.stringify({ outcome: 'partial', summary: 'Done quietly.' }) });
    const [, mapper] = await ctx.magnus.submitted(2);
    await followed(posted.tasks[1].id);
    ctx.magnus.finish(mapper!.id, { state: 'failed', error: 'Model endpoint refused the request' });
    await waitFor(() => studioTask(posted.tasks[1].id).state === 'failed');
    expect(ctx.store.room.messageForArdentTask(writer!.id)).toMatchObject({ state: 'complete', body_md: 'Done quietly.' });
    expect(ctx.store.room.messageForArdentTask(mapper!.id)).toMatchObject({ state: 'failed', body_md: 'The task failed: Model endpoint refused the request' });
  });

  it('resumes after a restart from the stored journal cursor and finishes the streaming message', async () => {
    const { project, team } = await room();
    const posted = await post(team.id, { body_md: 'Outline it.' });
    const [ardent] = await ctx.magnus.submitted(1);
    await followed(posted.tasks[0].id);
    ctx.magnus.setState(ardent!.id, 'running');
    ctx.magnus.event(ardent!.id, 'model_started', {});
    ctx.magnus.delta(ardent!.id, 1, 'Act one: ');
    await waitFor(() => studioTask(posted.tasks[0].id).ardent.event_cursor === 2 && ctx.store.room.messageForArdentTask(ardent!.id));
    await ctx.conductor.stop();
    // Events while the service is down.
    ctx.magnus.event(ardent!.id, 'tool_attempt', { id: 'call-1', name: 'memory_search', args: {} });
    ctx.magnus.delta(ardent!.id, 1, 'the flood.');
    const opened = ctx.magnus.calls.length;

    const restarted = new Conductor({ store: ctx.store, blobs: ctx.blobs, magnus: ctx.magnusClient, agents: new AgentDirectory(ctx.magnusClient, ctx.store, { cacheMs: 0 }),
      live: ctx.live, logger: silentLogger, presenceMs: 3_600_000, follower: { pollMinMs: 20, pollMaxMs: 50, pollWindowMs: 300, reconnectMs: 10 } });
    ctx.conductor = restarted;
    restarted.start();
    await waitFor(() => studioTask(posted.tasks[0].id).ardent.event_cursor === 3);
    const resumed = ctx.magnus.calls.slice(opened).find(call => call.path.endsWith('/stream'));
    expect(resumed).toBeDefined();
    const message = ctx.store.room.messageForArdentTask(ardent!.id)!;
    await waitFor(() => ctx.live.get(message.id)?.text === 'Act one: the flood.');
    expect(ctx.store.room.activity(project.id).find(item => item.binding_id === posted.tasks[0].binding_id)).toMatchObject({ state: 'working', label: 'Working: Outline it. · memory_search' });
    ctx.magnus.finish(ardent!.id, { state: 'completed', result: JSON.stringify({ outcome: 'partial', summary: 'Act one: the flood. Act two: the bridge.' }) });
    await waitFor(() => ctx.store.room.message(message.id)!.state === 'complete');
    expect(ctx.store.room.message(message.id)!.body_md).toBe('Act one: the flood. Act two: the bridge.');
    expect(studioTask(posted.tasks[0].id).state).toBe('completed');
  });

  it('reconnects after Ardent ends a stream and polls the journal when the stream fails', async () => {
    const { team } = await room();
    ctx.magnus.streamLimitMs = 60;
    const posted = await post(team.id, { body_md: 'Outline it.' });
    const [ardent] = await ctx.magnus.submitted(1);
    await followed(posted.tasks[0].id);
    await waitFor(() => ctx.magnus.streamsOpened >= 3);
    ctx.magnus.failStreams = true;
    ctx.magnus.dropStreams(ardent!.id);
    await waitFor(() => ctx.conductor.followerOf(posted.tasks[0].id)?.mode === 'poll');
    ctx.magnus.event(ardent!.id, 'team_propose_decision', { title: 'Map scale', statement: 'Use 1 inch to 1 mile.' });
    await waitFor(() => ctx.store.room.messages(team.id).find(message => message.kind === 'decision_proposal'));
    ctx.magnus.finish(ardent!.id, { state: 'completed', result: JSON.stringify({ outcome: 'partial', summary: 'Proposed a scale.' }) });
    await waitFor(() => studioTask(posted.tasks[0].id).state === 'completed');
    expect(ctx.store.room.messageForArdentTask(ardent!.id)!.body_md).toBe('Proposed a scale.');
  });
  it('finishes a turn that asked for input when the task could not be read right after its state event', async () => {
    const { team } = await room();
    ctx.magnus.streamLimitMs = 60;
    const posted = await post(team.id, { body_md: 'Outline it.' });
    const [ardent] = await ctx.magnus.submitted(1);
    await followed(posted.tasks[0].id);
    const task = ctx.magnusClient.task.bind(ctx.magnusClient);
    let reads = 0;
    ctx.magnusClient.task = async (...args) => { if (reads++ === 0) throw new Error('Magnus unavailable'); return task(...args); };
    // Ardent keeps input_required out of its stream's done set: the stream just ends.
    ctx.magnus.finish(ardent!.id, { state: 'input_required', result: 'Which tone: grim or hopeful?' });
    await waitFor(() => studioTask(posted.tasks[0].id).state === 'input_required');
    expect(reads).toBeGreaterThan(1);
    expect(ctx.store.room.messageForArdentTask(ardent!.id)!.body_md).toBe('Which tone: grim or hopeful?');
    await waitFor(() => ctx.conductor.followerOf(posted.tasks[0].id) === undefined);
  });

  it('finishes a task whose journal pages Magnus cannot relay', async () => {
    const { team } = await room();
    const posted = await post(team.id, { body_md: 'Outline it.' });
    const [ardent] = await ctx.magnus.submitted(1);
    await followed(posted.tasks[0].id);
    ctx.magnus.failStreams = true;
    ctx.magnus.failEvents = true;
    ctx.magnus.dropStreams(ardent!.id);
    await waitFor(() => ctx.conductor.followerOf(posted.tasks[0].id)?.mode === 'poll');
    ctx.magnus.finish(ardent!.id, { state: 'failed', error: 'CONTEXT_BUDGET_EXCEEDED' });
    await waitFor(() => studioTask(posted.tasks[0].id).state === 'failed');
    expect(ctx.store.room.messageForArdentTask(ardent!.id)?.body_md ?? '').toContain('CONTEXT_BUDGET_EXCEEDED');
  });
});

describe('agent requests', () => {
  it('starts a hand-off along a team edge and explains a refused one', async () => {
    const { project, team } = await room();
    const posted = await post(team.id, { body_md: '@writer draft the regions.' });
    const [writer] = await ctx.magnus.submitted(1);
    await followed(posted.tasks[0].id);
    ctx.magnus.event(writer!.id, 'team_handoff', { to_role: 'mapper', objective: 'Draw the three regions as an SVG map.', deliverables: ['Region Map'] });
    ctx.magnus.event(writer!.id, 'team_handoff', { to_role: 'lead', objective: 'Approve my outline.' });
    ctx.magnus.event(writer!.id, 'team_handoff', { to_role: 'bard', objective: 'Write a song.' });
    await waitFor(() => studioTask(posted.tasks[0].id).ardent.event_cursor === 3);
    const messages = ctx.store.room.messages(team.id);
    const handoff = messages.find(message => message.kind === 'handoff')!;
    expect(handoff).toMatchObject({ author: { kind: 'agent', role_key: 'writer' }, addressees: ['mapper'], body_md: 'Handed off to Cartographer: Draw the three regions as an SVG map.' });
    const assignment = ctx.store.tasks.list(project.id).find(task => task.mode === 'assignment')!;
    expect(assignment).toMatchObject({ role_key: 'mapper', assignment_revision: 1, conversation_id: team.id, source: { handoff_from: 'writer', from_task: posted.tasks[0].id, relationship: 'hands_off_to' } });
    expect(assignment.instructions_md).toContain('Deliverables: Region Map');
    const refused = messages.filter(message => message.kind === 'system');
    expect(refused.map(message => message.body_md)).toEqual([
      expect.stringContaining('Team r1 has no delegates_to or hands_off_to relationship from Worldbuilder to Story Lead, so Studio did not start it.'),
      expect.stringContaining('Team r1 has no such role, so Studio did not start it.'),
    ]);
    expect(ctx.store.tasks.list(project.id).filter(task => task.role_key === 'lead')).toHaveLength(0);
    const [, mapper] = await ctx.magnus.submitted(2);
    expect((mapper!.body as { objective: string }).objective).toContain('Assignment: Draw the three regions as an SVG map.');
    expect((mapper!.body as { mission: { acceptance_criteria: string[] } }).mission.acceptance_criteria).toEqual(['Complete: Draw the three regions as an SVG map.']);
  });

  it('turns a question into a clarification whose answer continues the same session', async () => {
    const { project, team } = await room();
    const posted = await post(team.id, { body_md: 'Outline it.' });
    const [ardent] = await ctx.magnus.submitted(1);
    await followed(posted.tasks[0].id);
    ctx.magnus.event(ardent!.id, 'team_ask_user', { question: 'Which tone: grim or hopeful?', options: ['Grim', 'Hopeful'] });
    const clarification = await waitFor(() => ctx.store.room.messages(team.id).find(message => message.kind === 'clarification'));
    expect(clarification).toMatchObject({ body_md: 'Which tone: grim or hopeful?', links: { task_id: posted.tasks[0].id, options: ['Grim', 'Hopeful'], answer_message_id: null } });
    expect(ctx.store.room.activity(project.id).find(item => item.binding_id === posted.tasks[0].binding_id)).toMatchObject({ state: 'asking', label: 'Asking: Which tone: grim or hopeful?' });
    ctx.magnus.finish(ardent!.id, { state: 'completed', result: JSON.stringify({ outcome: 'input_required', summary: 'I need the tone first.' }) });
    await waitFor(() => studioTask(posted.tasks[0].id).state === 'input_required');

    const answered = await ctx.call('POST', `/messages/${clarification.id}/answer`, { body: { option: 'Hopeful', body_md: 'With a bittersweet ending.' } });
    expect(answered.status).toBe(201);
    const answer = await json(answered);
    expect(answer.message).toMatchObject({ kind: 'answer', reply_to: clarification.id, body_md: 'Hopeful\n\nWith a bittersweet ending.' });
    expect(studioTask(posted.tasks[0].id).state).toBe('completed');
    const [first, next] = await ctx.magnus.submitted(2);
    expect(next!.session_id).toBe(first!.session_id);
    expect((next!.body as { objective: string }).objective).toContain('operator answered "Which tone: grim or hopeful?":\nHopeful');
    expect((await ctx.call('POST', `/messages/${clarification.id}/answer`, { body: { body_md: 'Again' } })).status).toBe(409);
  });

  it('does not repeat the question as a reply when Ardent summarizes the turn with it', async () => {
    const { team } = await room();
    const posted = await post(team.id, { body_md: 'Outline it.' });
    const [ardent] = await ctx.magnus.submitted(1);
    await followed(posted.tasks[0].id);
    ctx.magnus.event(ardent!.id, 'team_ask_user', { question: 'Which tone: grim or hopeful?', options: ['Grim', 'Hopeful'] });
    await waitFor(() => ctx.store.room.messages(team.id).find(message => message.kind === 'clarification'));
    ctx.magnus.finish(ardent!.id, { state: 'completed', result: JSON.stringify({ outcome: 'input_required', summary: 'Which tone: grim or hopeful?' }) });
    await waitFor(() => studioTask(posted.tasks[0].id).state === 'input_required');
    expect(ctx.store.room.messages(team.id).map(message => message.kind)).toEqual(['message', 'clarification']);
  });

  it('records a proposal as a card that only a person pins', async () => {
    const { project, team } = await room();
    const posted = await post(team.id, { body_md: 'Pick a map scale.' });
    const [ardent] = await ctx.magnus.submitted(1);
    await followed(posted.tasks[0].id);
    ctx.magnus.event(ardent!.id, 'team_propose_decision', { title: 'Map scale', statement: 'One inch to one mile.', rationale: 'Fits a page.' });
    const proposal = await waitFor(() => ctx.store.room.messages(team.id).find(message => message.kind === 'decision_proposal'));
    expect(proposal.links).toMatchObject({ proposal: { title: 'Map scale', statement: 'One inch to one mile.', rationale: 'Fits a page.' }, decision_id: null });
    expect(ctx.store.room.decisions(project.id)).toEqual([]);
    const pinned = await json(await ctx.call('POST', `/projects/${project.id}/decisions`, { body: { title: 'Map scale', statement_md: 'One inch to one mile.', source_message_id: proposal.id } }));
    expect(pinned).toMatchObject({ decided_by: 'operator', sources: [{ kind: 'message', ref: proposal.id }], superseded_by: null });
    expect(ctx.store.room.message(proposal.id)!.links.decision_id).toBe(pinned.id);
    const next = await json(await ctx.call('POST', `/decisions/${pinned.id}/supersede`, { body: { title: 'Map scale', statement_md: 'Two inches to one mile.' } }));
    expect(ctx.store.room.decision(pinned.id)!.superseded_by).toBe(next.id);
    expect((await ctx.call('POST', `/decisions/${pinned.id}/supersede`, { body: { title: 'x', statement_md: 'y' } })).status).toBe(409);
  });
});

describe('discussions', () => {
  it('runs round-robin rounds, then a coordinator summary', async () => {
    const { project } = await room();
    const created = await ctx.call('POST', `/projects/${project.id}/conversations`, { body: { kind: 'discussion', question: 'Which map scale?', desired_output: 'decision', participants: ['writer', 'mapper'], max_rounds: 2 } });
    expect(created.status).toBe(201);
    const discussion = await json(created);
    expect(discussion.discussion).toMatchObject({ round: 1, state: 'running', participants: ['writer', 'mapper'] });
    const order: string[] = [];
    for (let index = 0; index < 4; index++) {
      const tasks = await ctx.magnus.submitted(index + 1);
      const current = tasks[index]!;
      order.push(current.ref);
      const studio = await waitFor(() => ctx.store.tasks.list(project.id).find(task => task.ardent.task_id === current.id));
      await followed(studio.id);
      if (index === 2) expect((current.body as { objective: string }).objective).toContain('Round 2 of 2');
      if (index === 1) expect((current.body as { objective: string }).objective).toContain('[Worldbuilder] Scale view 0');
      ctx.magnus.finish(current.id, { state: 'completed', result: JSON.stringify({ outcome: 'partial', summary: `Scale view ${index}` }) });
    }
    expect(order).toEqual(['node1~scout', 'node2~mapper', 'node1~scout', 'node2~mapper']);
    const summary = (await ctx.magnus.submitted(5))[4]!;
    expect(summary.ref).toBe('node1~lead');
    expect((summary.body as { objective: string }).objective).toContain('summarize it as the desired output');
    const studio = await waitFor(() => ctx.store.tasks.list(project.id).find(task => task.ardent.task_id === summary.id));
    await followed(studio.id);
    ctx.magnus.finish(summary.id, { state: 'completed', result: JSON.stringify({ outcome: 'partial', summary: 'Decision: one inch to one mile.' }) });
    await waitFor(() => ctx.store.room.conversation(discussion.id)!.discussion!.state === 'done');
    expect(ctx.store.room.messages(discussion.id).map(message => message.kind)).toEqual(['discussion_question', 'reply', 'reply', 'reply', 'reply', 'summary']);
  });

  it('stops: unstarted turns are cancelled and the running one is cancelled through Magnus', async () => {
    const { project } = await room();
    const discussion = await json(await ctx.call('POST', `/projects/${project.id}/conversations`, { body: { kind: 'discussion', question: 'Scale?', desired_output: 'options', participants: ['writer', 'mapper'], max_rounds: 3 } }));
    const [first] = await ctx.magnus.submitted(1);
    const running = await waitFor(() => ctx.store.tasks.list(project.id).find(task => task.ardent.task_id === first!.id));
    await followed(running.id);
    const stopped = await json(await ctx.call('POST', `/conversations/${discussion.id}/stop`));
    expect(stopped).toMatchObject({ discussion: { state: 'stopped' } });
    expect(stopped.stopped_at).not.toBeNull();
    await waitFor(() => ctx.store.tasks.list(project.id).every(task => task.state === 'cancelled'));
    expect(ctx.magnus.tasks.get(first!.id)!.state).toBe('cancelled');
    expect(ctx.magnus.tasks.size).toBe(1);
    expect((await ctx.call('POST', `/conversations/${discussion.id}/messages`, { body: { body_md: 'More?' } })).status).toBe(409);
  });
});

describe('task controls and presence', () => {
  it('pauses, resumes, cancels and reassigns, with explicit pausing feedback', async () => {
    const { project, team } = await room();
    const created = await json(await ctx.call('POST', `/projects/${project.id}/tasks`, { body: { title: 'Draw the map', instructions_md: 'SVG, three regions.', role_key: 'mapper' } }));
    expect(created).toMatchObject({ mode: 'assignment', conversation_id: team.id, instructions_md: 'SVG, three regions.' });
    const [ardent] = await ctx.magnus.submitted(1);
    await followed(created.id);
    ctx.magnus.setState(ardent!.id, 'running');
    await waitFor(() => studioTask(created.id).state === 'running');
    const pausing = await json(await ctx.call('POST', `/tasks/${created.id}/pause`));
    expect(pausing.state).toBe('pausing');
    ctx.magnus.event(ardent!.id, 'paused', {});
    await waitFor(() => studioTask(created.id).state === 'paused');
    expect((await json(await ctx.call('POST', `/tasks/${created.id}/resume`))).state).toBe('running');

    const reassigned = await ctx.call('POST', `/tasks/${created.id}/reassign`, { body: { role_key: 'writer' } });
    expect(reassigned.status).toBe(201);
    const next = await json(reassigned);
    expect(next).toMatchObject({ reassigned_from: created.id, role_key: 'writer', title: 'Draw the map' });
    await waitFor(() => studioTask(created.id).state === 'cancelled');
    const [, writer] = await ctx.magnus.submitted(2);
    await followed(next.id);
    expect((await json(await ctx.call('POST', `/tasks/${next.id}/cancel`))).state).toBe('cancelled');
    expect(ctx.magnus.tasks.get(writer!.id)!.state).toBe('cancelled');
    expect((await ctx.call('POST', `/tasks/${next.id}/cancel`)).status).toBe(409);
    const active = await json(await ctx.call('GET', `/projects/${project.id}/tasks?state=active`));
    expect(active.tasks).toEqual([]);
  });

  it('reports an agent that cannot pause instead of pretending', async () => {
    const { project } = await room();
    ctx.magnus.studio.set('node2', 1);
    const created = await json(await ctx.call('POST', `/projects/${project.id}/tasks`, { body: { title: 'Draw', role_key: 'mapper' } }));
    await followed(created.id);
    const refused = await ctx.call('POST', `/tasks/${created.id}/pause`);
    expect(refused.status).toBe(409);
    expect((await json(refused)).error.code).toBe('AGENT_UPGRADE_REQUIRED');
    expect(studioTask(created.id).state).toBe('queued');
  });

  it('holds an unstarted task and probes presence as Available or Offline only', async () => {
    const { project, team } = await room();
    await ctx.conductor.probe();
    const activity = () => Object.fromEntries(ctx.store.room.activity(project.id).map(item => [ctx.store.team.bindings().find(binding => binding.id === item.binding_id)!.agent_ref, item.state]));
    expect(activity()).toEqual({ 'node1~lead': 'available', 'node1~scout': 'available', 'node2~mapper': 'available' });
    ctx.magnus.profiles = ctx.magnus.profiles.map(item => item.id === 'mapper' ? { ...item, running: false } : item);
    await ctx.conductor.probe();
    expect(activity()['node2~mapper']).toBe('offline');
    const events = ctx.store.events.after(project.id, 0).filter(event => event.type === 'presence.updated');
    expect(events.at(-1)!.payload).toMatchObject({ agent_ref: 'node2~mapper', state: 'offline', label: 'Offline' });

    const posted = await post(team.id, { body_md: '@writer one, @mapper two' });
    const [writer] = await ctx.magnus.submitted(1);
    const held = await json(await ctx.call('POST', `/tasks/${posted.tasks[1].id}/pause`));
    expect(held.state).toBe('paused');
    await followed(posted.tasks[0].id);
    ctx.magnus.finish(writer!.id, { state: 'completed', result: '{"outcome":"partial","summary":"One."}' });
    await waitFor(() => studioTask(posted.tasks[0].id).state === 'completed');
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(ctx.magnus.tasks.size).toBe(1);
    expect((await json(await ctx.call('POST', `/tasks/${posted.tasks[1].id}/resume`))).state).toBe('queued');
    await ctx.magnus.submitted(2);
    // The probe never claims work: an agent with an active task keeps its task-derived state.
    await ctx.conductor.probe();
    expect(activity()['node1~scout']).toBe('available');
  });
});

describe('derived activity', () => {
  const activityOf = (projectId: string, bindingId: string) => ctx.store.room.activity(projectId).find(item => item.binding_id === bindingId);

  it('shows Working only once the journal shows the model started, and Blocked after a failure until new work', async () => {
    const { project, team } = await room();
    const posted = await post(team.id, { body_md: 'Outline it.' });
    const [ardent] = await ctx.magnus.submitted(1);
    await followed(posted.tasks[0].id);
    ctx.magnus.setState(ardent!.id, 'running');
    await waitFor(() => studioTask(posted.tasks[0].id).state === 'running');
    const binding = posted.tasks[0].binding_id;
    await waitFor(() => activityOf(project.id, binding)?.label === 'Starting: Outline it.');
    expect(activityOf(project.id, binding)!.state).toBe('queued');
    ctx.magnus.event(ardent!.id, 'model_started', {});
    await waitFor(() => activityOf(project.id, binding)?.state === 'working');
    expect(studioTask(posted.tasks[0].id).progress).toEqual({ model_started: true, tool: null });
    ctx.magnus.finish(ardent!.id, { state: 'failed', error: 'The model provider refused the request' });
    await waitFor(() => activityOf(project.id, binding)?.state === 'blocked');
    expect(activityOf(project.id, binding)).toMatchObject({ label: 'Blocked: The model provider refused the request', source: { task_id: posted.tasks[0].id, kind: 'outcome' } });
    const blocked = ctx.store.events.after(project.id, 0).filter(event => event.type === 'presence.updated').at(-1)!;
    expect(blocked.payload).toMatchObject({ state: 'blocked', agent_ref: 'node1~lead' });

    await post(team.id, { body_md: 'Try again.' });
    await ctx.magnus.submitted(2);
    await waitFor(() => activityOf(project.id, binding)?.state === 'queued');
  });

  it('shows the agent that handed work off as Waiting for that role', async () => {
    const { project, team } = await room();
    const posted = await post(team.id, { body_md: '@writer draft the regions.' });
    const [writer] = await ctx.magnus.submitted(1);
    await followed(posted.tasks[0].id);
    ctx.magnus.event(writer!.id, 'team_handoff', { to_role: 'mapper', objective: 'Draw the regions.' });
    await waitFor(() => ctx.store.tasks.list(project.id).some(task => task.mode === 'assignment'));
    ctx.magnus.finish(writer!.id, { state: 'completed', result: JSON.stringify({ outcome: 'completed', summary: 'Handed the map to the Cartographer.' }) });
    await waitFor(() => activityOf(project.id, posted.tasks[0].binding_id)?.state === 'waiting');
    expect(activityOf(project.id, posted.tasks[0].binding_id)).toMatchObject({ label: 'Waiting for Cartographer', source: { kind: 'handoff' } });
  });

  it('shows Delivering only for a short while after a verified revision', async () => {
    const { project } = await room({ conductor: { deliveringMs: 150 } });
    const created = await json(await ctx.call('POST', `/projects/${project.id}/tasks`, { body: { title: 'Draw the map', role_key: 'mapper' } }));
    const [ardent] = await ctx.magnus.submitted(1);
    await followed(created.id);
    ctx.magnus.finish(ardent!.id, { state: 'completed', result: JSON.stringify({ outcome: 'completed', summary: 'Drawn.' }) });
    await waitFor(() => studioTask(created.id).state === 'completed');
    const deliverable = ctx.store.review.createDeliverable({ projectId: project.id, name: 'Region Map', kind: 'map' });
    const blob = await ctx.blobs.putBytes(new TextEncoder().encode('<svg/>'), 'image/svg+xml');
    ctx.store.tx(() => {
      ctx.store.review.addRevision({ deliverableId: deliverable.id, blobSha256: blob.sha256, mime: 'image/svg+xml', size: 6, producerBindingId: created.binding_id, sourceTaskId: created.id });
      ctx.conductor.refreshActivity(project.id, created.binding_id);
    });
    expect(activityOf(project.id, created.binding_id)).toMatchObject({ state: 'delivering', label: 'Delivered Region Map r1' });
    await waitFor(() => activityOf(project.id, created.binding_id)?.state === 'available');
  });

  it('checks the status of agents bound in a newly published team at once', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    await publishTeam(ctx, project.id);
    const lead = ctx.store.team.current(project.id)!.body.roles.find(role => role.key === 'lead')!;
    await waitFor(() => activityOf(project.id, lead.binding_id!)?.state === 'available');
    expect(activityOf(project.id, lead.binding_id!)).toMatchObject({ state: 'available', label: 'Available' });
  });
});

describe('project stream with live text', () => {
  it('sends the current text of a streaming message to a stream that connects mid-reply', async () => {
    const { project, team } = await room();
    const posted = await post(team.id, { body_md: 'Outline it.' });
    const [ardent] = await ctx.magnus.submitted(1);
    await followed(posted.tasks[0].id);
    ctx.magnus.delta(ardent!.id, 1, 'Half a ');
    ctx.magnus.delta(ardent!.id, 1, 'reply');
    const message = await waitFor(() => { const found = ctx.store.room.messageForArdentTask(ardent!.id); return found && ctx.live.get(found.id)?.text === 'Half a reply' ? found : undefined; });
    const snapshot = await json(await ctx.call('GET', `/projects/${project.id}/snapshot`));
    expect(snapshot.conversations.map((item: { id: string }) => item.id)).toEqual([team.id]);
    expect(snapshot.tasks.map((item: { id: string }) => item.id)).toEqual([posted.tasks[0].id]);
    const controller = new AbortController();
    const response = await ctx.app.request(`/api/ardentstudio/v1/projects/${project.id}/stream?after=${snapshot.seq}`, { headers: { authorization: `Bearer ${await ctx.token()}` }, signal: controller.signal });
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    controller.abort();
    expect(new TextDecoder().decode(value)).toContain(`event: message.delta\ndata: {"message_id":"${message.id}","text":"Half a reply","mode":"replace","step":1}`);
  });
});
