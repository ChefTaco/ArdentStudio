// A fake Magnus control API on loopback, for tests. It serves the Ardent routes ArdentStudio uses
// with synthetic data, and lets a test drive each Ardent task: journal events, live reply text
// and the final record, over a real HTTP server-sent event stream.
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MagnusArdentProfile } from '../src/clients/magnus.js';

export interface FakeTask {
  id: string; ref: string; context: 'direct' | 'mission' | 'preview'; session_id: string | null; prompt: string; body: Record<string, unknown>;
  idempotency_key: string; state: string; result: string | null; error: string | null;
  events: Array<{ sequence: number; task_id: string; kind: string; detail?: unknown; created_ms: number }>;
  live: { step: number; text: string } | undefined;
}

interface Subscriber { send: (event: string, data: unknown, id?: number) => void; end: () => void }

export function fakeProfile(nodeId: string, id: string, overrides: Partial<MagnusArdentProfile> = {}): MagnusArdentProfile {
  return {
    id, name: id, backend: 'llamacpp', apiPort: 8700, running: true, a2aEnabled: false, channels: {}, error: null,
    nodeId, nodeName: `Node ${nodeId}`, hostname: `${nodeId}.example.com`, installationVersion: '2.2.0', reachable: true, ...overrides,
  };
}

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const ok = (response: ServerResponse, data: unknown, status = 200) => json(response, status, { success: true, data });
const fail = (response: ServerResponse, status: number, code: string, message: string) => json(response, status, { success: false, error: { code, message } });

export class FakeMagnusServer {
  profiles: MagnusArdentProfile[] = [fakeProfile('node1', 'lead'), fakeProfile('node1', 'scout'), fakeProfile('node2', 'mapper')];
  /** Node agent Studio level per node (default 2). */
  studio = new Map<string, number>();
  fail = false;
  memory = new Map<string, 'ready' | 'degraded'>();
  skillMap = new Map<string, Array<{ name: string; enabled: boolean }>>();
  calls: Array<{ method: string; path: string; actingSubject: string | undefined; body?: unknown }> = [];
  tasks = new Map<string, FakeTask>();
  sessions = new Map<string, { id: string; key: string; context: string }>();
  /** Answer task streams with 503 (the follower then polls). */
  failStreams = false;
  /** End each task stream after this long, as Ardent does after 60 s. */
  streamLimitMs = 60_000;
  /** Make the next n submissions fail with 503. */
  failSubmissions = 0;
  streamsOpened = 0;
  artifacts = new Map<string, { bytes: Uint8Array; mime: string }>();
  /** Serve these bytes instead of the stored ones (a corrupted relay). */
  artifactOverride = new Map<string, Uint8Array>();
  /** Real Magnus refuses identity-save and skill-set from a service identity; set true to model a Magnus that allows them. */
  allowAgentEdits = false;
  identities = new Map<string, { text: string; revision: string }>();
  skillRevision = 'c'.repeat(64);
  development = new Map<string, Array<Record<string, unknown>>>();
  notes: Array<{ ref: string; body: Record<string, unknown>; actingSubject: string | undefined }> = [];
  /** Oathweave subjects that are Magnus ADMINs. */
  admins = new Set(['subject-operator']);
  operations = new Map<string, Record<string, unknown>>();
  private readonly operationSubscribers = new Map<string, Set<Subscriber>>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly waiters: Array<() => void> = [];
  private server: Server | undefined;
  url = '';

  async start(): Promise<this> {
    this.server = createServer((request, response) => { void this.handle(request, response).catch(error => fail(response, 500, 'INTERNAL', String(error))); });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    for (const set of this.subscribers.values()) for (const subscriber of set) subscriber.end();
    this.server?.closeAllConnections();
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
  }

  // ── Test controls ──

  /** Resolves once at least n tasks were submitted. */
  async submitted(n = 1, timeoutMs = 3000): Promise<FakeTask[]> {
    const until = Date.now() + timeoutMs;
    while (this.tasks.size < n) {
      if (Date.now() > until) throw new Error(`expected ${n} submitted tasks, have ${this.tasks.size}`);
      await new Promise<void>(resolve => { this.waiters.push(resolve); setTimeout(resolve, 20); });
    }
    return [...this.tasks.values()];
  }

  task(index: number): FakeTask {
    const task = [...this.tasks.values()][index];
    if (!task) throw new Error(`no task ${index}`);
    return task;
  }

  event(taskId: string, kind: string, detail?: unknown): number {
    const task = this.tasks.get(taskId)!;
    const sequence = (task.events.at(-1)?.sequence ?? 0) + 1;
    const event = { sequence, task_id: taskId, kind, ...(detail !== undefined ? { detail } : {}), created_ms: Date.now() };
    task.events.push(event);
    for (const subscriber of this.subscribers.get(taskId) ?? []) subscriber.send('task.event', event, sequence);
    return sequence;
  }

  setState(taskId: string, state: string): void {
    const task = this.tasks.get(taskId)!;
    this.event(taskId, 'state', { from: task.state, to: state, error: null });
    task.state = state;
  }

  text(taskId: string, step: number, text: string): void {
    const task = this.tasks.get(taskId)!;
    task.live = { step, text };
    for (const subscriber of this.subscribers.get(taskId) ?? []) subscriber.send('task.text', { step, text });
  }

  delta(taskId: string, step: number, text: string): void {
    const task = this.tasks.get(taskId)!;
    task.live = { step, text: (task.live?.step === step ? task.live.text : '') + text };
    for (const subscriber of this.subscribers.get(taskId) ?? []) subscriber.send('task.delta', { step, text });
  }

  finish(taskId: string, final: { state: string; result?: string | null; error?: string | null }): void {
    const task = this.tasks.get(taskId)!;
    this.event(taskId, 'state', { from: task.state, to: final.state, error: final.error ?? null });
    task.state = final.state;
    task.result = final.result ?? null;
    task.error = final.error ?? null;
    task.live = undefined;
    if (['completed', 'partial', 'failed', 'cancelled', 'unknown'].includes(final.state)) {
      for (const subscriber of this.subscribers.get(taskId) ?? []) { subscriber.send('task.done', this.record(task)); subscriber.end(); }
    }
  }

  /** Close every open stream of a task without a done event (a dropped connection). */
  dropStreams(taskId: string): void {
    for (const subscriber of this.subscribers.get(taskId) ?? []) subscriber.end();
  }

  openStreams(taskId: string): number {
    return this.subscribers.get(taskId)?.size ?? 0;
  }

  addArtifact(bytes: Uint8Array, mime: string): string {
    const sha = createHash('sha256').update(bytes).digest('hex');
    this.artifacts.set(sha, { bytes, mime });
    return sha;
  }

  identityOf(ref: string, kind: string): { text: string; revision: string } {
    const key = `${ref}|${kind}`;
    let value = this.identities.get(key);
    if (!value) {
      const text = `# ${kind} of ${ref}\n`;
      value = { text, revision: createHash('sha256').update(text).digest('hex') };
      this.identities.set(key, value);
    }
    return value;
  }

  /** Change a New Agent operation and push it to open operation streams. */
  updateOperation(id: string, patch: Record<string, unknown>): void {
    const next: Record<string, unknown> = { ...this.operations.get(id)!, ...patch, updatedAt: new Date().toISOString() };
    this.operations.set(id, next);
    for (const subscriber of this.operationSubscribers.get(id) ?? []) {
      subscriber.send(next.status === 'running' ? 'operation' : 'done', next);
      if (next.status !== 'running') subscriber.end();
    }
  }

  record(task: FakeTask) {
    return { id: task.id, caller: 'management', context: task.context, session_id: task.session_id, prompt: task.prompt, content_hash: 'x',
      idempotency_key: task.idempotency_key, backend: 'llamacpp', state: task.state, result: task.result, error: task.error,
      deadline_ms: 0, created_ms: 0, updated_ms: 0 };
  }

  // ── HTTP ──

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fake');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : undefined;
    const actingSubject = request.headers['x-acting-subject'] as string | undefined;
    this.calls.push({ method: request.method ?? 'GET', path: url.pathname, actingSubject, ...(body !== undefined ? { body } : {}) });
    if (request.headers.authorization !== 'Bearer fixture-service-token') return fail(response, 401, 'UNAUTHENTICATED', 'bad token');
    const path = url.pathname;
    if (this.fail) return fail(response, 503, 'DEPENDENCY_UNAVAILABLE', 'Magnus unavailable');

    if (request.method === 'GET' && path === '/api/v1/ardent/profiles') return ok(response, this.profiles);
    if (request.method === 'POST' && path === '/api/v1/ardent/agents') {
      if (!actingSubject || !this.admins.has(actingSubject)) return fail(response, 403, 'ACTING_ADMIN_REQUIRED', 'The acting person is not a Magnus ADMIN');
      const input = body as Record<string, unknown>;
      if (this.profiles.some(item => item.nodeId === input.nodeId && item.id === input.profile)) return fail(response, 409, 'CONFLICT', 'The profile exists');
      const id = randomUUID();
      const now = new Date().toISOString();
      this.operations.set(id, { id, kind: 'deploy', nodeId: input.nodeId, profile: input.profile, status: 'running', error: null, createdBy: 'operator', attempts: 1,
        request: { apiPort: null, model: input.model, skills: input.skills, hivemem: true, artifacts_max_bytes: null }, createdAt: now, updatedAt: now, completedAt: null,
        steps: [{ name: 'profile-create', status: 'running', startedAt: now, finishedAt: null, receipt: null, error: null }] });
      return ok(response, { operationId: id }, 202);
    }
    const operation = /^\/api\/v1\/ardent\/agents\/operations\/([^/]+)(\/stream)?$/.exec(path);
    if (request.method === 'GET' && operation) {
      const current = this.operations.get(operation[1]!);
      if (!current) return fail(response, 404, 'NOT_FOUND', 'Unknown operation');
      if (!operation[2]) return ok(response, current);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event: string, data: unknown) => { response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      let set = this.operationSubscribers.get(operation[1]!);
      if (!set) { set = new Set(); this.operationSubscribers.set(operation[1]!, set); }
      const subscriber: Subscriber = { send, end: () => { set.delete(subscriber); response.end(); } };
      request.on('close', () => set.delete(subscriber));
      send(current.status === 'running' ? 'operation' : 'done', current);
      if (current.status !== 'running') { response.end(); return; }
      set.add(subscriber);
      return;
    }
    let match = /^\/api\/v1\/ardent\/installations\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && match) {
      const nodeId = match[1]!;
      const profiles = this.profiles.filter(item => item.nodeId === nodeId);
      return ok(response, { installed: true, version: profiles[0]?.installationVersion ?? '2.2.0', owner: 'operator', profiles, checkedAt: new Date().toISOString(),
        nodeId, nodeName: `Node ${nodeId}`, hostname: `${nodeId}.example.com`, reachable: true, error: null, capabilities: { studio: this.studio.get(nodeId) ?? 2 } });
    }
    match = /^\/api\/v1\/ardent\/installations\/([^/]+)\/profiles\/([^/]+)\/(.+)$/.exec(path);
    if (!match) return fail(response, 404, 'NOT_FOUND', 'No such route');
    const [, nodeId, profile, rest] = match as unknown as [string, string, string, string];
    const ref = `${nodeId}~${profile}`;
    const level = this.studio.get(nodeId) ?? 2;
    if (request.method === 'POST' && rest === 'action') return this.action(response, ref, level, body ?? {}, actingSubject);
    if (request.method !== 'GET') return fail(response, 404, 'NOT_FOUND', 'No such route');
    if (rest === 'memory/status') return ok(response, { status: this.memory.get(ref) ?? 'ready', agent_id: ref, workspace_id: 'default', retrieval: null, storage: null, reason: null });
    if (rest === 'skills') return ok(response, { skills: this.skillMap.get(ref) ?? [] });
    if (rest === 'status') return ok(response, { version: '2.2.0', profile, backend: 'llamacpp', tasks: this.tasks.size });
    match = /^identity\/(soul|identity)$/.exec(rest);
    if (match) return ok(response, { kind: match[1], name: `${match[1]!.toUpperCase()}.md`, ...this.identityOf(ref, match[1]!) });
    if (rest === 'development') {
      if (level < 2) return fail(response, 409, 'AGENT_UPGRADE_REQUIRED', `Upgrade the Magnus agent on Node ${nodeId}`);
      const records = this.development.get(ref) ?? [];
      const after = url.searchParams.get('after');
      const start = after ? records.findIndex(item => item.id === after) + 1 : 0;
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const page = records.slice(start, start + limit);
      return ok(response, { records: page, next: start + limit < records.length ? String(page.at(-1)!.id) : null });
    }
    match = /^artifacts\/([a-f0-9]{64})$/.exec(rest);
    if (match) {
      const artifact = this.artifacts.get(match[1]!);
      if (!artifact) return fail(response, 404, 'NOT_FOUND', 'Ardent resource not found');
      const bytes = this.artifactOverride.get(match[1]!) ?? artifact.bytes;
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) });
      response.end(Buffer.from(bytes));
      return;
    }
    match = /^tasks\/([0-9a-f-]{36})(\/events|\/stream)?$/.exec(rest);
    if (match) {
      const task = this.tasks.get(match[1]!);
      if (!task) return fail(response, 404, 'NOT_FOUND', 'Ardent task, session or resource not found');
      const after = Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? '0');
      if (!match[2]) return ok(response, this.record(task));
      if (match[2] === '/events') return ok(response, { events: task.events.filter(event => event.sequence > after) });
      return this.stream(request, response, task, after);
    }
    return fail(response, 404, 'NOT_FOUND', 'No such resource');
  }

  private stream(request: IncomingMessage, response: ServerResponse, task: FakeTask, after: number): void {
    if (this.failStreams) return fail(response, 503, 'DEPENDENCY_UNAVAILABLE', 'Ardent stream unavailable');
    this.streamsOpened++;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const send = (event: string, data: unknown, id?: number) => { response.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    let set = this.subscribers.get(task.id);
    if (!set) { set = new Set(); this.subscribers.set(task.id, set); }
    const subscriber: Subscriber = { send, end: () => { set.delete(subscriber); clearTimeout(limit); response.end(); } };
    const limit = setTimeout(() => subscriber.end(), this.streamLimitMs);
    request.on('close', () => { set.delete(subscriber); clearTimeout(limit); });
    if (task.live) send('task.text', task.live);
    for (const event of task.events.filter(item => item.sequence > after)) send('task.event', event, event.sequence);
    if (['completed', 'partial', 'failed', 'cancelled', 'unknown'].includes(task.state)) { send('task.done', this.record(task)); subscriber.end(); return; }
    set.add(subscriber);
  }

  private action(response: ServerResponse, ref: string, level: number, body: Record<string, unknown>, actingSubject: string | undefined): void {
    const action = String(body.action);
    const input = (body.body ?? {}) as Record<string, unknown>;
    const needs = (minimum: number) => level < minimum ? (fail(response, 409, 'AGENT_UPGRADE_REQUIRED', `Upgrade the Magnus agent on Node ${ref.split('~')[0]}`), true) : false;
    switch (action) {
      case 'session-open': {
        if (needs(input.context ? 2 : 1)) return;
        const context = String(input.context ?? 'direct');
        const key = `${ref}|${context}|${String(input.key)}`;
        let session = this.sessions.get(key);
        if (!session) { session = { id: randomUUID(), key: String(input.key), context }; this.sessions.set(key, session); }
        return ok(response, { id: session.id, caller: 'management', context, key: session.key, created_ms: 1, updated_ms: 1 });
      }
      case 'task-submit': case 'mission-submit': case 'preview-submit': {
        if (action !== 'task-submit' && needs(2)) return;
        if (action === 'preview-submit' && !actingSubject) return fail(response, 403, 'ACTING_SUBJECT_REQUIRED', 'needs a person');
        if (this.failSubmissions > 0) { this.failSubmissions--; return fail(response, 503, 'DEPENDENCY_UNAVAILABLE', 'Ardent node unavailable'); }
        const key = String(input.idempotency_key ?? randomUUID());
        const existing = [...this.tasks.values()].find(item => item.ref === ref && item.idempotency_key === key);
        if (existing) return ok(response, { task_id: existing.id, state: existing.state });
        const id = randomUUID();
        const task: FakeTask = { id, ref, context: action === 'mission-submit' ? 'mission' : action === 'preview-submit' ? 'preview' : 'direct',
          session_id: (input.session_id as string | undefined) ?? null, prompt: String(input.prompt ?? input.objective ?? ''), body: input, idempotency_key: key,
          state: 'queued', result: null, error: null, events: [], live: undefined };
        this.tasks.set(id, task);
        for (const waiter of this.waiters.splice(0)) waiter();
        return ok(response, { task_id: id, state: 'queued' });
      }
      case 'task-cancel': {
        const task = this.tasks.get(String(body.target));
        if (!task) return fail(response, 404, 'NOT_FOUND', 'Ardent task not found');
        if (!['completed', 'partial', 'failed', 'cancelled', 'unknown'].includes(task.state)) this.finish(task.id, { state: 'cancelled', error: 'Cancelled by the operator' });
        return ok(response, this.record(task));
      }
      case 'task-pause': case 'task-resume': {
        if (needs(2)) return;
        const task = this.tasks.get(String(body.target));
        if (!task) return fail(response, 404, 'NOT_FOUND', 'Ardent task not found');
        if (['completed', 'partial', 'failed', 'cancelled', 'unknown'].includes(task.state)) return fail(response, 409, 'CONFLICT', 'Ardent refused the request in the task\'s current state');
        this.event(task.id, action === 'task-pause' ? 'pause_requested' : 'resumed', { state: task.state });
        return ok(response, { task_id: task.id, state: task.state, admission: action === 'task-pause' ? 'paused' : 'open' });
      }
      case 'identity-save': case 'skill-set': {
        if (!this.allowAgentEdits) break;
        if (action === 'identity-save') {
          const current = this.identityOf(ref, String(body.target));
          if (input.revision !== current.revision) return fail(response, 409, 'CONFLICT', 'Ardent refused the request in the task\'s current state');
          const text = String(input.text);
          const next = { text, revision: createHash('sha256').update(text).digest('hex') };
          this.identities.set(`${ref}|${String(body.target)}`, next);
          return ok(response, { kind: body.target, name: 'x.md', ...next });
        }
        if (input.revision !== this.skillRevision) return fail(response, 409, 'CONFLICT', 'stale configuration revision');
        const skills = this.skillMap.get(ref) ?? [];
        this.skillMap.set(ref, skills.map(skill => skill.name === body.target ? { ...skill, enabled: Boolean(input.enabled) } : skill));
        this.skillRevision = createHash('sha256').update(`${this.skillRevision}:${String(body.target)}`).digest('hex');
        return ok(response, { revision: this.skillRevision, activation_required: true });
      }
      case 'development-note': {
        if (needs(2)) return;
        if (!actingSubject) return fail(response, 403, 'ACTING_SUBJECT_REQUIRED', 'needs a person');
        this.notes.push({ ref, body: input, actingSubject });
        return ok(response, { id: `dev_${randomUUID()}`, agent_ref: ref, kind: input.kind, title: input.title, body: input.body, author: input.author ?? 'operator',
          epistemic: 'operator_reported', before_sha256: null, after_sha256: null, sources: input.sources ?? [], created_at: new Date().toISOString() });
      }
      default: break;
    }
    return fail(response, 403, 'FORBIDDEN', `Action ${action} is not allowed for this identity`);
  }
}
