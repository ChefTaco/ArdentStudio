// Every route is registered from its entry in the browser contract, so the permissions,
// idempotency rule, query and body schemas the contract publishes are the ones enforced.
import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { AccessDenied, type Authenticator, type Principal } from '../auth/oathweave.js';
import type { Store } from '../db/store.js';
import { ARDENT_STUDIO_API_PREFIX, ardentStudioBrowserRoutes, IDEMPOTENCY_HEADER, idempotencyKeySchema, type ArdentStudioBrowserRoute } from '../shared/browser.js';
import type { AppEnv } from './env.js';
import { ApiError } from './errors.js';

export const JSON_BODY_LIMIT = 1024 * 1024;

export interface Reply {
  status?: 200 | 201;
  body: unknown;
}

export interface RouteInput {
  params: Record<string, string>;
  query: unknown;
  body: unknown;
  principal: Principal | undefined;
  idempotencyKey: string | undefined;
  /** For raw-body routes: make the rest of the handler idempotent once the body is known. */
  idempotent: (fingerprint: string, run: () => Promise<Reply> | Reply) => Promise<Reply>;
}

export type RouteHandler = (c: Context<AppEnv>, input: RouteInput) => Promise<Reply | Response> | Reply | Response;

export function routeDefinition(method: ArdentStudioBrowserRoute['method'], path: string): ArdentStudioBrowserRoute {
  const route = ardentStudioBrowserRoutes.find(item => item.method === method && item.path === path);
  if (!route) throw new Error(`Route ${method} ${path} is not in the browser contract`);
  return route;
}

/** `/projects/{projectId}` → `/projects/:projectId` */
export function honoPath(path: string): string {
  return `${ARDENT_STUDIO_API_PREFIX}${path.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1')}`;
}

export function bearerToken(c: Context): string | undefined {
  const header = c.req.header('authorization');
  const match = header ? /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header) : null;
  return match?.[1];
}

export async function authenticateRequest(c: Context, authenticate: Authenticator, permissions: readonly string[]): Promise<Principal> {
  const token = bearerToken(c);
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'A bearer token is required');
  let principal: Principal;
  try {
    principal = await authenticate(token);
  } catch (error) {
    if (error instanceof AccessDenied) throw new ApiError(403, 'NO_ACCOUNT_LINK', 'This identity has no Ardent Project Studio account link');
    throw new ApiError(401, 'UNAUTHENTICATED', 'The bearer token is not valid');
  }
  const missing = permissions.filter(permission => !principal.permissions.includes(permission as Principal['permissions'][number]));
  if (missing.length) throw new ApiError(403, 'FORBIDDEN', 'Missing permission', { missing });
  return principal;
}

async function readJsonBody(c: Context): Promise<{ value: unknown; text: string }> {
  const length = Number(c.req.header('content-length') ?? '0');
  if (length > JSON_BODY_LIMIT) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'The JSON body is too large');
  const type = c.req.header('content-type') ?? '';
  const text = await c.req.text();
  if (Buffer.byteLength(text) > JSON_BODY_LIMIT) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'The JSON body is too large');
  if (!text.trim()) return { value: {}, text: '' };
  if (!/^application\/json\b/i.test(type)) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the body as application/json');
  try { return { value: JSON.parse(text) as unknown, text }; } catch { throw new ApiError(400, 'VALIDATION_ERROR', 'The body is not valid JSON'); }
}

function fingerprintOf(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

export function createRouter(app: Hono<AppEnv>, deps: { store: Store; authenticate: Authenticator }) {
  return function register(method: ArdentStudioBrowserRoute['method'], path: string, handler: RouteHandler): void {
    const route = routeDefinition(method, path);
    app.on(method, honoPath(path), async c => {
      const principal = route.permissions.length ? await authenticateRequest(c, deps.authenticate, route.permissions) : undefined;
      c.set('principal', principal);

      let idempotencyKey: string | undefined;
      if (route.idempotent) {
        const parsed = idempotencyKeySchema.safeParse(c.req.header(IDEMPOTENCY_HEADER));
        if (!parsed.success) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', `Send a ${IDEMPOTENCY_HEADER} header (8-128 of A-Z a-z 0-9 . _ : -)`);
        idempotencyKey = parsed.data;
      }

      const query = route.query ? route.query.parse(c.req.query()) : undefined;
      let body: unknown;
      let bodyText = '';
      if (route.requestBody === 'json') {
        const read = await readJsonBody(c);
        bodyText = read.text;
        body = route.request ? route.request.parse(read.value) : read.value;
      } else if (route.requestBody === undefined && route.idempotent && (c.req.header('content-length') ?? '0') !== '0') {
        // Body-less mutations ignore any body, but a large one is refused rather than buffered.
        if (Number(c.req.header('content-length')) > JSON_BODY_LIMIT) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'This request takes no body');
      }

      const idempotent = async (fingerprint: string, run: () => Promise<Reply> | Reply): Promise<Reply> => {
        if (!idempotencyKey || !principal) return run();
        const claim = deps.store.idempotency.claim(principal.userId, idempotencyKey, method, c.req.path, fingerprint);
        if (claim.kind === 'replay') {
          c.header('idempotent-replayed', 'true');
          return { status: claim.status === 201 ? 201 : 200, body: claim.body };
        }
        if (claim.kind === 'in_progress') throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this idempotency key is still running');
        if (claim.kind === 'mismatch') throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for a different request');
        try {
          const reply = await run();
          const status = reply.status ?? route.successStatus ?? 200;
          deps.store.idempotency.complete(principal.userId, idempotencyKey, status, reply.body);
          return { status, body: reply.body };
        } catch (error) {
          deps.store.idempotency.release(principal.userId, idempotencyKey);
          throw error;
        }
      };

      const input: RouteInput = { params: c.req.param() as Record<string, string>, query, body, principal, idempotencyKey, idempotent };
      const result = route.idempotent && route.requestBody !== 'raw'
        ? await idempotent(fingerprintOf(bodyText, new URL(c.req.url).search), async () => {
          const reply = await handler(c, input);
          if (reply instanceof Response) throw new Error('Idempotent JSON routes must return a Reply');
          return reply;
        })
        : await handler(c, input);
      if (result instanceof Response) return result;
      c.header('cache-control', 'no-store');
      return c.json(result.body, result.status ?? route.successStatus ?? 200);
    });
  };
}

/** The contract routes that have no handler yet. Empty once the app is fully registered. */
export function unregisteredRoutes(app: Hono<AppEnv>): string[] {
  const have = new Set(app.routes.map(route => `${route.method} ${route.path}`));
  return ardentStudioBrowserRoutes.filter(route => !have.has(`${route.method} ${honoPath(route.path)}`)).map(route => `${route.method} ${route.path}`);
}
