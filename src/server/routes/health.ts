// Health runs on the suite's shared readiness helper (@hivemagnus/hive-common/health), but keeps
// Studio's published body shape: HiveXUI parses it through the browser contract.
import { readiness, type CheckReport } from '@hivemagnus/hive-common/health';
import type { AppDeps } from '../deps.js';
import type { createRouter } from '../routing.js';

const CACHE_MS = 10_000;
/** Above the Magnus client's own 20 s timeout, so the clients' timeouts decide, as before. */
const CHECK_TIMEOUT_MS = 25_000;

type Check = { status: 'ok' | 'unavailable'; error: string | null };
const toCheck = (report: CheckReport | undefined, maxError = 200): Check => report?.status === 'up'
  ? { status: 'ok', error: null }
  : { status: 'unavailable', error: (report?.error ?? 'unavailable').slice(0, maxError) };

export function healthRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  let cached: { at: number; ready: boolean; body: unknown } | undefined;

  // Liveness never touches dependencies. Its body stays Studio's published `{status:'ok'}`.
  register('GET', '/health/live', () => ({ body: { status: 'ok' } }));

  register('GET', '/health/ready', async c => {
    if (!cached || Date.now() - cached.at > CACHE_MS) {
      // One Magnus listing serves both the magnus and the agents checks.
      const listing = deps.agents.list();
      listing.catch(() => undefined);
      const report = await readiness({
        timeoutMs: CHECK_TIMEOUT_MS,
        exposeErrors: true,
        checks: [
          { name: 'database', check: () => { deps.store.db.prepare('SELECT 1').get(); } },
          { name: 'magnus', check: async () => {
            const list = await listing;
            if (list.magnus.state !== 'ok') throw new Error(list.magnus.error ?? 'unavailable');
          } },
          { name: 'hivemem', check: async () => { await deps.hivemem.health(); } },
          // Ardent Project Studio requires at least one reachable Ardent agent.
          { name: 'agents', check: async () => {
            const list = await listing;
            const available = list.magnus.state === 'ok' ? list.available_count : 0;
            return { ok: available > 0, details: { available } };
          } },
        ],
      });
      const { checks } = report.body;
      const agents = checks['agents'];
      const available = typeof agents?.details?.['available'] === 'number' ? agents.details['available'] : 0;
      const ready = report.status === 200;
      cached = { at: Date.now(), ready, body: {
        status: ready ? 'ready' : 'not_ready',
        checks: {
          database: toCheck(checks['database']),
          magnus: toCheck(checks['magnus'], 300),
          hivemem: toCheck(checks['hivemem']),
          agents: { status: agents?.status === 'up' ? 'ok' : 'unavailable', available },
        },
      } };
    }
    c.header('cache-control', 'no-store');
    return c.json(cached.body, cached.ready ? 200 : 503);
  });
}
