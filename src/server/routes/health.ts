// Health runs on the suite's shared readiness helper (@hivemagnus/hive-common/health), but keeps
// Studio's published body shape: HiveXUI parses it through the browser contract.
import { readiness, type CheckReport } from '@hivemagnus/hive-common/health';
import type { AppDeps } from '../deps.js';
import type { createRouter } from '../routing.js';

const CACHE_MS = 10_000;
/** Above the Magnus client's own 20 s timeout, so the clients' timeouts decide, as before. */
const CHECK_TIMEOUT_MS = 25_000;

type Check = { status: 'ok' | 'unavailable'; error: string | null };
/**
 * The readiness route needs no token, so a failing check answers only a code: `<CHECK>_TIMEOUT` or
 * `<CHECK>_UNAVAILABLE`. What the dependency said is logged instead (once per change), never returned.
 */
const toCheck = (name: string, report: CheckReport | undefined): Check => report?.status === 'up'
  ? { status: 'ok', error: null }
  : { status: 'unavailable', error: `${name.toUpperCase()}_${report?.error === 'timeout' ? 'TIMEOUT' : 'UNAVAILABLE'}` };

export function healthRoutes(register: ReturnType<typeof createRouter>, deps: AppDeps): void {
  let cached: { at: number; ready: boolean; body: unknown } | undefined;
  const logged = new Map<string, string>();
  /** Log a failing check's detail when it changes, so a dependency that stays down is logged once. */
  const detail = (name: string, error: unknown): never => {
    const message = error instanceof Error ? error.message.slice(0, 300) : 'unavailable';
    if (logged.get(name) !== message) {
      logged.set(name, message);
      deps.logger.warn('Readiness check failed', { check: name, error: message });
    }
    throw error;
  };
  const guarded = (name: string, check: () => void | Promise<void>) => async (): Promise<void> => {
    try {
      await check();
      logged.delete(name);
    } catch (error) { detail(name, error); }
  };

  // Liveness never touches dependencies. Its body stays Studio's published `{status:'ok'}`.
  register('GET', '/health/live', () => ({ body: { status: 'ok' } }));

  // Requests that arrive while a readiness run is in progress share it (as hive-common's
  // createHealth() does since 0.7.0), so concurrent probes of this unauthenticated route never
  // multiply the load on Magnus and HiveMem.
  let running: Promise<void> | undefined;
  const refresh = async (): Promise<void> => {
    // One Magnus listing serves both the magnus and the agents checks.
    const listing = deps.agents.list();
    listing.catch(() => undefined);
    const report = await readiness({
      timeoutMs: CHECK_TIMEOUT_MS,
      exposeErrors: false,
      checks: [
        { name: 'database', check: guarded('database', () => { deps.store.db.prepare('SELECT 1').get(); }) },
        { name: 'magnus', check: guarded('magnus', async () => {
          const list = await listing;
          if (list.magnus.state !== 'ok') throw new Error(list.magnus.error ?? 'unavailable');
        }) },
        { name: 'hivemem', check: guarded('hivemem', async () => { await deps.hivemem.health(); }) },
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
        database: toCheck('database', checks['database']),
        magnus: toCheck('magnus', checks['magnus']),
        hivemem: toCheck('hivemem', checks['hivemem']),
        agents: { status: agents?.status === 'up' ? 'ok' : 'unavailable', available },
      },
    } };
  };

  register('GET', '/health/ready', async c => {
    if (!cached || Date.now() - cached.at > CACHE_MS) {
      running ??= refresh().finally(() => { running = undefined; });
      await running;
    }
    const result = cached!;
    c.header('cache-control', 'no-store');
    return c.json(result.body, result.ready ? 200 : 503);
  });
}
