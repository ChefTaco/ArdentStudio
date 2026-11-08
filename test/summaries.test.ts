import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, createTestContext, json, publishTeam, waitFor, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => { await ctx?.close(); });

const countEvents = (projectId: string) => ctx.store.events.after(projectId, 0)
  .filter(event => event.type === 'project.updated' && (event.payload.fields as string[] | undefined)?.includes('counts')).map(event => event.payload.counts);

describe('project summaries', () => {
  it('counts active tasks and open questions from real records, and announces each change once', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    await publishTeam(ctx, project.id);
    const team = await json(await ctx.call('POST', `/projects/${project.id}/conversations`, { body: { kind: 'team' } }));
    const posted = await json(await ctx.call('POST', `/conversations/${team.id}/messages`, { body: { body_md: 'Outline the adventure.' } }));
    const [ardent] = await ctx.magnus.submitted(1);
    await waitFor(() => ctx.store.tasks.get(posted.tasks[0].id)!.ardent.task_id && ctx.magnus.openStreams(ardent!.id));

    let listed = (await json(await ctx.call('GET', '/projects'))).projects[0];
    expect(listed).toMatchObject({ active_tasks: 1, open_questions: 0, review_pending: 0, last_activity: { type: 'message.created', text: 'operator: Outline the adventure.' } });

    ctx.magnus.event(ardent!.id, 'team_ask_user', { question: 'Which tone: grim or hopeful?' });
    await waitFor(() => ctx.store.summaries.counts(project.id).open_questions === 1);
    listed = (await json(await ctx.call('GET', '/projects'))).projects[0];
    expect(listed).toMatchObject({ open_questions: 1, last_activity: { type: 'message.created', text: 'Story Lead asked: Which tone: grim or hopeful?' } });

    ctx.magnus.finish(ardent!.id, { state: 'completed', result: JSON.stringify({ outcome: 'input_required', summary: 'I need the tone first.' }) });
    await waitFor(() => ctx.store.tasks.get(posted.tasks[0].id)!.state === 'input_required');
    const clarification = ctx.store.room.messages(team.id).find(message => message.kind === 'clarification')!;
    expect((await ctx.call('POST', `/messages/${clarification.id}/answer`, { body: { body_md: 'Hopeful.' } })).status).toBe(201);
    const snapshot = await json(await ctx.call('GET', `/projects/${project.id}/snapshot`));
    expect(snapshot.summary).toMatchObject({ id: project.id, open_questions: 0, active_tasks: 1 });

    // Every announced change differs from the one before it.
    const announced = countEvents(project.id);
    expect(announced[0]).toEqual({ open_questions: 0, review_pending: 0, active_tasks: 1 });
    expect(announced).toContainEqual({ open_questions: 1, review_pending: 0, active_tasks: 1 });
    announced.slice(1).forEach((counts, index) => expect(counts).not.toEqual(announced[index]));
    expect(announced.at(-1)).toEqual({ open_questions: 0, review_pending: 0, active_tasks: 1 });
  });

  it('counts revisions awaiting review until accepted, and filters projects that need review', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const quiet = await createProject(ctx, { name: 'Quiet project' });
    const blob = await ctx.blobs.put(Readable.from([Buffer.from('# Outline\n')]), 'text/markdown');
    const revision = ctx.store.tx(() => {
      const deliverable = ctx.store.review.createDeliverable({ projectId: project.id, name: 'Outline', kind: 'document' });
      const created = ctx.store.review.addRevision({ deliverableId: deliverable.id, blobSha256: blob.sha256, mime: 'text/markdown', size: blob.size });
      ctx.store.emit(project.id, 'deliverable.revision.created', { revision: created });
      return created;
    });
    expect(countEvents(project.id)).toEqual([{ open_questions: 0, review_pending: 1, active_tasks: 0 }]);
    const needing = await json(await ctx.call('GET', '/projects?needs_review=true'));
    expect(needing.projects.map((item: { id: string }) => item.id)).toEqual([project.id]);
    expect(needing.projects[0]).toMatchObject({ review_pending: 1, last_activity: { type: 'deliverable.revision.created', text: 'An agent delivered Outline r1' } });
    expect((await json(await ctx.call('GET', '/projects?needs_review=false'))).projects.map((item: { id: string }) => item.id)).toEqual([quiet.id]);

    // Changes requested: still waiting, now for a new revision.
    expect((await ctx.call('POST', `/revisions/${revision.id}/decisions`, { body: { decision: 'changes_requested', note_md: 'Shorter.' } })).status).toBe(201);
    expect(ctx.store.summaries.counts(project.id).review_pending).toBe(1);
    expect(countEvents(project.id)).toHaveLength(1);
    expect((await ctx.call('POST', `/revisions/${revision.id}/decisions`, { body: { decision: 'accepted' } })).status).toBe(201);
    expect(countEvents(project.id).at(-1)).toEqual({ open_questions: 0, review_pending: 0, active_tasks: 0 });
    const listed = (await json(await ctx.call('GET', '/projects'))).projects.find((item: { id: string }) => item.id === project.id);
    expect(listed.last_activity).toMatchObject({ type: 'review.decision.created', text: 'operator accepted Outline r1' });
    expect((await json(await ctx.call('GET', '/projects?needs_review=true'))).projects).toEqual([]);
  });
});
