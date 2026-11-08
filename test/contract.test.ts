import { readFileSync } from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderOpenApi } from '../scripts/export-browser-contracts.js';
import { honoPath, unregisteredRoutes } from '../src/server/routing.js';
import { ARDENT_STUDIO_API_PREFIX, ardentStudioBrowserRoutes } from '../src/shared/browser.js';
import { createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeAll(async () => { ctx = await createTestContext({ seed: false }); });
afterAll(() => ctx?.close());

describe('browser contract', () => {
  it('has a handler for every route, and no undocumented API routes', () => {
    expect(unregisteredRoutes(ctx.app)).toEqual([]);
    const documented = new Set(ardentStudioBrowserRoutes.map(route => `${route.method} ${honoPath(route.path)}`));
    const served = ctx.app.routes.filter(route => route.path.startsWith(ARDENT_STUDIO_API_PREFIX) && route.method !== 'ALL').map(route => `${route.method} ${route.path}`);
    expect(served.filter(route => !documented.has(route))).toEqual([]);
  });

  it('marks every mutation idempotent except side-effect-free validation and previews', () => {
    const exempt = ardentStudioBrowserRoutes.filter(route => route.method !== 'GET' && !route.idempotent).map(route => `${route.method} ${route.path}`);
    expect(exempt).toEqual(['POST /projects/{projectId}/team/validate', 'POST /agents/{agentRef}/preview']);
    expect(ardentStudioBrowserRoutes.filter(route => route.method === 'GET' && route.idempotent)).toEqual([]);
  });

  it('is zod-only so a browser can vendor it', () => {
    const source = readFileSync(new URL('../src/shared/browser.ts', import.meta.url), 'utf8');
    expect([...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1])).toEqual(['zod']);
  });

  it('matches the committed OpenAPI document, which is valid OpenAPI 3.1', async () => {
    const committed = readFileSync(new URL('../docs/openapi-browser.json', import.meta.url), 'utf8');
    expect(committed).toBe(renderOpenApi());
    const document = JSON.parse(committed) as Parameters<typeof SwaggerParser.validate>[0];
    await expect(SwaggerParser.validate(document)).resolves.toBeTruthy();
  });
});
