import type { AppDeps } from '../deps.js';
import type { createRouter } from '../routing.js';

const CACHE_MS = 10_000;

type Check = { status: 'ok' | 'unavailable'; error: string | null };
const failed = (error: unknown): Check => ({ status: 'unavailable', error: error instanceof Error ? error.message.slice(0, 200) : 'unavailable' });

export function healthRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  let cached: { at: number; ready: boolean; body: unknown } | undefined;

  register('GET', '/health/live', () => ({ body: { status: 'ok' } }));

  register('GET', '/health/ready', async c => {
    if (!cached || Date.now() - cached.at > CACHE_MS) {
      let database: Check = { status: 'ok', error: null };
      try { deps.store.db.prepare('SELECT 1').get(); } catch (error) { database = failed(error); }
      const [agents, hivemem] = await Promise.all([
        deps.agents.list().then(list => list.magnus.state === 'ok'
          ? { magnus: { status: 'ok', error: null } as Check, available: list.available_count }
          : { magnus: { status: 'unavailable', error: list.magnus.error } as Check, available: 0 }),
        deps.hivemem.health().then((): Check => ({ status: 'ok', error: null }), failed),
      ]);
      // Ardent Project Studio requires at least one reachable Ardent agent.
      const ready = database.status === 'ok' && agents.magnus.status === 'ok' && hivemem.status === 'ok' && agents.available > 0;
      cached = { at: Date.now(), ready, body: {
        status: ready ? 'ready' : 'not_ready',
        checks: { database, magnus: agents.magnus, hivemem, agents: { status: agents.available > 0 ? 'ok' : 'unavailable', available: agents.available } },
      } };
    }
    c.header('cache-control', 'no-store');
    return c.json(cached.body, cached.ready ? 200 : 503);
  });
}
