import { afterEach, describe, expect, it } from 'vitest';
import { createProject, createTestContext, json, publishTeam, waitFor, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(async () => { await ctx?.close(); });

describe('room routes', () => {
  it('saves layout revisions with a conflict check', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    expect(await json(await ctx.call('GET', `/projects/${project.id}/layout`))).toEqual({ layout: null });
    const seats = [{ id: 'desk-1', kind: 'desk', x: 1, y: 2 }, { id: 'table', kind: 'discussion', x: 0, y: 0 }];
    const first = await json(await ctx.call('PUT', `/projects/${project.id}/layout`, { body: { base_revision: null, seats, placements: [{ role_key: 'lead', seat_id: 'desk-1' }], zone_labels: { wall: 'Display' } } }));
    expect(first.layout).toMatchObject({ revision: 1, placements: [{ role_key: 'lead', seat_id: 'desk-1' }], created_by: 'operator' });
    const stale = await ctx.call('PUT', `/projects/${project.id}/layout`, { body: { base_revision: null, seats, placements: [] } });
    expect(stale.status).toBe(409);
    expect((await ctx.call('PUT', `/projects/${project.id}/layout`, { body: { base_revision: 1, seats, placements: [{ role_key: 'lead', seat_id: 'nowhere' }] } })).status).toBe(422);
    expect((await json(await ctx.call('PUT', `/projects/${project.id}/layout`, { body: { base_revision: 1, seats, placements: [] } }))).layout.revision).toBe(2);
    expect(ctx.store.events.after(project.id, 0).filter(event => event.type === 'layout.updated').map(event => event.payload.revision)).toEqual([1, 2]);
  });

  it('lists messages in pages, sends direct messages to their role and asks agents to follow up', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    await publishTeam(ctx, project.id);
    const direct = await json(await ctx.call('POST', `/projects/${project.id}/conversations`, { body: { kind: 'direct', role_key: 'mapper' } }));
    expect(direct).toMatchObject({ kind: 'direct', role_key: 'mapper', title: 'Cartographer' });
    const posted = await json(await ctx.call('POST', `/conversations/${direct.id}/messages`, { body: { body_md: 'How big is the valley? @lead' } }));
    expect(posted.tasks.map((task: { role_key: string }) => task.role_key)).toEqual(['mapper']);
    const [ardent] = await ctx.magnus.submitted(1);
    await waitFor(() => ctx.store.tasks.get(posted.tasks[0].id)!.ardent.task_id && ctx.magnus.openStreams(ardent!.id));
    ctx.magnus.finish(ardent!.id, { state: 'completed', result: JSON.stringify({ outcome: 'partial', summary: 'Twelve miles.' }) });
    const reply = await waitFor(() => ctx.store.room.messageForArdentTask(ardent!.id));
    const follow = await ctx.call('POST', `/messages/${reply.id}/follow-up`, { body: { body_md: 'In kilometres?' } });
    expect(follow.status).toBe(201);
    const followed = await json(follow);
    expect(followed.message.body_md).toBe('Please follow up on your message:\n> Twelve miles.\n\nIn kilometres?');
    expect(followed.tasks[0]).toMatchObject({ role_key: 'mapper', source: { follow_up_of: reply.id } });
    expect((await ctx.call('POST', `/messages/${posted.message.id}/follow-up`, { body: {} })).status).toBe(409);

    const page = await json(await ctx.call('GET', `/conversations/${direct.id}/messages?limit=2`));
    expect(page.messages.map((item: { kind: string }) => item.kind)).toEqual(['message', 'reply']);
    expect(page.next_after).toBe(page.messages[1].seq);
    const rest = await json(await ctx.call('GET', `/conversations/${direct.id}/messages?after=${page.next_after}`));
    expect(rest.messages).toHaveLength(1);
    expect(rest.next_after).toBeNull();
    const conversations = await json(await ctx.call('GET', `/projects/${project.id}/conversations`));
    expect(conversations.conversations.map((item: { kind: string }) => item.kind)).toEqual(['direct']);
  });

  it('validates discussions, attachments and references', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const noTeam = await ctx.call('POST', `/projects/${project.id}/conversations`, { body: { kind: 'discussion', question: 'Scale?', desired_output: 'decision', participants: ['lead'] } });
    expect(noTeam.status).toBe(409);
    await publishTeam(ctx, project.id);
    const unknown = await ctx.call('POST', `/projects/${project.id}/conversations`, { body: { kind: 'discussion', question: 'Scale?', desired_output: 'decision', participants: ['bard'] } });
    expect((await json(unknown)).error).toMatchObject({ code: 'TEAM_NOT_READY', details: { roles: ['bard'] } });
    const team = await json(await ctx.call('POST', `/projects/${project.id}/conversations`, { body: { kind: 'team' } }));
    const foreign = await ctx.call('POST', `/conversations/${team.id}/messages`, { body: { body_md: 'See file', attachments: ['fil_01JABCDEFGHJKMNPQRSTVWXYZ0'] } });
    expect(foreign.status).toBe(422);
    const file = await json(await ctx.call('POST', `/projects/${project.id}/files?name=style.md&purpose=attachment`, { raw: '# House style\nShort sentences.', headers: { 'content-type': 'text/markdown' } }));
    await ctx.call('POST', `/conversations/${team.id}/messages`, { body: { body_md: 'Use the attached style.', attachments: [file.id] } });
    const [submitted] = await ctx.magnus.submitted(1);
    const body = submitted!.body as { objective: string; context_items: Array<{ title: string; text: string }> };
    expect(body.objective).toContain('- style.md (in context items)');
    expect(body.context_items).toEqual([{ title: 'Attachment: style.md', mime: 'text/markdown', text: '# House style\nShort sentences.' }]);
  });
});
