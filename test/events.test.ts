import { afterEach, describe, expect, it } from 'vitest';
import { createProject, createTestContext, ManualClock, type TestContext } from './helpers.js';

let ctx: TestContext;
afterEach(() => ctx?.close());

describe('project events', () => {
  it('assigns a gap-free seq per project inside the inserting transaction', async () => {
    ctx = await createTestContext();
    const a = (await createProject(ctx)).id;
    const b = (await createProject(ctx, { name: 'Second' })).id;
    // Each project starts with project.created and the HiveMem workspace update.
    ctx.store.tx(() => { ctx.store.emit(a, 'project.updated', { n: 1 }); ctx.store.emit(a, 'project.updated', { n: 2 }); });
    ctx.store.tx(() => ctx.store.emit(b, 'project.updated', { n: 1 }));
    expect(ctx.store.events.after(a, 0).map(event => event.seq)).toEqual([1, 2, 3, 4]);
    expect(ctx.store.events.after(b, 0).map(event => event.seq)).toEqual([1, 2, 3]);
    expect(() => ctx.store.events.append(a, 'project.updated', {})).toThrow(/inside a transaction/);
  });

  it('publishes events only after commit and drops those of a rolled-back transaction', async () => {
    ctx = await createTestContext();
    const id = (await createProject(ctx)).id;
    const seen: number[] = [];
    ctx.bus.subscribe(id, message => { if (message.kind === 'event') seen.push(message.event.seq); });
    expect(() => ctx.store.tx(() => { ctx.store.emit(id, 'project.updated', {}); throw new Error('rollback'); })).toThrow('rollback');
    expect(seen).toEqual([]);
    ctx.store.tx(() => {
      ctx.store.emit(id, 'project.updated', { outer: true });
      try { ctx.store.tx(() => { ctx.store.emit(id, 'project.updated', { inner: true }); throw new Error('inner'); }); } catch { /* rolled back */ }
    });
    expect(seen).toEqual([3]);
    expect(ctx.store.events.after(id, 2).map(event => event.payload)).toEqual([{ outer: true }]);
  });

  it('compacts old events and remembers the boundary so stale cursors can be reset', async () => {
    const clock = new ManualClock();
    ctx = await createTestContext({ clock });
    const id = (await createProject(ctx)).id;
    ctx.store.tx(() => ctx.store.emit(id, 'project.updated', {}));
    clock.advance(31 * 86_400_000);
    ctx.store.tx(() => ctx.store.emit(id, 'project.updated', { recent: true }));
    expect(ctx.store.events.compact(new Date(clock.now().getTime() - 30 * 86_400_000))).toBe(3);
    expect(ctx.store.events.cursor(id)).toEqual({ lastSeq: 4, compactedThrough: 3 });
    expect(ctx.store.events.after(id, 0).map(event => event.seq)).toEqual([4]);
  });
});
