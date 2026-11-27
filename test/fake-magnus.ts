// A fake Magnus control API on loopback, for tests. It serves the Ardent routes ArdentStudio uses
// with synthetic data, and lets a test drive each Ardent task: journal events, live reply text
// and the final record, over a real HTTP server-sent event stream.
//
// Every request Studio sends and every answer and stream event the fake serves is checked against the
// published @hivemagnus/magnus-contracts schemas (see contractFor), so a test cannot pass on a shape real
// Magnus would refuse or never send. Violations are collected and fail the test in assertContract().
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ArdentFleetInstallationSchema } from '@hivemagnus/magnus-contracts';
import { agentDefinitionPreflightSchema, verifyAgentDefinition } from '@hivemagnus/magnus-contracts/agent-definition';
import {
  ardentArtifactRecordSchema, ardentArtifactRenditionsSchema, ardentConfigFileSchema, ardentConfigSavedSchema, ardentDevelopmentPageSchema,
  ardentDevelopmentRecordSchema, ardentIdentityFileSchema, ardentServiceRoutes, ardentServiceSessionSchema,
  ardentSkillInstallResultSchema, ardentTaskAdmissionSchema, ardentTaskArtifactsSchema, ardentTaskPauseStateSchema, ardentTaskRecoverySchema,
  ardentUnsupportedCapabilityDetailsSchema, type ArdentServiceRoute,
} from '@hivemagnus/magnus-contracts/ardent-service';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { changedConfigPaths, configuredSkills } from '../src/agents/config-edit.js';
import { ARDENT_SERVICE_CONFIG_PATHS, type MagnusArdentProfile } from '../src/clients/magnus.js';

export interface FakeTask {
  id: string; ref: string; context: 'direct' | 'mission' | 'preview'; session_id: string | null; prompt: string; body: Record<string, unknown>;
  idempotency_key: string; state: string; result: string | null; error: string | null;
  events: Array<{ sequence: number; task_id: string; kind: string; detail?: unknown; created_ms: number }>;
  live: { step: number; text: string } | undefined;
  /** Ardent 3.2.0 recovery (C3), when the task was interrupted. */
  recovery?: Record<string, unknown> | undefined;
  /** The task this one continues after a recovery decision. */
  continuation_of?: string | undefined;
}

/** Per-profile runtime levels a Magnus 3.3.0 node agent (studio 4) reports. */
export interface FakeRuntime { recovery: number; lineage: number; artifact_transfer: number; version?: string }

interface Subscriber { send: (event: string, data: unknown, id?: number) => void; end: () => void }

export function fakeProfile(nodeId: string, id: string, overrides: Partial<MagnusArdentProfile> = {}): MagnusArdentProfile {
  return {
    id, name: id, backend: 'llamacpp', apiPort: 8700, running: true, a2aEnabled: false, channels: {}, error: null,
    nodeId, nodeName: `Node ${nodeId}`, hostname: `${nodeId}.example.com`, installationVersion: '2.2.0', reachable: true, ...overrides,
  };
}

// ── The real contract ──

interface ServedContract { where: string; envelope?: z.ZodType | undefined; data?: z.ZodType | undefined; events?: Record<string, z.ZodType> | undefined }
/** The contract of the request each response answers, and where to report a violation. */
const served = new WeakMap<ServerResponse, ServedContract & { report: (message: string) => void }>();

// The catch-all resource route is matched last, so streams and artifact reads find their own routes.
const ROUTES = ardentServiceRoutes.map(route => ({
  route, pattern: new RegExp(`^/api/v1${route.path.replace(/\{resource\}/u, '(?<resource>.+)').replace(/\{[A-Za-z0-9]+\}/gu, '[^/]+')}$`, 'u'),
})).sort((left, right) => Number(left.route.path.includes('{resource}')) - Number(right.route.path.includes('{resource}')));
/** Resources whose answer the contract's route notes name a schema for (the others are Ardent's own responses, relayed). */
const RESOURCE_SCHEMAS: Array<[RegExp, z.ZodType]> = [
  [/^identity\/(?:soul|identity)$/u, ardentIdentityFileSchema],
  [/^config$/u, ardentConfigFileSchema],
  [/^tasks\/[^/]+\/artifacts$/u, ardentTaskArtifactsSchema],
  [/^artifacts\/[a-f0-9]{64}\/manifest$/u, ardentArtifactRecordSchema],
  [/^development$/u, ardentDevelopmentPageSchema],
  [/^tasks\/[^/]+\/recovery$/u, ardentTaskRecoverySchema],
  [/^artifacts\/[a-f0-9]{64}\/renditions$/u, ardentArtifactRenditionsSchema],
];
/** Action answers, as the action route's note names them. */
const ACTION_SCHEMAS: Record<string, z.ZodType> = {
  'session-open': ardentServiceSessionSchema, 'task-submit': ardentTaskAdmissionSchema, 'mission-submit': ardentTaskAdmissionSchema,
  'preview-submit': ardentTaskAdmissionSchema, 'task-pause': ardentTaskPauseStateSchema, 'task-resume': ardentTaskPauseStateSchema,
  'development-note': ardentDevelopmentRecordSchema, 'identity-save': ardentIdentityFileSchema, 'skill-set': ardentConfigSavedSchema,
  'config-save': ardentConfigSavedSchema, 'skill-install': ardentSkillInstallResultSchema, 'task-recovery': ardentTaskRecoverySchema,
};

/** The contract for a request, or why the request itself breaks it. */
export function contractFor(method: string, path: string, body: unknown): ServedContract & { requestError?: string } {
  const where = `${method} ${path}`;
  const match = ROUTES.find(item => item.route.method === method && item.pattern.test(path));
  // Studio calls only what a linked service identity may call; anything else answers 403 from real Magnus.
  if (!match) return { where, requestError: 'not a route of ardentServiceRoutes' };
  const route: ArdentServiceRoute = match.route;
  const contract: ServedContract & { requestError?: string } = { where, envelope: route.response ?? undefined, events: route.events };
  if (route.request) {
    const parsed = route.request.safeParse(body ?? {});
    if (!parsed.success) contract.requestError = z.prettifyError(parsed.error);
  }
  const resource = match.pattern.exec(path)?.groups?.resource;
  if (resource !== undefined) contract.data = RESOURCE_SCHEMAS.find(([pattern]) => pattern.test(resource))?.[1];
  if (route.path.endsWith('/action')) contract.data = ACTION_SCHEMAS[String((body as { action?: unknown } | undefined)?.action)];
  if (route.path === '/ardent/installations') contract.data = z.array(ArdentFleetInstallationSchema);
  if (route.path === '/ardent/installations/{nodeId}') contract.data = ArdentFleetInstallationSchema;
  return contract;
}

function check(response: ServerResponse, value: unknown, schema: z.ZodType | undefined, what: string): void {
  const contract = served.get(response);
  if (!contract || !schema) return;
  const parsed = schema.safeParse(value);
  if (!parsed.success) contract.report(`${contract.where} ${what}: ${z.prettifyError(parsed.error)}`);
}

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const ok = (response: ServerResponse, data: unknown, status = 200) => {
  const contract = served.get(response);
  check(response, { success: true, data }, contract?.envelope, 'answer');
  check(response, data, contract?.data, 'answer data');
  json(response, status, { success: true, data });
};
/** A server-sent event, checked against the route's event schema. */
const sse = (response: ServerResponse, event: string, data: unknown, id?: number) => {
  const events = served.get(response)?.events;
  if (events) check(response, data, events[event] ?? z.never(), `event ${event}`);
  response.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};
const fail = (response: ServerResponse, status: number, code: string, message: string, details?: unknown) => {
  if (code === 'unsupported_capability') check(response, details, ardentUnsupportedCapabilityDetailsSchema, 'unsupported_capability details');
  json(response, status, { success: false, error: { code, message, ...(details !== undefined ? { details } : {}) } });
};

export class FakeMagnusServer {
  profiles: MagnusArdentProfile[] = [fakeProfile('node1', 'lead'), fakeProfile('node1', 'scout'), fakeProfile('node2', 'mapper')];
  /** Node agent Studio level per node (default 2). */
  studio = new Map<string, number>();
  fail = false;
  /** Answer only the fleet profile list with 503. */
  failProfiles = false;
  memory = new Map<string, 'ready' | 'degraded'>();
  /**
   * The skill list as Ardent reports it: the running profile's state. skill-set and skill-install
   * change the saved configuration (skills.enabled) only; restart() loads it, as a profile restart does.
   */
  skillMap = new Map<string, Array<{ name: string; enabled: boolean }>>();
  calls: Array<{ method: string; path: string; actingSubject: string | undefined; body?: unknown; raw?: string | undefined; headers: IncomingMessage['headers']; at: number }> = [];
  /** Node agent lineage level per node (absent: the node reports none, as Magnus before 3.3.0). */
  lineage = new Map<string, number>();
  /** Per-profile runtime levels by agent ref (absent: the profile reports none, as node agents before studio 4). */
  runtime = new Map<string, FakeRuntime>();
  /** Renditions Ardent lists per artifact digest (the original first). */
  renditions = new Map<string, Array<Record<string, unknown>>>();
  /** Serve this many bytes of a content read, then hold the connection open (a transfer that stalls). */
  contentStall = new Map<string, number>();
  /** Ignore Range on content reads and always answer 200 with the whole artifact. */
  ignoreRanges = false;
  /** Decisions the task-recovery action received. */
  recoveryDecisions: Array<{ ref: string; target: string; body: Record<string, unknown> }> = [];
  /** Accept the submission but drop the connection before answering, the next n times (an answer lost in transit). */
  dropSubmitResponses = 0;
  /** Answer the next n submissions with 503 and this Retry-After (seconds). */
  retryAfterSubmissions: { count: number; seconds: number } = { count: 0, seconds: 0 };
  /** Submissions refused because their idempotency key was reused with different content, as Ardent does. */
  conflicts = 0;
  tasks = new Map<string, FakeTask>();
  sessions = new Map<string, { id: string; key: string; context: string }>();
  /** Answer task streams with 503 (the follower then polls). */
  failStreams = false;
  /** Answer journal pages with 502, as Magnus does for a page over its relay size limit. */
  failEvents = false;
  /** End each task stream after this long, as Ardent does after 60 s. */
  streamLimitMs = 60_000;
  /** Make the next n submissions fail with 503. */
  failSubmissions = 0;
  /** Refuse the next n submissions with 409 RESOURCE_LEASE_CONFLICT, as Magnus does while another command runs on the node. */
  leaseConflicts = 0;
  /** Refuse the next `count` submissions with this status and error code. */
  failSubmissionsWith: { status: number; code: string; count: number } = { status: 0, code: '', count: 0 };
  streamsOpened = 0;
  artifacts = new Map<string, { bytes: Uint8Array; mime: string }>();
  /** Serve these bytes instead of the stored ones (a corrupted relay). */
  artifactOverride = new Map<string, Uint8Array>();
  /** Real Magnus refuses identity-save and skill-set from a service identity; set true to model a Magnus that allows them. */
  /** False: a Magnus that predates service agent changes (403 FORBIDDEN for identity-save, skill-set, config-save, config). */
  allowAgentEdits = true;
  identities = new Map<string, { text: string; revision: string }>();
  configs = new Map<string, { text: string; revision: string }>();
  /** Subjects Magnus knows but has not linked to a Magnus user. */
  unlinked = new Set<string>();
  /** Answer config-save with 403 CONFIG_PATH_FORBIDDEN regardless of the change. */
  forbidConfig = false;
  development = new Map<string, Array<Record<string, unknown>>>();
  notes: Array<{ ref: string; body: Record<string, unknown>; actingSubject: string | undefined }> = [];
  /** HiveSkills releases Magnus can install, by `name@version`, with their digests; empty models a Magnus without a registry. */
  skillReleases = new Map<string, string>();
  /** False: a Magnus that predates skill-install (400 "Invalid Ardent action"). */
  allowSkillInstall = true;
  /** Oathweave subjects that are Magnus ADMINs. */
  admins = new Set(['subject-operator']);
  operations = new Map<string, Record<string, unknown>>();
  /**
   * Agent definitions (Magnus 3.3.0): `supported`, `missing` (a Magnus that does not know the routes: 404) or
   * `scoped` (a Magnus before 3.3.0, whose service scope refuses them: 403 FORBIDDEN).
   */
  definitions: 'supported' | 'missing' | 'scoped' = 'supported';
  /** Preflight problems reported for every definition, besides the missing required bindings. */
  definitionProblems: Array<{ code: string; detail: string }> = [];
  /** Nodes Magnus does not manage (404 "Managed node not found"). */
  unknownNodes = new Set<string>();
  /** Emberpath client keys Emberpath refuses (Magnus #164), with the refusal Magnus answers. */
  emberpathRefusals = new Map<string, { status: number; code: string; message: string }>();
  private readonly operationSubscribers = new Map<string, Set<Subscriber>>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly waiters: Array<() => void> = [];
  private server: Server | undefined;
  url = '';
  /** Requests and answers that break the published Magnus contract (see contractFor). */
  contractViolations: string[] = [];

  /** Throws when anything the fake received or served broke the published Magnus contract. */
  assertContract(): void {
    if (this.contractViolations.length) throw new Error(`Magnus contract violations:\n${[...new Set(this.contractViolations)].join('\n')}`);
  }

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
      for (const subscriber of this.subscribers.get(taskId) ?? []) { subscriber.send('task.done', this.doneRecord(task)); subscriber.end(); }
    }
  }

  /** Close every open stream of a task without a done event (a dropped connection). */
  dropStreams(taskId: string): void {
    for (const subscriber of this.subscribers.get(taskId) ?? []) subscriber.end();
  }

  openStreams(taskId: string): number {
    return this.subscribers.get(taskId)?.size ?? 0;
  }

  /** A profile on a Magnus 3.3.0 node agent with Ardent 3.2.0 runtime contracts. */
  enableRuntime(ref: string, levels: Partial<FakeRuntime> = {}): void {
    this.studio.set(ref.split('~')[0]!, 4);
    this.runtime.set(ref, { recovery: 1, lineage: 1, artifact_transfer: 2, version: '3.2.0', ...levels });
  }

  /**
   * Ardent restarted and holds the task for a decision: unknown with a recovery awaiting one, journaled
   * as recovery_held. The task.done record carries no recovery (Ardent's stream sends the stored row).
   */
  hold(taskId: string, recovery: Partial<Record<string, unknown>> = {}): void {
    const task = this.tasks.get(taskId)!;
    task.recovery = { status: 'awaiting_decision', reason: { code: 'UNSETTLED_EXTERNAL_WRITE', message: 'A write to an external system may or may not have been applied.' },
      attempt: 1, checkpoint: { step: 2, completed_calls: 1, pending_calls: [{ call_id: 'call_1', tool: 'http_post', effect: 'external_write', dispatched_at: new Date().toISOString(), reconcilable: false }] },
      actions: ['mark_applied', 'mark_not_applied', 'retry_with_new_deadline', 'abandon'], ...recovery };
    this.event(taskId, 'recovery_held', { status: task.recovery.status, reason: task.recovery.reason, attempt: 1 });
    this.finish(taskId, { state: 'unknown', error: 'Interrupted during execution: A write to an external system may or may not have been applied.' });
  }

  /** Ardent restarted and continues the task under the same id (recovery resumed). */
  resumeSameId(taskId: string): void {
    const task = this.tasks.get(taskId)!;
    task.recovery = { status: 'resumed', reason: { code: 'INTERRUPTED', message: 'Ardent restarted while the task ran.' }, attempt: 2, actions: [] };
    this.event(taskId, 'recovery_planned', { status: 'ready', attempt: 2 });
  }

  /** A decision made outside Studio (the Magnus console): the held task continues as a new task. */
  continueElsewhere(taskId: string, action = 'mark_not_applied'): FakeTask {
    return this.decide(this.tasks.get(taskId)!, { action })!;
  }

  private decide(task: FakeTask, body: Record<string, unknown>): FakeTask | undefined {
    const recovery = task.recovery!;
    const decided = { action: body.action, by: 'operator', at: new Date().toISOString(), ...(body.note ? { note: body.note } : {}) };
    if (body.action === 'abandon') {
      task.recovery = { ...recovery, status: 'resolved', actions: [], decided };
      this.event(task.id, 'recovery_decided', { action: body.action, continued: false });
      return undefined;
    }
    const id = randomUUID();
    const continuation: FakeTask = { ...task, id, idempotency_key: `recovery:${task.id}:2`, state: 'running', result: null, error: null, events: [], live: undefined,
      recovery: undefined, continuation_of: task.id };
    this.tasks.set(id, continuation);
    this.event(id, 'recovery_continuation_of', { task_id: task.id, attempt: 2, action: body.action });
    task.recovery = { ...recovery, status: 'resolved', actions: [], continuation_task_id: id, decided };
    this.event(task.id, 'recovery_continued', { continuation_task_id: id, attempt: 2, action: body.action });
    return continuation;
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

  configOf(ref: string): { text: string; revision: string } {
    let value = this.configs.get(ref);
    if (!value) {
      const text = [
        '# Ardent profile configuration',
        'execution:',
        '  backend: llamacpp # the model runtime',
        'providers:',
        '  llamacpp:',
        '    base_url: http://127.0.0.1:8080/v1',
        '    api_key_env: LLAMACPP_API_KEY',
        '    model: fixture-model',
        'skills:',
        '  enabled: [mapping]',
        '',
      ].join('\n');
      value = { text, revision: 'c'.repeat(64) };
      this.configs.set(ref, value);
    }
    return value;
  }

  /** The configuration with a skill switched in skills.enabled, keeping the given revision. */
  private switchSkill(ref: string, name: string, enabled: boolean, revision: string): void {
    const config = this.configOf(ref);
    const selected = new Set(configuredSkills(config.text));
    if (enabled) selected.add(name); else selected.delete(name);
    const document = parseDocument(config.text);
    document.setIn(['skills', 'enabled'], [...selected]);
    this.configs.set(ref, { text: String(document), revision });
  }

  /** A profile restart: the running skills follow the saved configuration. */
  restart(ref: string): void {
    const configured = new Set(configuredSkills(this.configOf(ref).text));
    this.skillMap.set(ref, (this.skillMap.get(ref) ?? []).map(skill => ({ ...skill, enabled: configured.has(skill.name) })));
  }

  /** The acting-ADMIN check Magnus runs for ARDENT_SERVICE_ADMIN_ACTIONS and the config read. Answers the refusal, or undefined. */
  private adminRefusal(actingSubject: string | undefined): [number, string, string] | undefined {
    if (!this.allowAgentEdits) return undefined;
    if (actingSubject && this.unlinked.has(actingSubject)) return [403, 'ACTING_SUBJECT_UNLINKED', 'The acting subject is not linked to a Magnus user'];
    if (!actingSubject || !this.admins.has(actingSubject)) return [403, 'ACTING_ADMIN_REQUIRED', 'The acting person is not a Magnus ADMIN'];
    return undefined;
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
      deadline_ms: 0, created_ms: 0, updated_ms: 0, ...(task.recovery ? { recovery: task.recovery } : {}) };
  }

  /** The task.done record: Ardent's stream sends the stored row, without the recovery view. */
  doneRecord(task: FakeTask) {
    const { recovery: _recovery, ...record } = this.record(task) as ReturnType<FakeMagnusServer['record']> & { recovery?: unknown };
    return record;
  }

  /** The runtime gate Magnus 3.3.0 applies to a route or action: the refusal, or undefined. */
  private runtimeRefusal(ref: string, name: keyof FakeRuntime, level: number): [number, string, string, unknown?] | undefined {
    if ((this.studio.get(ref.split('~')[0]!) ?? 2) < 4) return [409, 'AGENT_UPGRADE_REQUIRED', `Upgrade the Magnus agent on Node ${ref.split('~')[0]}`];
    const have = Number(this.runtime.get(ref)?.[name] ?? 0);
    if (have < level) {
      const capability = name === 'recovery' ? 'ardent.recovery.v1' : name === 'lineage' ? 'ardent.lineage.v1' : 'artifact-transfer.v2';
      return [409, 'unsupported_capability', `The profile does not support ${capability}`, { capability, required_version: '3.2.0', installed_version: this.runtime.get(ref)?.version ?? '3.1.4' }];
    }
    return undefined;
  }

  /** POST /ardent/agent-definitions/validate and …/install, as Magnus 3.3.0 answers them. */
  private async definition(response: ServerResponse, route: 'validate' | 'install', input: Record<string, unknown>, actingSubject: string | undefined): Promise<void> {
    if (this.definitions === 'scoped') return fail(response, 403, 'FORBIDDEN', 'ardent-service credential is endpoint-scoped');
    if (this.definitions === 'missing') return fail(response, 404, 'NOT_FOUND', 'No such route');
    if (!actingSubject || !this.admins.has(actingSubject)) return fail(response, 403, 'ACTING_ADMIN_REQUIRED', 'The acting person is not a Magnus ADMIN');
    const checked = await verifyAgentDefinition(input.definition);
    if (!checked.ok) return fail(response, 422, checked.code, checked.detail);
    const nodeId = String(input.nodeId);
    if (this.unknownNodes.has(nodeId)) return fail(response, 404, 'NOT_FOUND', 'Managed node not found');
    const bindings = (input.bindings ?? {}) as Record<string, string>;
    const problems = [...this.definitionProblems, ...checked.definition.requirements.bindings
      .filter(item => item.required && bindings[item.key] === undefined).map(item => ({ code: 'MISSING_BINDING', detail: `Bind ${item.key} (${item.kind})` }))];
    // Magnus #164: a llamacpp definition's model is an Emberpath alias, which needs the client key, checked with Emberpath.
    const key = input.emberpath_client_key as string | undefined;
    if (checked.definition.config.execution.backend === 'llamacpp') {
      const refused = key !== undefined ? this.emberpathRefusals.get(key) : undefined;
      if (key === undefined) problems.push({ code: 'SECRET_UNBOUND', detail: 'Emberpath key missing: give emberpath_client_key, the client key created in Emberpath' });
      else if (refused) problems.push(refused.code === 'EMBERPATH_ALIAS_UNAVAILABLE'
        ? { code: 'MISSING_BINDING', detail: `model: ${refused.message}` } : { code: 'SECRET_UNBOUND', detail: `emberpath_client_key: ${refused.message}` });
    }
    if (route === 'validate') return ok(response, { ok: problems.length === 0, problems });
    check(response, { problems }, agentDefinitionPreflightSchema.pick({ problems: true }), 'PREFLIGHT_FAILED details');
    if (problems.length) return fail(response, 409, 'PREFLIGHT_FAILED', `The definition cannot be installed on this node: ${problems.map(item => item.code).join(', ')}`, { problems });
    const id = randomUUID();
    const now = new Date().toISOString();
    const alias = bindings.model ?? checked.definition.config.model.emberpath_alias;
    this.operations.set(id, { id, kind: 'definition', nodeId, profile: input.name, status: 'running', error: null, createdBy: 'operator', attempts: 1,
      request: { apiPort: null, model: { emberpath_alias: alias }, skills: [], hivemem: true, artifacts_max_bytes: null,
        definition: { name: checked.definition.name, sha256: checked.definition.sha256 } },
      createdAt: now, updatedAt: now, completedAt: null,
      steps: [{ name: 'profile-create', status: 'running', startedAt: now, finishedAt: null, receipt: null, error: null }] });
    return ok(response, { operationId: id }, 202);
  }

  // ── HTTP ──

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fake');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
    const body = raw !== undefined ? JSON.parse(raw) as Record<string, unknown> : undefined;
    const actingSubject = request.headers['x-acting-subject'] as string | undefined;
    this.calls.push({ method: request.method ?? 'GET', path: url.pathname, actingSubject, headers: request.headers, at: Date.now(), ...(body !== undefined ? { body, raw } : {}) });
    const contract = contractFor(request.method ?? 'GET', url.pathname, body);
    if (contract.requestError) this.contractViolations.push(`${contract.where} request: ${contract.requestError}`);
    served.set(response, { ...contract, report: message => this.contractViolations.push(message) });
    if (request.headers.authorization !== 'Bearer fixture-service-token') return fail(response, 401, 'UNAUTHENTICATED', 'bad token');
    const path = url.pathname;
    if (this.fail) return fail(response, 503, 'DEPENDENCY_UNAVAILABLE', 'Magnus unavailable');

    if (request.method === 'GET' && path === '/api/v1/ardent/profiles') return this.failProfiles ? fail(response, 503, 'DEPENDENCY_UNAVAILABLE', 'Fleet inventory unavailable') : ok(response, this.profiles);
    if (request.method === 'POST' && path === '/api/v1/ardent/agents') {
      if (!actingSubject || !this.admins.has(actingSubject)) return fail(response, 403, 'ACTING_ADMIN_REQUIRED', 'The acting person is not a Magnus ADMIN');
      const input = body as Record<string, unknown>;
      if (this.profiles.some(item => item.nodeId === input.nodeId && item.id === input.profile)) return fail(response, 409, 'CONFLICT', 'The profile exists');
      // Magnus #164: an Emberpath alias needs the client key, which Emberpath may refuse.
      const key = input.emberpath_client_key as string | undefined;
      if ((input.model as { emberpath_alias?: unknown } | undefined)?.emberpath_alias !== undefined) {
        if (key === undefined) return fail(response, 400, 'EMBERPATH_KEY_REQUIRED', 'Emberpath key missing: give emberpath_client_key, the client key created in Emberpath');
        const refused = this.emberpathRefusals.get(key);
        if (refused) return fail(response, refused.status, refused.code, refused.message);
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      this.operations.set(id, { id, kind: 'deploy', nodeId: input.nodeId, profile: input.profile, status: 'running', error: null, createdBy: 'operator', attempts: 1,
        request: { apiPort: null, model: input.model, skills: input.skills, hivemem: true, artifacts_max_bytes: null }, createdAt: now, updatedAt: now, completedAt: null,
        steps: [{ name: 'profile-create', status: 'running', startedAt: now, finishedAt: null, receipt: null, error: null }] });
      return ok(response, { operationId: id }, 202);
    }
    const definitionRoute = /^\/api\/v1\/ardent\/agent-definitions\/(validate|install)$/.exec(path);
    if (request.method === 'POST' && definitionRoute) return await this.definition(response, definitionRoute[1] as 'validate' | 'install', body ?? {}, actingSubject);
    const operation = /^\/api\/v1\/ardent\/agents\/operations\/([^/]+)(\/stream)?$/.exec(path);
    if (request.method === 'GET' && operation) {
      const current = this.operations.get(operation[1]!);
      if (!current) return fail(response, 404, 'NOT_FOUND', 'Unknown operation');
      if (!operation[2]) return ok(response, current);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event: string, data: unknown) => sse(response, event, data);
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
      const profiles = this.profiles.filter(item => item.nodeId === nodeId).map(item => {
        const runtime = this.runtime.get(`${nodeId}~${item.id}`);
        return runtime ? { ...item, version: runtime.version ?? '3.2.0', capabilities: { recovery: runtime.recovery, lineage: runtime.lineage, artifact_transfer: runtime.artifact_transfer } } : item;
      });
      return ok(response, { installed: true, version: profiles[0]?.installationVersion ?? '2.2.0', owner: 'operator', profiles, checkedAt: new Date().toISOString(),
        nodeId, nodeName: `Node ${nodeId}`, hostname: `${nodeId}.example.com`, reachable: true, error: null,
        capabilities: { studio: this.studio.get(nodeId) ?? 2, ...(this.lineage.has(nodeId) ? { lineage: this.lineage.get(nodeId) } : {}) } });
    }
    match = /^\/api\/v1\/ardent\/installations\/([^/]+)\/profiles\/([^/]+)\/(.+)$/.exec(path);
    if (!match) return fail(response, 404, 'NOT_FOUND', 'No such route');
    const [, nodeId, profile, rest] = match as unknown as [string, string, string, string];
    const ref = `${nodeId}~${profile}`;
    const level = this.studio.get(nodeId) ?? 2;
    if (request.method === 'POST' && rest === 'action') return this.action(response, ref, level, body ?? {}, actingSubject, (this.lineage.get(nodeId) ?? 0) >= 1);
    if (request.method !== 'GET') return fail(response, 404, 'NOT_FOUND', 'No such route');
    if (rest === 'memory/status') return ok(response, { status: this.memory.get(ref) ?? 'ready', agent_id: ref, workspace_id: 'default', retrieval: null, storage: null, reason: null });
    if (rest === 'skills') return ok(response, { skills: this.skillMap.get(ref) ?? [] });
    if (rest === 'status') return ok(response, { version: '2.2.0', profile, backend: 'llamacpp', tasks: this.tasks.size });
    if (rest === 'config') {
      if (!this.allowAgentEdits) return fail(response, 403, 'FORBIDDEN', 'Resource config is not allowed for this identity');
      const refusal = this.adminRefusal(actingSubject);
      if (refusal) return fail(response, ...refusal);
      return ok(response, this.configOf(ref));
    }
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
    match = /^artifacts\/([a-f0-9]{64})\/(content|renditions)$/.exec(rest);
    if (match) {
      const refusal = this.runtimeRefusal(ref, 'artifact_transfer', 2);
      if (refusal) return fail(response, refusal[0], refusal[1], refusal[2], refusal[3]);
      const artifact = this.artifacts.get(match[1]!);
      if (!artifact) return fail(response, 404, 'NOT_FOUND', 'Ardent resource not found');
      if (match[2] === 'renditions') return ok(response, { renditions: this.renditions.get(match[1]!) ?? [{ sha256: match[1], role: 'original', mime: artifact.mime, size: artifact.bytes.byteLength, purpose: 'download' }] });
      return this.content(request, response, match[1]!, this.artifactOverride.get(match[1]!) ?? artifact.bytes, artifact.mime);
    }
    match = /^tasks\/([0-9a-f-]{36})\/(recovery|lineage)$/.exec(rest);
    if (match) {
      const refusal = this.runtimeRefusal(ref, match[2] === 'recovery' ? 'recovery' : 'lineage', 1);
      if (refusal) return fail(response, refusal[0], refusal[1], refusal[2], refusal[3]);
      const task = this.tasks.get(match[1]!);
      if (!task) return fail(response, 404, 'NOT_FOUND', 'Ardent task not found');
      if (match[2] === 'recovery') return task.recovery ? ok(response, task.recovery) : fail(response, 404, 'NOT_FOUND', 'Task was never interrupted; it has no recovery');
      const continuations = [...this.tasks.values()].filter(item => item.continuation_of === task.id)
        .map(item => ({ ref: `hx1:ardent:${ref.replace('~', '.')}:task:${item.id}`, local_task_id: item.id, source: 'continuation', created_ms: 1 }));
      return ok(response, { task_id: task.id, source: task.continuation_of ? 'continuation' : 'management', children: [], continuations,
        model_attempts: [{ step: 1, attempt: 1, backend: 'llamacpp', request_id: `req-${task.id.slice(0, 8)}`, ref: null, started_ms: 1, usage: null }],
        tools: [], artifacts: [], ...(task.continuation_of ? { parent: { ref: `hx1:ardent:${ref.replace('~', '.')}:task:${task.continuation_of}`, local_task_id: task.continuation_of } } : {}) });
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
      if (match[2] === '/events') return this.failEvents ? fail(response, 502, 'DEPENDENCY_UNAVAILABLE', 'Ardent management response exceeds size limit')
        : ok(response, { events: task.events.filter(event => event.sequence > after) });
      return this.stream(request, response, task, after);
    }
    return fail(response, 404, 'NOT_FOUND', 'No such resource');
  }

  /** Artifact transfer v2 content: Range and If-Range, ETag, Repr-Digest and X-Content-SHA256, as Magnus 3.3.0 relays them. */
  private content(request: IncomingMessage, response: ServerResponse, sha256: string, bytes: Uint8Array, mime: string): void {
    const size = bytes.byteLength;
    const etag = `"${sha256}"`;
    const headers: Record<string, string> = { 'content-type': mime, 'accept-ranges': 'bytes', etag, 'x-content-sha256': sha256,
      'repr-digest': `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`, 'content-disposition': 'attachment; filename="artifact"' };
    const range = /^bytes=(\d+)-$/.exec(String(request.headers.range ?? ''));
    const ifRange = request.headers['if-range'];
    let start = 0;
    let status = 200;
    if (range && !this.ignoreRanges && (ifRange === undefined || ifRange === etag)) {
      start = Number(range[1]);
      if (start >= size) {
        response.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: false, error: { code: 'RANGE_NOT_SATISFIABLE', message: 'Range not satisfiable' } }));
        return;
      }
      status = 206;
      headers['content-range'] = `bytes ${start}-${size - 1}/${size}`;
    }
    headers['content-length'] = String(size - start);
    response.writeHead(status, headers);
    const stall = this.contentStall.get(sha256);
    if (stall !== undefined && start < stall) {
      // Send up to the stall point, then hold the connection until the client goes away.
      response.write(Buffer.from(bytes.subarray(start, stall)));
      return;
    }
    response.end(Buffer.from(bytes.subarray(start)));
  }

  private stream(request: IncomingMessage, response: ServerResponse, task: FakeTask, after: number): void {
    if (this.failStreams) return fail(response, 503, 'DEPENDENCY_UNAVAILABLE', 'Ardent stream unavailable');
    this.streamsOpened++;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const send = (event: string, data: unknown, id?: number) => sse(response, event, data, id);
    let set = this.subscribers.get(task.id);
    if (!set) { set = new Set(); this.subscribers.set(task.id, set); }
    const subscriber: Subscriber = { send, end: () => { set.delete(subscriber); clearTimeout(limit); response.end(); } };
    const limit = setTimeout(() => subscriber.end(), this.streamLimitMs);
    request.on('close', () => { set.delete(subscriber); clearTimeout(limit); });
    if (task.live) send('task.text', task.live);
    for (const event of task.events.filter(item => item.sequence > after)) send('task.event', event, event.sequence);
    if (['completed', 'partial', 'failed', 'cancelled', 'unknown'].includes(task.state)) { send('task.done', this.doneRecord(task)); subscriber.end(); return; }
    set.add(subscriber);
  }

  private action(response: ServerResponse, ref: string, level: number, body: Record<string, unknown>, actingSubject: string | undefined, lineage = false): void {
    const action = String(body.action);
    const input = (body.body ?? {}) as Record<string, unknown>;
    // Magnus's action request schemas are strict: before lineage (3.3.0) an `execution` field is refused.
    const allowed = new Set(['action', 'target', 'body', ...(lineage && (action === 'task-submit' || action === 'mission-submit') ? ['execution'] : [])]);
    const unknown = Object.keys(body).filter(key => !allowed.has(key));
    if (unknown.length) return fail(response, 400, 'VALIDATION_ERROR', `Unrecognized key: "${unknown[0]}"`);
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
        if (this.failSubmissionsWith.count > 0) { this.failSubmissionsWith.count--; return fail(response, this.failSubmissionsWith.status, this.failSubmissionsWith.code, 'Refused'); }
        if (this.leaseConflicts > 0) { this.leaseConflicts--; return fail(response, 409, 'RESOURCE_LEASE_CONFLICT', 'session-open on sage (command native-0000) is still running on this node; try again when it finishes'); }
        if (this.retryAfterSubmissions.count > 0) {
          this.retryAfterSubmissions.count--;
          response.writeHead(503, { 'content-type': 'application/json', 'retry-after': String(this.retryAfterSubmissions.seconds) });
          response.end(JSON.stringify({ success: false, error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Ardent node busy' } }));
          return;
        }
        const key = String(input.idempotency_key ?? randomUUID());
        const existing = [...this.tasks.values()].find(item => item.ref === ref && item.idempotency_key === key);
        // Ardent hashes the task content into its idempotency check: the same key with other content is a conflict.
        if (existing && JSON.stringify(existing.body) !== JSON.stringify(input)) {
          this.conflicts++;
          return fail(response, 409, 'CONFLICT', 'Idempotency key reused with different task content');
        }
        if (existing) return ok(response, { task_id: existing.id, state: existing.state });
        const id = randomUUID();
        const task: FakeTask = { id, ref, context: action === 'mission-submit' ? 'mission' : action === 'preview-submit' ? 'preview' : 'direct',
          session_id: (input.session_id as string | undefined) ?? null, prompt: String(input.prompt ?? input.objective ?? ''), body: input, idempotency_key: key,
          state: 'queued', result: null, error: null, events: [], live: undefined };
        this.tasks.set(id, task);
        for (const waiter of this.waiters.splice(0)) waiter();
        if (this.dropSubmitResponses > 0) { this.dropSubmitResponses--; response.socket?.destroy(); return; }
        return ok(response, { task_id: id, state: 'queued' });
      }
      case 'task-cancel': {
        const task = this.tasks.get(String(body.target));
        if (!task) return fail(response, 404, 'NOT_FOUND', 'Ardent task not found');
        if (!['completed', 'partial', 'failed', 'cancelled', 'unknown'].includes(task.state)) this.finish(task.id, { state: 'cancelled', error: 'Cancelled by the operator' });
        return ok(response, this.record(task));
      }
      case 'task-recovery': {
        const refusal = this.runtimeRefusal(ref, 'recovery', 1);
        if (refusal) return fail(response, refusal[0], refusal[1], refusal[2], refusal[3]);
        const task = this.tasks.get(String(body.target));
        if (!task) return fail(response, 404, 'NOT_FOUND', 'Ardent task not found');
        this.recoveryDecisions.push({ ref, target: String(body.target), body: input });
        const recovery = task.recovery;
        if (!recovery) return fail(response, 409, 'CONFLICT', 'Task has no recovery to decide');
        const decided = recovery.decided as { action?: string } | undefined;
        if (recovery.status === 'resolved' && decided) {
          if (decided.action !== input.action) return fail(response, 409, 'CONFLICT', `Recovery was already decided: ${decided.action}`);
          return ok(response, recovery);
        }
        if (recovery.status !== 'awaiting_decision') return fail(response, 409, 'CONFLICT', `Recovery is ${String(recovery.status)}; no decision is valid`);
        if (!(recovery.actions as string[]).includes(String(input.action))) return fail(response, 409, 'CONFLICT', `${String(input.action)} is not valid now`);
        this.decide(task, input);
        return ok(response, task.recovery);
      }
      case 'task-pause': case 'task-resume': {
        if (needs(2)) return;
        const task = this.tasks.get(String(body.target));
        if (!task) return fail(response, 404, 'NOT_FOUND', 'Ardent task not found');
        if (['completed', 'partial', 'failed', 'cancelled', 'unknown'].includes(task.state)) return fail(response, 409, 'CONFLICT', 'Ardent refused the request in the task\'s current state');
        this.event(task.id, action === 'task-pause' ? 'pause_requested' : 'resumed', { state: task.state });
        return ok(response, { task_id: task.id, state: task.state, admission: action === 'task-pause' ? 'paused' : 'open' });
      }
      case 'identity-save': case 'skill-set': case 'config-save': {
        if (!this.allowAgentEdits) break;
        const refusal = this.adminRefusal(actingSubject);
        if (refusal) return fail(response, ...refusal);
        if (action === 'identity-save') {
          if (typeof input.text !== 'string' || !input.text || input.text.length > 128 * 1024) return fail(response, 400, 'VALIDATION_ERROR', 'text must be 1 to 131072 characters');
          const current = this.identityOf(ref, String(body.target));
          if (input.revision !== current.revision) return fail(response, 409, 'CONFLICT', 'Ardent refused the request in the task\'s current state');
          const text = input.text;
          const next = { text, revision: createHash('sha256').update(text).digest('hex') };
          this.identities.set(`${ref}|${String(body.target)}`, next);
          return ok(response, { kind: body.target, name: 'x.md', ...next });
        }
        const config = this.configOf(ref);
        if (input.revision !== config.revision) return fail(response, 409, 'CONFLICT', 'stale configuration revision');
        if (action === 'skill-set') {
          if (!(this.skillMap.get(ref) ?? []).some(skill => skill.name === body.target)) return fail(response, 404, 'NOT_FOUND', 'Skill not found');
          const revision = createHash('sha256').update(`${config.revision}:${String(body.target)}`).digest('hex');
          this.switchSkill(ref, String(body.target), Boolean(input.enabled), revision);
          return ok(response, { revision, activation_required: true });
        }
        if (typeof input.text !== 'string' || !input.text) return fail(response, 400, 'VALIDATION_ERROR', 'text is required');
        const outside = changedConfigPaths(config.text, input.text).filter(path => !(ARDENT_SERVICE_CONFIG_PATHS as readonly string[]).includes(path));
        if (this.forbidConfig || outside.length) return fail(response, 403, 'CONFIG_PATH_FORBIDDEN', `A service may not change ${outside.join(', ') || 'this value'}`);
        const revision = createHash('sha256').update(input.text).digest('hex');
        this.configs.set(ref, { text: input.text, revision });
        return ok(response, { revision, activation_required: true });
      }
      case 'skill-install': {
        if (!this.allowSkillInstall) return fail(response, 400, 'VALIDATION_ERROR', 'Invalid Ardent action');
        const refusal = this.adminRefusal(actingSubject);
        if (refusal) return fail(response, ...refusal);
        if (needs(3)) return;
        if (!this.skillReleases.size) return fail(response, 503, 'HIVESKILLS_UNCONFIGURED', 'Magnus has no HiveSkills registry; set MAGNUS_ARDENT_HIVESKILLS_URL');
        const name = String(input.name);
        const sha256 = this.skillReleases.get(`${name}@${String(input.version)}`);
        if (!sha256) return fail(response, 409, 'SKILL_VERSION_UNAVAILABLE', `${name} ${String(input.version)} is not the release promoted on the stable channel`);
        const skills = this.skillMap.get(ref) ?? [];
        const running = skills.find(skill => skill.name === name)?.enabled ?? false;
        let enabled = configuredSkills(this.configOf(ref).text).includes(name);
        let revision: string | null = null;
        let enableError: string | null = null;
        if (input.enable && !enabled) {
          const config = this.configOf(ref);
          if (input.revision !== config.revision) enableError = 'The Ardent configuration changed since it was read; enable the skill from the list';
          else {
            revision = createHash('sha256').update(`${config.revision}:${name}`).digest('hex');
            this.switchSkill(ref, name, true, revision);
            enabled = true;
          }
        }
        // The skill directory is listed live; whether it runs waits for a restart.
        this.skillMap.set(ref, [...skills.filter(skill => skill.name !== name), { name, enabled: running }]);
        return ok(response, { source: 'hiveskills', name, version: input.version, sha256, files: 2, changed: true, enabled, revision,
          enable_error: enableError, activation_required: true });
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
