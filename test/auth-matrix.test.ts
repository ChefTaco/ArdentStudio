import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARDENT_STUDIO_API_PREFIX, ardentStudioBrowserRoutes, IDEMPOTENCY_HEADER, type ArdentStudioBrowserRoute } from '../src/shared/browser.js';
import { createProject, createTestContext, json, type TestContext } from './helpers.js';

let ctx: TestContext;
let values: Record<string, string>;

beforeAll(async () => {
  ctx = await createTestContext();
  const project = await createProject(ctx);
  const file = await json(await ctx.call('POST', `/projects/${project.id}/files?name=a.md`, { raw: '# A', headers: { 'content-type': 'text/markdown' } }));
  const template = (await json(await ctx.call('GET', '/templates?kind=team'))).templates[0];
  values = { projectId: project.id, fileId: file.id, sha256: file.sha256, templateId: template.id, version: '1' };
});
afterAll(() => ctx?.close());

function request(route: ArdentStudioBrowserRoute, token: string | undefined, key = true) {
  const path = route.path.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => values[name]!);
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (key && route.idempotent) headers[IDEMPOTENCY_HEADER] = `fixture-matrix-${Math.random().toString(36).slice(2)}`;
  let body: string | undefined;
  if (route.requestBody === 'raw') { headers['content-type'] = 'text/plain'; body = 'matrix'; }
  if (route.requestBody === 'json') { headers['content-type'] = 'application/json'; body = '{}'; }
  const query = route.requestBody === 'raw' ? '?name=matrix.txt' : '';
  return ctx.app.request(`${ARDENT_STUDIO_API_PREFIX}${path}${query}`, { method: route.method, headers, ...(body !== undefined ? { body } : {}) });
}

async function status(response: Response): Promise<number> {
  await response.body?.cancel();
  return response.status;
}

describe('route auth matrix', () => {
  for (const route of ardentStudioBrowserRoutes) {
    const name = `${route.method} ${route.path}`;
    if (!route.permissions.length) {
      it(`${name} is public`, async () => {
        expect(await status(await request(route, undefined))).not.toBe(401);
      });
      continue;
    }
    it(`${name} requires a token, a link and ${route.permissions.join(' + ')}`, async () => {
      expect(await status(await request(route, undefined))).toBe(401);
      expect(await status(await request(route, 'not-a-jwt'))).toBe(401);
      expect(await status(await request(route, await ctx.token({ aud: 'magnus' })))).toBe(401);
      const unlinked = await request(route, await ctx.token({ sub: 'subject-unlinked' }));
      expect(unlinked.status).toBe(403);
      expect((await json(unlinked)).error.code).toBe('NO_ACCOUNT_LINK');
      const others = await ctx.token({ permissions: ['ardentstudio:agents:admin', 'ardentstudio:review:write'].filter(permission => !route.permissions.includes(permission as never) && permission !== route.orPermission) });
      expect(await status(await request(route, others))).toBe(403);
      const exact = await request(route, await ctx.token({ permissions: [...route.permissions] }));
      expect([401, 403]).not.toContain(exact.status);
      await exact.body?.cancel();
      const service = await request(route, await ctx.serviceToken({ permissions: [...route.permissions] }));
      expect(service.status).toBe(route.accept === 'any' ? 200 : 401);
      await service.body?.cancel();
      if (route.idempotent) {
        const missing = await request(route, await ctx.token({ permissions: [...route.permissions] }), false);
        expect(missing.status).toBe(400);
        expect((await json(missing)).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      }
    });
  }

  it('honours the link permission ceiling', async () => {
    const viewer = await ctx.token({ sub: 'subject-viewer' });
    expect((await ctx.call('GET', '/projects', { token: viewer })).status).toBe(200);
    expect((await ctx.call('POST', '/projects', { token: viewer, body: { name: 'No' } })).status).toBe(403);
  });
});
