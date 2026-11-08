import { Hono } from 'hono';
import { ARDENT_STUDIO_API_PREFIX } from '../shared/browser.js';
import type { AppDeps } from './deps.js';
import type { AppEnv } from './env.js';
import { errorResponse } from './errors.js';
import { createRouter } from './routing.js';
import { agentRoutes } from './routes/agents.js';
import { fileRoutes } from './routes/files.js';
import { healthRoutes } from './routes/health.js';
import { projectRoutes } from './routes/projects.js';
import { streamRoutes } from './routes/stream.js';
import { teamRoutes } from './routes/team.js';
import { templateRoutes } from './routes/templates.js';

/** The ArdentStudio HTTP API under /api/ardentstudio/v1. */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('x-frame-options', 'DENY');
    if (!c.res.headers.has('cache-control')) c.header('cache-control', 'no-store');
  });
  app.onError((error, c) => errorResponse(c, error, deps.logger));
  app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: c.req.path.startsWith(ARDENT_STUDIO_API_PREFIX) ? 'No such route' : 'Not found' } }, 404));

  const register = createRouter(app, { store: deps.store, authenticate: deps.authenticate });
  healthRoutes(register, deps);
  projectRoutes(register, deps);
  fileRoutes(register, deps);
  templateRoutes(register, deps);
  teamRoutes(register, deps);
  agentRoutes(register, deps);
  streamRoutes(register, deps);
  return app;
}
