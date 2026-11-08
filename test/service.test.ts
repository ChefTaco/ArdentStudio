import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { createService, listen, type Service } from '../src/service.js';
import { ALL } from './helpers.js';

let dir: string;
let service: Service | undefined;
afterEach(async () => { await service?.stop(); service = undefined; rmSync(dir, { recursive: true, force: true }); });

function config() {
  return loadConfig({
    ARDENT_STUDIO_DATA: dir,
    OATHWEAVE_ISSUER: 'https://identity.example.com',
    OATHWEAVE_JWKS_URL: 'https://identity.example.com/jwks',
    OATHWEAVE_USERINFO_URL: 'https://identity.example.com/userinfo',
    ARDENT_STUDIO_OATHWEAVE_IDENTITIES_JSON: '[]',
    ARDENT_STUDIO_OATHWEAVE_TOKEN_URL: 'https://identity.example.com/api/v1/oauth/token',
    ARDENT_STUDIO_MAGNUS_URL: 'https://magnus.example.com',
    ARDENT_STUDIO_MAGNUS_CLIENT_ID: 'ardentstudio-magnus',
    ARDENT_STUDIO_MAGNUS_CLIENT_SECRET: 'fixture-magnus-secret',
    ARDENT_STUDIO_HIVEMEM_URL: 'https://hivemem.example.com',
    ARDENT_STUDIO_HIVEMEM_CLIENT_ID: 'ardentstudio-hivemem',
    ARDENT_STUDIO_HIVEMEM_CLIENT_SECRET: 'fixture-hivemem-secret',
  });
}

describe('service wiring', () => {
  it('opens the data directory, recovers partial writes, seeds templates and serves the API', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ardent-studio-service-'));
    mkdirSync(join(dir, 'blobs', 'tmp'), { recursive: true });
    writeFileSync(join(dir, 'blobs', 'tmp', 'crashed.part'), 'partial');
    const requests: string[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'fixture-service-token', expires_in: 300 });
      if (url.endsWith('/api/v1/ardent/profiles')) return Response.json({ success: true, data: [] });
      if (url.endsWith('/v1/health')) return Response.json({ status: 'ok' });
      return new Response('', { status: 404 });
    }) as typeof fetch;
    service = createService(config(), {
      logger: silentLogger, fetch: fetcher,
      authenticate: async () => ({ userId: 'operator', subject: 'subject-operator', issuer: 'https://identity.example.com', displayName: 'Operator', permissions: [...ALL], expiresAt: Math.floor(Date.now() / 1000) + 600 }),
    });
    expect(readdirSync(join(dir, 'blobs', 'tmp'))).toEqual([]);
    const server = listen(service, { ...config(), port: 0 }, silentLogger);
    try {
      await new Promise(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ardentstudio/v1`;
      expect(await (await fetch(`${base}/health/live`)).json()).toEqual({ status: 'ok' });
      const ready = await fetch(`${base}/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ status: 'not_ready', checks: { magnus: { status: 'ok' }, hivemem: { status: 'ok' }, agents: { available: 0 } } });
      expect(requests).toContain('POST https://identity.example.com/api/v1/oauth/token');
      const templates = await (await fetch(`${base}/templates?kind=team`, { headers: { authorization: 'Bearer fixture' } })).json() as { templates: unknown[] };
      expect(templates.templates).toHaveLength(4);
    } finally {
      server.close();
    }
  });
});
