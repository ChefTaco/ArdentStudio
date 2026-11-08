import { afterEach, describe, expect, it } from 'vitest';
import { parseSse, type SseMessage } from '../src/clients/sse.js';
import { ARDENT_STUDIO_API_PREFIX } from '../src/shared/browser.js';
import { createProject, createTestContext, ManualClock, type TestContext } from './helpers.js';

let ctx: TestContext;
const open: Array<() => void> = [];
afterEach(() => { for (const close of open.splice(0)) close(); ctx?.close(); });

async function connect(projectId: string, query = '', token?: string) {
  const controller = new AbortController();
  const response = await ctx.app.request(`${ARDENT_STUDIO_API_PREFIX}/projects/${projectId}/stream${query}`, {
    headers: { authorization: `Bearer ${token ?? await ctx.token()}` }, signal: controller.signal,
  });
  const iterator = parseSse(response.body!)[Symbol.asyncIterator]();
  const close = () => controller.abort();
  open.push(close);
  return {
    response,
    next: async (): Promise<SseMessage | undefined> => {
      const result = await Promise.race([iterator.next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream timeout')), 3000))]);
      return result.done ? undefined : result.value;
    },
    close,
  };
}

describe('project stream', () => {
  it('replays events after the cursor with their seq as id, then streams new ones', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const stream = await connect(project.id, '?after=0');
    expect(stream.response.headers.get('content-type')).toMatch(/text\/event-stream/);
    const first = (await stream.next())!;
    expect(first).toMatchObject({ event: 'project.created', id: '1' });
    expect(JSON.parse(first.data)).toMatchObject({ seq: 1, project_id: project.id, type: 'project.created' });
    expect(await stream.next()).toMatchObject({ event: 'project.updated', id: '2' });
    await ctx.call('PATCH', `/projects/${project.id}`, { body: { name: 'Live' } });
    expect(await stream.next()).toMatchObject({ event: 'project.updated', id: '3' });
  });

  it('starts at the current cursor without ?after and relays ephemeral deltas without an id', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    const stream = await connect(project.id);
    ctx.bus.publishEphemeral(project.id, 'message.delta', { message_id: 'msg_x', text: 'The Fen' });
    const delta = (await stream.next())!;
    expect(delta.event).toBe('message.delta');
    expect(delta.id).toBeUndefined();
    expect(JSON.parse(delta.data)).toEqual({ message_id: 'msg_x', text: 'The Fen' });
    ctx.store.tx(() => ctx.store.emit(project.id, 'presence.updated', { binding_id: 'bnd_x', state: 'available' }));
    expect(await stream.next()).toMatchObject({ event: 'presence.updated', id: '3' });
  });

  it('sends reset when the cursor is older than retained events or ahead of them', async () => {
    const clock = new ManualClock();
    ctx = await createTestContext({ clock });
    const project = await createProject(ctx);
    clock.advance(40 * 86_400_000);
    ctx.store.tx(() => ctx.store.emit(project.id, 'project.updated', {}));
    ctx.store.events.compact(new Date(clock.now().getTime() - 30 * 86_400_000));
    const expired = await connect(project.id, '?after=1');
    expect(await expired.next()).toMatchObject({ event: 'reset', data: JSON.stringify({ seq: 3, reason: 'cursor_expired' }) });
    const current = await connect(project.id, '?after=2');
    expect(await current.next()).toMatchObject({ event: 'project.updated', id: '3' });
    const ahead = await connect(project.id, '?after=99');
    expect(await ahead.next()).toMatchObject({ event: 'reset', data: JSON.stringify({ seq: 3, reason: 'cursor_ahead' }) });
  });

  it('sends heartbeats carrying the last seq', async () => {
    ctx = await createTestContext({ heartbeatMs: 30 });
    const project = await createProject(ctx);
    const stream = await connect(project.id);
    const beat = (await stream.next())!;
    expect(beat.event).toBe('heartbeat');
    expect(JSON.parse(beat.data)).toMatchObject({ seq: 2 });
  });

  it('closes when the token expires', async () => {
    ctx = await createTestContext({ heartbeatMs: 60_000 });
    const project = await createProject(ctx);
    const stream = await connect(project.id, '', await ctx.token({ lifetime: 1 }));
    expect(await stream.next()).toBeUndefined();
  });

  it('requires read permission and an existing project', async () => {
    ctx = await createTestContext();
    const project = await createProject(ctx);
    expect((await ctx.call('GET', `/projects/${project.id}/stream`, { token: null })).status).toBe(401);
    expect((await ctx.call('GET', `/projects/${project.id}/stream`, { token: await ctx.token({ permissions: [] }) })).status).toBe(403);
    expect((await ctx.call('GET', '/projects/prj_01JABCDEFGHJKMNPQRSTVWXYZ0/stream')).status).toBe(404);
    expect((await ctx.call('GET', `/projects/${project.id}/stream?after=-1`)).status).toBe(400);
  });
});
