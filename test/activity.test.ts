import { describe, expect, it } from 'vitest';
import { ACTIVITY_PRECEDENCE, activityCandidates, deriveActivity, pickActivity, type ActivityInput } from '../src/conductor/activity.js';
import type { StudioTask } from '../src/db/repos/tasks.js';
import { activityStateSchema } from '../src/shared/browser.js';

const NOW = new Date('2026-11-08T12:00:00.000Z');
let counter = 0;

function task(overrides: Partial<StudioTask> = {}): StudioTask {
  counter += 1;
  return {
    id: `task_${counter}`, project_id: 'prj_1', title: `Task ${counter}`, mode: 'turn', role_key: 'writer', binding_id: 'bnd_1', assignment_revision: 1,
    source: {}, mission: null, ardent: { agent_ref: 'node1~scout', task_id: null, session_id: null, event_cursor: 0 }, state: 'queued', outcome: null,
    reassigned_from: null, created_by: 'operator', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), conversation_id: 'cnv_1',
    trigger_message_id: null, instructions_md: '', group_id: null, group_position: 0, dispatch: null, submit_attempts: 0, finished_at: null,
    progress: { model_started: false, tool: null }, ...overrides,
  };
}
const accepted = (overrides: Partial<StudioTask> = {}) => task({ ...overrides, ardent: { agent_ref: 'node1~scout', task_id: `ardent-${counter + 1}`, session_id: null, event_cursor: 0 } });

function input(overrides: Partial<ActivityInput> = {}): ActivityInput {
  return { probe: 'available', tasks: [], blockerOf: () => undefined, handedOff: [], message: () => undefined, roleName: item => item.role_key ?? 'role',
    delivered: undefined, now: NOW, deliveringMs: 20_000, ...overrides };
}

describe('agent activity', () => {
  it('ranks every contract state, highest first', () => {
    expect(ACTIVITY_PRECEDENCE).toEqual(['offline', 'paused', 'blocked', 'asking', 'reviewing', 'working', 'queued', 'waiting', 'delivering', 'available', 'unknown']);
    expect([...ACTIVITY_PRECEDENCE].sort()).toEqual([...activityStateSchema.options].sort());
  });

  it('comes from the probe alone when the agent has no tasks', () => {
    expect(deriveActivity(input({ probe: undefined }))).toMatchObject({ state: 'unknown', label: 'Status not checked yet' });
    expect(deriveActivity(input())).toMatchObject({ state: 'available', label: 'Available' });
    expect(deriveActivity(input({ probe: 'offline', tasks: [accepted({ state: 'running', progress: { model_started: true, tool: null } })] }))).toMatchObject({ state: 'offline', label: 'Offline' });
    expect(deriveActivity(input({ probe: 'unreachable' }))).toMatchObject({ state: 'offline', label: 'Offline: Magnus is unreachable' });
  });

  it('shows Working only after the journal showed the model start or a tool', () => {
    expect(deriveActivity(input({ tasks: [accepted({ state: 'running', title: 'Draft' })] }))).toMatchObject({ state: 'queued', label: 'Starting: Draft' });
    expect(deriveActivity(input({ tasks: [task({ title: 'Draft' })] }))).toMatchObject({ state: 'queued', label: 'Queued: Draft' });
    expect(deriveActivity(input({ tasks: [accepted({ state: 'running', title: 'Draft', progress: { model_started: true, tool: null } })] })))
      .toMatchObject({ state: 'working', label: 'Working: Draft' });
    expect(deriveActivity(input({ tasks: [accepted({ state: 'running', title: 'Draft', progress: { model_started: true, tool: 'memory_search' } })] })))
      .toMatchObject({ state: 'working', label: 'Working: Draft · memory_search', source: { kind: 'journal' } });
  });

  it('shows Reviewing for a running review task and Asking for an unanswered clarification', () => {
    expect(deriveActivity(input({ tasks: [accepted({ state: 'running', mode: 'review', title: 'Region Map r1' })] }))).toMatchObject({ state: 'reviewing', label: 'Reviewing: Region Map r1' });
    const messages = new Map([['msg_q', { body_md: 'Which tone: grim or hopeful?', links: { answer_message_id: null } }], ['msg_a', { body_md: 'Old question', links: { answer_message_id: 'msg_x' } }]]);
    const message = (id: string) => messages.get(id);
    expect(deriveActivity(input({ message, tasks: [accepted({ state: 'running', outcome: { clarification_message_id: 'msg_q' }, progress: { model_started: true, tool: null } })] })))
      .toMatchObject({ state: 'asking', label: 'Asking: Which tone: grim or hopeful?' });
    expect(deriveActivity(input({ message, tasks: [accepted({ state: 'input_required', outcome: { clarification_message_id: 'msg_q' } })] }))).toMatchObject({ state: 'asking' });
    // An answered question no longer asks.
    expect(deriveActivity(input({ message, tasks: [accepted({ state: 'running', outcome: { clarification_message_id: 'msg_a' }, progress: { model_started: true, tool: null } })] })).state).toBe('working');
  });

  it('shows Waiting behind an earlier turn and on a role the agent handed work to', () => {
    const ahead = accepted({ role_key: 'lead', state: 'running' });
    expect(deriveActivity(input({ tasks: [task()], blockerOf: () => ahead, roleName: item => item.role_key === 'lead' ? 'Story Lead' : 'Worldbuilder' })))
      .toMatchObject({ state: 'waiting', label: 'Waiting for Story Lead', source: { kind: 'group', waiting_for: ahead.id } });
    const own = accepted({ state: 'completed' });
    const handedOff = task({ role_key: 'mapper', binding_id: 'bnd_2', source: { from_task: own.id } });
    expect(deriveActivity(input({ tasks: [own], handedOff: [handedOff], roleName: () => 'Cartographer' })))
      .toMatchObject({ state: 'waiting', label: 'Waiting for Cartographer', source: { kind: 'handoff', task_id: handedOff.id } });
  });

  it('shows Blocked while the newest task failed, ended unknown or reported itself blocked', () => {
    expect(deriveActivity(input({ tasks: [accepted({ state: 'failed', outcome: { error: 'Magnus could not start the turn: node unavailable' } })] })))
      .toMatchObject({ state: 'blocked', label: 'Blocked: Magnus could not start the turn: node unavailable', source: { kind: 'outcome' } });
    expect(deriveActivity(input({ tasks: [accepted({ state: 'unknown', title: 'Draft' })] }))).toMatchObject({ state: 'blocked', label: 'Blocked: Ardent does not know how Draft ended' });
    const message = (id: string) => id === 'msg_r' ? { body_md: 'I need the map scale before I can continue.', links: {} } : undefined;
    expect(deriveActivity(input({ message, tasks: [accepted({ state: 'completed', outcome: { team_result: { outcome: 'blocked' }, reply_message_id: 'msg_r' } })] })))
      .toMatchObject({ state: 'blocked', label: 'Blocked: I need the map scale before I can continue.' });
    // Newer work clears it, and a cancelled or completed task never blocks.
    const failed = accepted({ state: 'failed' });
    expect(deriveActivity(input({ tasks: [failed, task({ title: 'Retry' })] }))).toMatchObject({ state: 'queued', label: 'Queued: Retry' });
    expect(deriveActivity(input({ tasks: [accepted({ state: 'cancelled' })] })).state).toBe('available');
  });

  it('shows Delivering for a short while after a verified revision', () => {
    const delivered = { id: 'rev_1', deliverable_id: 'dlv_1', revision: 2, blob_sha256: 'a'.repeat(64), mime: 'image/svg+xml', size: 10, producer_binding_id: 'bnd_1',
      source_task_id: 'task_x', source_message_id: null, ardent: null, supersedes_revision_id: null, received_at: new Date(NOW.getTime() - 5_000).toISOString(),
      review_status: 'unreviewed' as const, ardent_artifact_id: null, deliverable_name: 'Region Map' };
    expect(deriveActivity(input({ delivered }))).toMatchObject({ state: 'delivering', label: 'Delivered Region Map r2', source: { revision_id: 'rev_1' } });
    expect(deriveActivity(input({ delivered, deliveringMs: 4_000 })).state).toBe('available');
    expect(deriveActivity(input({ delivered, tasks: [task()] })).state).toBe('queued');
  });

  it('picks by precedence when several tasks are active', () => {
    const tasks = [
      accepted({ state: 'running', progress: { model_started: true, tool: null } }),
      task({ title: 'Later' }),
      accepted({ state: 'running', mode: 'review' }),
    ];
    expect(deriveActivity(input({ tasks })).state).toBe('reviewing');
    expect(deriveActivity(input({ tasks: [...tasks, accepted({ state: 'paused', title: 'Held' })] }))).toMatchObject({ state: 'paused', label: 'Paused: Held' });
    expect(deriveActivity(input({ tasks: [accepted({ state: 'pausing', title: 'Held' })] }))).toMatchObject({ state: 'paused', label: 'Pause requested: Held' });
    const candidates = activityCandidates(input({ tasks }));
    expect(pickActivity([...candidates].reverse()).state).toBe('reviewing');
  });
});
