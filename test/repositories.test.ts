import { afterEach, describe, expect, it } from 'vitest';
import { isId, newId, ulid } from '../src/ids.js';
import { IDEMPOTENCY_RETENTION_MS, STALE_CLAIM_MS } from '../src/db/repos/idempotency.js';
import { createProject, createTestContext, ManualClock, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(() => ctx?.close());

describe('identifiers', () => {
  it('are prefixed, well-formed and sort in creation order', () => {
    const ids = Array.from({ length: 50 }, () => newId('project', 1_790_000_000_000));
    expect(ids.every(id => isId('project', id))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(isId('file', ids[0]!)).toBe(false);
    expect(ulid(0)).toMatch(/^0{10}[0-9A-HJKMNP-TV-Z]{16}$/);
  });
});

describe('room, task, review and agent repositories', () => {
  it('store conversations and messages with a per-conversation seq, idempotent on the Ardent task', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const room = ctx.store.room;
    const team = room.createConversation({ projectId: project.id, kind: 'team', title: 'Team room', createdBy: 'operator' });
    const discussion = room.createConversation({ projectId: project.id, kind: 'discussion', parentId: team.id, title: 'Map scale?', createdBy: 'operator',
      discussion: { question: 'Which scale?', desired_output: 'decision', participants: ['cartographer'], max_rounds: 2, round: 0, state: 'open' } });
    const first = room.addMessage({ conversationId: team.id, author: { kind: 'user', user_id: 'operator' }, kind: 'text', bodyMd: 'Outline it', state: 'complete' });
    const reply = room.addMessage({ conversationId: team.id, author: { kind: 'agent', binding_id: 'bnd_x', role_key: 'story_lead' }, kind: 'text', bodyMd: '',
      replyTo: first.id, ardent: { task_id: 'task-1', session_id: null }, state: 'streaming' });
    expect([first.seq, reply.seq]).toEqual([1, 2]);
    expect(room.addMessage({ conversationId: discussion.id, author: { kind: 'system' }, kind: 'notice', bodyMd: 'Round 1', state: 'complete' }).seq).toBe(1);
    expect(() => room.addMessage({ conversationId: team.id, author: { kind: 'system' }, kind: 'text', bodyMd: '', ardent: { task_id: 'task-1', session_id: null }, state: 'complete' })).toThrow();
    expect(room.finishMessage(reply.id, { bodyMd: 'Here is the outline.', state: 'complete' })).toMatchObject({ body_md: 'Here is the outline.', state: 'complete' });
    expect(room.messageForArdentTask('task-1')!.id).toBe(reply.id);
    expect(room.messages(team.id, 1).map(message => message.id)).toEqual([reply.id]);
    expect(room.conversation(discussion.id)!.discussion!.question).toBe('Which scale?');

    const layout = room.saveLayout(project.id, { seats: [{ id: 'desk-1' }], placements: [], zone_labels: { wall: 'Display' }, createdBy: 'operator' });
    expect(room.saveLayout(project.id, { seats: [], placements: [], zone_labels: {}, createdBy: 'operator' }).revision).toBe(layout.revision + 1);
    const decision = room.createDecision({ projectId: project.id, title: 'Scale', statementMd: '1:50', decidedBy: 'operator', sources: [{ kind: 'message', ref: first.id }] });
    const next = room.createDecision({ projectId: project.id, title: 'Scale', statementMd: '1:100', decidedBy: 'operator' });
    expect(room.supersedeDecision(decision.id, next.id).superseded_by).toBe(next.id);
    expect(room.decisions(project.id)).toHaveLength(2);
  });

  it('mirror tasks under a team revision with forward-only journal cursors', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const binding = ctx.store.team.ensureBinding('node1~lead', 'Story Lead');
    expect(ctx.store.team.ensureBinding('node1~lead').id).toBe(binding.id);
    const task = ctx.store.tasks.create({ projectId: project.id, title: 'Outline', mode: 'turn', roleKey: 'story_lead', bindingId: binding.id, assignmentRevision: 1, createdBy: 'operator' });
    ctx.store.tasks.attachArdent(task.id, { agentRef: 'node1~lead', taskId: 'ardent-task-1', sessionId: null });
    expect(ctx.store.tasks.attachArdent(task.id, { agentRef: 'node1~lead', taskId: 'ardent-task-2', sessionId: null }).ardent.task_id).toBe('ardent-task-1');
    ctx.store.tasks.advanceCursor(task.id, 7);
    ctx.store.tasks.advanceCursor(task.id, 3);
    expect(ctx.store.tasks.get(task.id)!.ardent.event_cursor).toBe(7);
    expect(ctx.store.tasks.byArdentTask('node1~lead', 'ardent-task-1')!.id).toBe(task.id);
    expect(ctx.store.tasks.active(project.id)).toHaveLength(1);
    ctx.store.tasks.setState(task.id, 'completed', { summary: 'done' });
    expect(ctx.store.tasks.active(project.id)).toEqual([]);
    expect(ctx.store.tasks.get(task.id)!.outcome).toEqual({ summary: 'done' });
  });

  it('keep deliverable revisions, comments, decisions and exports', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const review = ctx.store.review;
    const blob1 = await ctx.blobs.putBytes(Buffer.from('<svg/>'), 'image/svg+xml');
    const blob2 = await ctx.blobs.putBytes(Buffer.from('<svg></svg>'), 'image/svg+xml');
    const deliverable = review.createDeliverable({ projectId: project.id, name: 'Region Map', kind: 'map', producerRole: 'cartographer' });
    const r1 = review.addRevision({ deliverableId: deliverable.id, blobSha256: blob1.sha256, mime: blob1.mime, size: blob1.size });
    const comment = review.addComment({ projectId: project.id, revisionId: r1.id, anchor: { kind: 'image', x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, bodyMd: 'Add a ford', author: 'operator' });
    const task = ctx.store.tasks.create({ projectId: project.id, title: 'Revise map', mode: 'revision', createdBy: 'operator' });
    review.linkCommentsToRevisionTask([comment.id], task.id);
    const r2 = review.addRevision({ deliverableId: deliverable.id, blobSha256: blob2.sha256, mime: blob2.mime, size: blob2.size, sourceTaskId: task.id });
    expect(r2).toMatchObject({ revision: 2, supersedes_revision_id: r1.id, review_status: 'unreviewed' });
    expect(review.revision(r1.id)!.review_status).toBe('superseded');
    expect(review.markAddressed(task.id, r2.id)).toBe(1);
    expect(review.resolveComment(comment.id)).toMatchObject({ state: 'resolved', addressed_in_revision_id: r2.id });
    expect(review.openReviewCount(project.id)).toBe(1);
    review.decide({ projectId: project.id, revisionId: r2.id, decision: 'accepted', decidedBy: 'operator' });
    expect(review.revision(r2.id)!.review_status).toBe('accepted');
    expect(review.setFinal(deliverable.id, r2.id).final_revision_id).toBe(r2.id);
    const exported = review.createExport({ projectId: project.id, revisionIds: [r2.id], blobSha256: blob2.sha256, manifest: { status: 'approved' }, createdBy: 'operator' });
    expect(review.exports(project.id)).toEqual([exported]);
  });

  it('keep presentation, one draft per agent and person, and development comments', async () => {
    ctx = await createTestContext();
    const agents = ctx.store.agents;
    agents.savePresentation({ agentRef: 'node1~lead', portrait: { preset: 'silhouette-a', accent: 'amber', emblem: 'crown' }, avatarFileId: null, displayName: 'Story Lead', updatedBy: 'operator' });
    expect(agents.presentation('node1~lead')!.portrait!.emblem).toBe('crown');
    agents.saveDraft({ agentRef: 'node1~lead', userId: 'operator', base: { soul: 'a' }, draft: { soul: 'b' } });
    agents.saveDraft({ agentRef: 'node1~lead', userId: 'operator', base: { soul: 'a' }, draft: { soul: 'c' } });
    expect(agents.draft('node1~lead', 'operator')!.draft).toEqual({ soul: 'c' });
    expect(agents.draft('node1~lead', 'viewer')).toBeUndefined();
    expect(agents.deleteDraft('node1~lead', 'operator')).toBe(true);
    agents.addDevelopmentComment({ agentRef: 'node1~lead', recordRef: 'dev_1', bodyMd: 'Nice insight', author: 'operator' });
    expect(agents.developmentComments('node1~lead', 'dev_1')).toHaveLength(1);
  });
});

describe('idempotency keys', () => {
  it('replay completed answers, block concurrent claims, and release stale or failed ones', async () => {
    const clock = new ManualClock();
    ctx = await createTestContext({ clock });
    const keys = ctx.store.idempotency;
    expect(keys.claim('operator', 'fixture-key-a', 'POST', '/x', 'f1')).toEqual({ kind: 'claimed' });
    expect(keys.claim('operator', 'fixture-key-a', 'POST', '/x', 'f1')).toEqual({ kind: 'in_progress' });
    expect(keys.claim('viewer', 'fixture-key-a', 'POST', '/x', 'f1')).toEqual({ kind: 'claimed' });
    expect(keys.claim('operator', 'fixture-key-a', 'POST', '/x', 'f2')).toEqual({ kind: 'mismatch' });
    clock.advance(STALE_CLAIM_MS + 1);
    expect(keys.claim('operator', 'fixture-key-a', 'POST', '/x', 'f1')).toEqual({ kind: 'claimed' });
    keys.complete('operator', 'fixture-key-a', 201, { id: 'prj_x' });
    expect(keys.claim('operator', 'fixture-key-a', 'POST', '/x', 'f1')).toEqual({ kind: 'replay', status: 201, body: { id: 'prj_x' } });
    keys.claim('operator', 'fixture-key-b', 'POST', '/x', 'f1');
    keys.release('operator', 'fixture-key-b');
    expect(keys.claim('operator', 'fixture-key-b', 'POST', '/y', 'f9')).toEqual({ kind: 'claimed' });
    clock.advance(IDEMPOTENCY_RETENTION_MS + 1);
    expect(keys.prune()).toBe(3);
  });
});
