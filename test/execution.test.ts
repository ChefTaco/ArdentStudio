import { decodeExecutionHeader, isExecutionRef } from '@hivemagnus/hive-common/execution';
import { describe, expect, it } from 'vitest';
import { ardentInstance, ardentTaskRef, previousDiscussionTurn, studioRef, submissionExecution, taskExecution, type ExecutionLookup } from '../src/conductor/execution.js';
import type { StudioTask } from '../src/db/repos/tasks.js';

const NOW = '2026-11-08T12:00:00.000Z';
const ARDENT_A = '0f8c1a52-7d3e-4b9a-9c2d-5e6f7a8b9c0d';

function task(id: string, overrides: Partial<StudioTask> = {}): StudioTask {
  return {
    id, project_id: 'prj_1', title: id, mode: 'turn', role_key: 'writer', binding_id: 'bnd_1', assignment_revision: 2,
    source: {}, mission: null, ardent: { agent_ref: null, task_id: null, session_id: null, event_cursor: 0 }, state: 'queued', outcome: null,
    reassigned_from: null, created_by: 'operator', created_at: NOW, updated_at: NOW, conversation_id: 'cnv_1',
    trigger_message_id: null, instructions_md: '', group_id: null, group_position: 0, dispatch: null, submit_attempts: 0, finished_at: null,
    progress: { model_started: false, tool: null }, execution: null, root_ref: null, parent_ref: null, submit_payload: null, submit_next_at: null,
    ardent_attempts: [], recovery: null, ...overrides,
  };
}

function lookup(tasks: StudioTask[]): ExecutionLookup {
  return { task: id => tasks.find(item => item.id === id), discussionTurns: conversationId => tasks.filter(item => item.conversation_id === conversationId) };
}

const options = (tasks: StudioTask[], extra: { requestId?: string } = {}) => ({ instance: 'studio-1', lookup: lookup(tasks), ...extra });

describe('execution references', () => {
  it('format Studio and Ardent references', () => {
    expect(studioRef('studio-1', 'task', 'tsk_01')).toBe('hx1:studio:studio-1:task:tsk_01');
    expect(studioRef('local', 'request', 'msg_01:turns')).toBe('hx1:studio:local:request:msg_01:turns');
    expect(studioRef('bad:instance', 'task', 'tsk_01')).toBeUndefined();
    expect(ardentInstance('node1~lead')).toBe('node1.lead');
    expect(ardentInstance('node1')).toBeUndefined();
    expect(ardentInstance(`${'n'.repeat(60)}~${'p'.repeat(60)}`)).toBeUndefined();
    expect(ardentTaskRef('node1~lead', ARDENT_A)).toBe(`hx1:ardent:node1.lead:task:${ARDENT_A}`);
    expect(ardentTaskRef('node1~lead', null)).toBeUndefined();
    expect(ardentTaskRef(null, ARDENT_A)).toBeUndefined();
  });

  it('root a request turn at its trigger message, with the task as self and the team revision as attempt', () => {
    const turn = task('tsk_turn', { trigger_message_id: 'msg_1', group_id: 'msg_1:turns' });
    expect(taskExecution(turn, options([turn], { requestId: 'req-1' }))).toEqual({
      v: 1, request_id: 'req-1', root: 'hx1:studio:studio-1:request:msg_1', parent: 'hx1:studio:studio-1:request:msg_1',
      self: 'hx1:studio:studio-1:task:tsk_turn', attempt: 2,
    });
  });

  it('root an ungrouped task without a trigger at itself, and a grouped one at its group', () => {
    const lone = task('tsk_lone', { assignment_revision: null });
    expect(taskExecution(lone, options([lone]))).toEqual({ v: 1, root: 'hx1:studio:studio-1:task:tsk_lone', self: 'hx1:studio:studio-1:task:tsk_lone' });
    const grouped = task('tsk_grouped', { group_id: 'grp_7' });
    expect(taskExecution(grouped, options([grouped]))).toMatchObject({ root: 'hx1:studio:studio-1:request:grp_7', parent: 'hx1:studio:studio-1:request:grp_7' });
  });

  it('give a hand-off the source task as parent, the source Ardent task as input, and the source root and request id', () => {
    const source = task('tsk_a', { trigger_message_id: 'msg_1', ardent: { agent_ref: 'node1~lead', task_id: ARDENT_A, session_id: null, event_cursor: 4 } });
    const sourceContext = taskExecution(source, options([source], { requestId: 'req-1' }))!;
    const stored = { ...source, execution: { ...sourceContext, deadline_ms: 1_800_000_000_000 } };
    const handoff = task('tsk_b', { mode: 'assignment', source: { from_task: 'tsk_a', handoff_from: 'lead' }, assignment_revision: 3 });
    expect(taskExecution(handoff, options([stored, handoff]))).toEqual({
      v: 1, request_id: 'req-1', root: 'hx1:studio:studio-1:request:msg_1', parent: 'hx1:studio:studio-1:task:tsk_a',
      self: 'hx1:studio:studio-1:task:tsk_b', inputs: [`hx1:ardent:node1.lead:task:${ARDENT_A}`], attempt: 3,
    });
    // Without the source's Ardent task there is no input; without a stored context it is derived.
    const early = task('tsk_c', { mode: 'assignment', source: { from_task: 'tsk_a' } });
    const context = taskExecution(early, options([source, early]))!;
    expect(context.parent).toBe('hx1:studio:studio-1:task:tsk_a');
    expect(context.inputs).toEqual([`hx1:ardent:node1.lead:task:${ARDENT_A}`]);
    const unknownSource = task('tsk_d', { mode: 'assignment', source: { from_task: 'tsk_a' } });
    const bare = task('tsk_a', { trigger_message_id: 'msg_1' });
    expect(taskExecution(unknownSource, options([bare, unknownSource]))!.inputs).toBeUndefined();
  });

  it('give a reassigned task the reassigned-from task as parent and keep the root', () => {
    const original = task('tsk_old', { trigger_message_id: 'msg_9' });
    const next = task('tsk_new', { trigger_message_id: 'msg_9', reassigned_from: 'tsk_old', assignment_revision: 4 });
    expect(taskExecution(next, options([original, next]))).toMatchObject({
      root: 'hx1:studio:studio-1:request:msg_9', parent: 'hx1:studio:studio-1:task:tsk_old', self: 'hx1:studio:studio-1:task:tsk_new', attempt: 4,
    });
  });

  it('chain discussion turns: each turn\'s parent is the previous turn, across rounds and into the summary', () => {
    const turn = (id: string, round: number | 'summary', position: number) => task(id, {
      mode: 'discussion_turn', conversation_id: 'cnv_d', group_position: position,
      group_id: round === 'summary' ? 'cnv_d:summary' : `cnv_d:r${round}`, source: round === 'summary' ? { discussion: 'cnv_d', summary: true } : { discussion: 'cnv_d', round },
    });
    const turns = [turn('tsk_s', 'summary', 0), turn('tsk_r2a', 2, 0), turn('tsk_r1b', 1, 1), turn('tsk_r1a', 1, 0), turn('tsk_r2b', 2, 1)];
    expect(previousDiscussionTurn(turns[3]!, turns)).toBeUndefined();
    expect(previousDiscussionTurn(turns[2]!, turns)?.id).toBe('tsk_r1a');
    expect(previousDiscussionTurn(turns[1]!, turns)?.id).toBe('tsk_r1b');
    expect(previousDiscussionTurn(turns[0]!, turns)?.id).toBe('tsk_r2b');
    const first = taskExecution(turns[3]!, options(turns))!;
    expect(first).toMatchObject({ root: 'hx1:studio:studio-1:request:cnv_d', parent: 'hx1:studio:studio-1:request:cnv_d' });
    const summary = taskExecution(turns[0]!, options(turns))!;
    expect(summary).toMatchObject({ root: 'hx1:studio:studio-1:request:cnv_d', parent: 'hx1:studio:studio-1:task:tsk_r2b', self: 'hx1:studio:studio-1:task:tsk_s' });
  });

  it('root a team proposal at the proposal, with its attempt', () => {
    const proposal = task('tsk_p', { mode: 'team_proposal', assignment_revision: null, source: { proposal_id: 'tpr_1', attempt: 2 } });
    expect(taskExecution(proposal, options([proposal]))).toMatchObject({ root: 'hx1:studio:studio-1:request:tpr_1', attempt: 2 });
  });

  it('carry the mission deadline in a submission and produce a header any reader can decode', () => {
    const turn = task('tsk_turn', { trigger_message_id: 'msg_1' });
    const context = submissionExecution(taskExecution(turn, options([turn]))!, 1_800_000_000_000);
    expect(context.deadline_ms).toBe(1_800_000_000_000);
    expect(submissionExecution(context, null)).toBe(context);
    for (const ref of [context.root, context.parent, context.self]) expect(isExecutionRef(ref)).toBe(true);
    expect(decodeExecutionHeader(Buffer.from(JSON.stringify(context)).toString('base64url'))).toEqual(context);
  });
});
