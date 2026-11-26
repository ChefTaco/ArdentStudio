import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { createService, listen, shutdown, type Service } from '../src/service.js';
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

  it('shuts down in order: event streams end, requests in flight get a grace period, then the database closes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ardent-studio-service-'));
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'fixture-service-token', expires_in: 300 });
      if (url.endsWith('/v1/health')) return Response.json({ status: 'ok' });
      return Response.json({ success: true, data: [] });
    }) as typeof fetch;
    const running = createService(config(), {
      logger: silentLogger, fetch: fetcher,
      authenticate: async () => ({ userId: 'operator', subject: 'subject-operator', issuer: 'https://identity.example.com', displayName: 'Operator', permissions: [...ALL], expiresAt: Math.floor(Date.now() / 1000) + 600 }),
    });
    service = running;
    const server = listen(running, { ...config(), port: 0 }, silentLogger);
    await new Promise(resolve => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const project = running.store.tx(() => running.store.projects.create({ name: 'Shutdown', brief_md: '', audience: null, constraints: [], tags: [], deliverables: [], createdBy: 'operator' }));
    const stream = await fetch(`http://127.0.0.1:${port}/api/ardentstudio/v1/projects/${project.id}/stream`, { headers: { authorization: 'Bearer fixture' } });
    expect(stream.status).toBe(200);
    const drained = new Response(stream.body).text();

    // An open stream alone does not hold shutdown up.
    const started = Date.now();
    service = undefined;
    await shutdown(running, server, silentLogger, 5_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    await drained;
    expect(() => running.store.db.prepare('SELECT 1').get()).toThrow();
  });

  it('closes a connection still busy after the grace period before closing the database', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ardent-studio-service-'));
    const running = createService(config(), { logger: silentLogger, fetch: (async () => Response.json({ success: true, data: [] })) as typeof fetch });
    const server = listen(running, { ...config(), port: 0 }, silentLogger);
    await new Promise(resolve => server.once('listening', resolve));
    // A request whose body never finishes arriving keeps its connection busy.
    const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write('POST /api/ardentstudio/v1/projects HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{');
    socket.resume();
    const ended = new Promise(resolve => socket.once('close', resolve));
    await new Promise(resolve => setTimeout(resolve, 50));
    const started = Date.now();
    const warnings: string[] = [];
    await shutdown(running, server, { ...silentLogger, warn: message => warnings.push(message) }, 200);
    expect(warnings).toEqual(['Closing connections still open after the shutdown grace period']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    await ended;
    expect(() => running.store.db.prepare('SELECT 1').get()).toThrow();
  });
});
