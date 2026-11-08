import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import { AgentDirectory, type MagnusAgentApi } from '../src/agents/directory.js';
import type { IdentityLink } from '../src/auth/links.js';
import { createAuthenticator, createOathweaveVerifier } from '../src/auth/oathweave.js';
import { BlobStore } from '../src/blobs/store.js';
import type { KnowledgeSyncRequest, KnowledgeSyncResponse } from '../src/clients/hivemem.js';
import type { MagnusArdentProfile } from '../src/clients/magnus.js';
import { openDatabase } from '../src/db/database.js';
import type { Clock } from '../src/db/json.js';
import { Store } from '../src/db/store.js';
import { EventBus } from '../src/events/bus.js';
import { KnowledgeSync } from '../src/knowledge/sync.js';
import { silentLogger } from '../src/logger.js';
import { createApp } from '../src/server/app.js';
import { ARDENT_STUDIO_API_PREFIX, ARDENT_STUDIO_PERMISSIONS, IDEMPOTENCY_HEADER } from '../src/shared/browser.js';
import { loadSeedTemplates } from '../src/templates/seeds.js';

export const ISSUER = 'https://identity.example.com';
export const JWKS_URL = 'https://identity.example.com/jwks';
export const USERINFO_URL = 'https://identity.example.com/userinfo';
export const ALL = [...ARDENT_STUDIO_PERMISSIONS];

export interface Keys {
  privateKey: CryptoKey;
  jwks: JWTVerifyGetKey;
}

export async function makeKeys(): Promise<Keys> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(publicKey), kid: 'fixture-key', alg: 'RS256' };
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

export async function signToken(keys: Keys, claims: { sub?: string; permissions?: string[]; aud?: string; actorType?: string; lifetime?: number; iss?: string; sessionId?: string | null } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    actorType: claims.actorType ?? 'USER',
    clientId: 'hivexui-ardentstudio',
    permissions: claims.permissions ?? ALL,
    roles: [],
  };
  if (claims.sessionId !== null) payload.sessionId = claims.sessionId ?? 'fixture-session';
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? 'ardentstudio')
    .setSubject(claims.sub ?? 'subject-operator')
    .setJti(crypto.randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + (claims.lifetime ?? 600))
    .sign(keys.privateKey);
}

/** A userinfo endpoint that answers for any subject unless it is revoked. */
export function userinfoFetch(revoked: Set<string> = new Set()): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const token = auth.slice(7);
    const sub = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sub: string };
    if (String(input) !== USERINFO_URL || revoked.has(sub.sub)) return new Response('{}', { status: 401 });
    return Response.json({ sub: sub.sub, name: `Name of ${sub.sub}` });
  }) as typeof fetch;
}

export const LINKS: IdentityLink[] = [
  { issuer: ISSUER, subject: 'subject-operator', localUserId: 'operator' },
  { issuer: ISSUER, subject: 'subject-viewer', localUserId: 'viewer', permissions: ['ardentstudio:projects:read', 'ardentstudio:templates:read'] },
];

export function profile(nodeId: string, id: string, overrides: Partial<MagnusArdentProfile> = {}): MagnusArdentProfile {
  return {
    id, name: id, backend: 'llamacpp', apiPort: 8700, running: true, a2aEnabled: false, channels: {}, error: null,
    nodeId, nodeName: `Node ${nodeId}`, hostname: `${nodeId}.example.com`, installationVersion: '2.2.0', reachable: true, ...overrides,
  };
}

export class FakeMagnus implements MagnusAgentApi {
  profiles: MagnusArdentProfile[] = [profile('node1', 'lead'), profile('node1', 'scout'), profile('node2', 'mapper')];
  fail = false;
  memory = new Map<string, 'ready' | 'degraded'>();
  skillMap = new Map<string, Array<{ name: string; enabled: boolean }>>();
  calls: Array<{ method: string; actingSubject: string | undefined }> = [];

  listProfiles = async (context: { actingSubject?: string | undefined } = {}) => {
    this.calls.push({ method: 'listProfiles', actingSubject: context.actingSubject });
    if (this.fail) throw new Error('Magnus unavailable');
    return this.profiles;
  };
  memoryStatus = async (ref: string) => ({ status: this.memory.get(ref) ?? 'ready', agent_id: ref, workspace_id: 'default', retrieval: null, storage: null, reason: null });
  skills = async (ref: string) => this.skillMap.get(ref) ?? [];
}

export class FakeHiveMem {
  workspaces = new Map<string, unknown>();
  syncs: KnowledgeSyncRequest[] = [];
  failSync = 0;
  failWorkspace = false;
  healthy = true;

  health = async () => { if (!this.healthy) throw new Error('HiveMem down'); return { status: 'ok' }; };
  ensureWorkspace = async (input: { workspace_id: string }) => {
    if (this.failWorkspace) throw new Error('HiveMem unavailable');
    this.workspaces.set(input.workspace_id, input);
    return { workspace_id: input.workspace_id, owner_agent_id: 'ardentstudio' };
  };
  syncKnowledgeSourceChecked = async (body: Omit<KnowledgeSyncRequest, 'mode'>): Promise<{ preview: KnowledgeSyncResponse; applied: KnowledgeSyncResponse }> => {
    if (this.failSync > 0) { this.failSync--; throw new Error('HiveMem answered HTTP 503'); }
    const result = (mode: 'preview' | 'apply'): KnowledgeSyncResponse => ({ mode, workspace_id: body.workspace_id, project_id: body.project_id, source_id: body.source_id,
      revision: body.revision, created: body.chunks.length, superseded: 0, retired: 0, unchanged: 0 });
    this.syncs.push({ ...body, mode: 'preview' }, { ...body, mode: 'apply' });
    return { preview: result('preview'), applied: result('apply') };
  };
}

export class ManualClock implements Clock {
  constructor(public current = new Date('2026-11-08T12:00:00.000Z')) {}
  now(): Date { return new Date(this.current); }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
}

export interface TestContext {
  dir: string;
  store: Store;
  blobs: BlobStore;
  bus: EventBus;
  app: ReturnType<typeof createApp>;
  magnus: FakeMagnus;
  hivemem: FakeHiveMem;
  knowledge: KnowledgeSync;
  keys: Keys;
  revoked: Set<string>;
  token: (claims?: Parameters<typeof signToken>[1]) => Promise<string>;
  call: (method: string, path: string, options?: { token?: string | null; body?: unknown; raw?: BodyInit; headers?: Record<string, string>; key?: string | null }) => Promise<Response>;
  close: () => void;
}

let keyCache: Promise<Keys> | undefined;

export async function createTestContext(options: { clock?: Clock; maxBlobBytes?: number; heartbeatMs?: number; streamRecheckMs?: number; seed?: boolean } = {}): Promise<TestContext> {
  const dir = mkdtempSync(join(tmpdir(), 'ardent-studio-test-'));
  const clock = options.clock ?? { now: () => new Date() };
  const db = openDatabase(join(dir, 'studio.sqlite'));
  const bus = new EventBus();
  const store = new Store(db, clock, bus);
  const blobs = new BlobStore(db, dir, options.maxBlobBytes ?? 64 * 1024 * 1024, clock);
  if (options.seed !== false) loadSeedTemplates(store);
  const keys = await (keyCache ??= makeKeys());
  const revoked = new Set<string>();
  const authenticate = createAuthenticator(
    createOathweaveVerifier({ issuer: ISSUER, jwksUrl: JWKS_URL, userinfoUrl: USERINFO_URL }, { keys: keys.jwks, fetch: userinfoFetch(revoked) }), LINKS);
  const magnus = new FakeMagnus();
  const hivemem = new FakeHiveMem();
  const knowledge = new KnowledgeSync(store, blobs, hivemem, silentLogger);
  const agents = new AgentDirectory(magnus, store, { cacheMs: 0 });
  const app = createApp({ store, blobs, bus, authenticate, agents, hivemem, knowledge, logger: silentLogger,
    ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}), ...(options.streamRecheckMs ? { streamRecheckMs: options.streamRecheckMs } : {}) });
  let counter = 0;
  const token = (claims?: Parameters<typeof signToken>[1]) => signToken(keys, claims);
  const defaultToken = await token();
  const call: TestContext['call'] = async (method, path, call = {}) => {
    const headers: Record<string, string> = { ...call.headers };
    const bearer = call.token === undefined ? defaultToken : call.token;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (method !== 'GET' && call.key !== null) headers[IDEMPOTENCY_HEADER] = call.key ?? `fixture-key-${++counter}-${Date.now()}`;
    let body: BodyInit | undefined = call.raw;
    if (call.body !== undefined) { body = JSON.stringify(call.body); headers['content-type'] = 'application/json'; }
    return app.request(`${ARDENT_STUDIO_API_PREFIX}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  };
  return {
    dir, store, blobs, bus, app, magnus, hivemem, knowledge, keys, revoked, token, call,
    close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

export async function json<T = any>(response: Response): Promise<T> {
  return await response.json() as T;
}

export async function createProject(ctx: TestContext, body: Record<string, unknown> = {}): Promise<{ id: string } & Record<string, any>> {
  const response = await ctx.call('POST', '/projects', { body: { name: 'Emberfall One-Shot', brief_md: 'A short adventure.', ...body } });
  if (response.status !== 201) throw new Error(`create project failed: ${response.status} ${await response.text()}`);
  const project = await json<{ id: string } & Record<string, any>>(response);
  // Workspace creation runs in the background; wait for its outcome so event counts are stable.
  for (let attempt = 0; attempt < 100 && ctx.store.projects.get(project.id)?.hivemem.state === 'pending'; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  return project;
}
