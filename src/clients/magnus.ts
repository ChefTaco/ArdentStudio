// Magnus is the only way ArdentStudio reaches an agent. It calls the Magnus control API
// with its own Oathweave service identity (audience `magnus`) and, for work a person asked
// for, forwards that person's Oathweave subject in x-acting-subject so Magnus can check
// and audit both. ArdentStudio never talks to nodes or Ardent directly and holds no Ardent token.
//
// Methods marked PLANNED call routes from the Ardent Project Studio plan (§5.3) that released
// Magnus does not serve yet; until it does they fail with MagnusError (usually 400 or 404).
import { z } from 'zod';
import { parseSse, type SseMessage } from './sse.js';
import type { ServiceTokenProvider } from './service-token.js';
import { trimTrailingSlashes } from '../url.js';

export const ACTING_SUBJECT_HEADER = 'x-acting-subject';

export class MagnusError extends Error {
  override name = 'MagnusError';
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

export interface AgentRefParts { nodeId: string; profile: string }
const REF_PART = /^[A-Za-z0-9._-]{1,128}$/;

export function parseAgentRef(ref: string): AgentRefParts {
  const [nodeId, profile, extra] = ref.split('~');
  if (extra !== undefined || !nodeId || !profile || !REF_PART.test(nodeId) || !REF_PART.test(profile)) throw new MagnusError('Invalid agent reference', 400, 'INVALID_AGENT_REF');
  return { nodeId, profile };
}
export function agentRef(nodeId: string, profile: string): string {
  return `${nodeId}~${profile}`;
}

export interface CallContext {
  /** The Oathweave subject of the person this call acts for. Omit for Studio's own background work. */
  actingSubject?: string | undefined;
  signal?: AbortSignal | undefined;
}

// ── Shapes of the released Magnus routes (packages/contracts ardent.ts, routes/ardent.ts) ──
export const magnusArdentProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  backend: z.enum(['llamacpp', 'codex']).nullable(),
  apiPort: z.number().int().nullable(),
  running: z.boolean(),
  a2aEnabled: z.boolean(),
  channels: z.record(z.string(), z.boolean()),
  error: z.string().nullable(),
  nodeId: z.string(),
  nodeName: z.string(),
  hostname: z.string(),
  installationVersion: z.string().nullable(),
  reachable: z.boolean(),
});
export type MagnusArdentProfile = z.infer<typeof magnusArdentProfileSchema>;

export const magnusArdentInstallationSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  owner: z.string(),
  profiles: z.array(magnusArdentProfileSchema.pick({ id: true, name: true, backend: true, apiPort: true, running: true, a2aEnabled: true, channels: true, error: true })),
  checkedAt: z.string(),
  nodeId: z.string(),
  nodeName: z.string(),
  hostname: z.string(),
  reachable: z.boolean(),
  error: z.string().nullable(),
});
export type MagnusArdentInstallation = z.infer<typeof magnusArdentInstallationSchema>;

// Ardent management shapes, as Ardent's OpenAPI document defines them.
export const ardentTaskStateSchema = z.enum(['queued', 'running', 'input_required', 'completed', 'partial', 'failed', 'cancelled', 'unknown']);
export const ardentTaskSchema = z.object({
  id: z.string(), caller: z.string(), context: z.string(), session_id: z.string().nullable(), prompt: z.string(), content_hash: z.string(),
  idempotency_key: z.string().nullable(), backend: z.string(), state: ardentTaskStateSchema, result: z.string().nullable(), error: z.string().nullable(),
  deadline_ms: z.number(), created_ms: z.number(), updated_ms: z.number(),
});
export const ardentTaskEventSchema = z.object({ sequence: z.number().int(), task_id: z.string(), kind: z.string(), detail: z.unknown().optional(), created_ms: z.number() });
export const ardentStatusSchema = z.object({ version: z.string(), profile: z.string(), backend: z.string(), tasks: z.number().int() });
export const ardentMemoryStatusSchema = z.object({
  status: z.enum(['ready', 'degraded']), agent_id: z.string(), workspace_id: z.string(),
  retrieval: z.string().nullable(), storage: z.string().nullable(), reason: z.string().nullable(),
});
export const ardentSkillSchema = z.object({ name: z.string(), enabled: z.boolean() }).loose();
export const ardentAcceptedTaskSchema = z.object({ task_id: z.string(), state: ardentTaskStateSchema });

/** Profile resources released Magnus lets a caller read (routes/ardent.ts allow-list). */
export type ArdentResource =
  | 'openapi' | 'status' | 'profile' | 'config' | 'config/schema' | 'providers' | 'channels' | 'peers' | 'peers/config'
  | 'memory/status' | 'skills' | 'sessions' | 'tasks' | `tasks/${string}` | `tasks/${string}/events` | `sessions/${string}/messages`
  | 'identity/soul' | 'identity/identity' | 'identity/soul/history' | 'identity/identity/history';

/** Actions released Magnus accepts on POST …/action. */
export const RELEASED_ACTIONS = ['profile-create', 'config-validate', 'config-save', 'peer-validate', 'peer-save', 'identity-save', 'identity-restore',
  'provider-test', 'channel-test', 'peer-test', 'memory-search', 'task-submit', 'task-cancel', 'skill-set', 'service-start', 'service-stop',
  'service-restart', 'package-install', 'context-stage', 'context-adopt', 'context-rollback'] as const;
/** PLANNED actions (§5.3). */
export const PLANNED_ACTIONS = ['session-open', 'mission-submit', 'task-pause', 'task-resume', 'preview-submit', 'development-note'] as const;
export type MagnusArdentAction = typeof RELEASED_ACTIONS[number] | typeof PLANNED_ACTIONS[number];

/** PLANNED New Agent request (§5.3, POST /api/v1/ardent/agents). Templates never carry secrets. */
export interface NewAgentRequest {
  nodeId: string;
  profile: string;
  apiPort?: number;
  soul_md: string;
  identity_md: string;
  model: { emberpath_alias: string } | { base_url: string; model: string };
  skills: string[];
  hivemem: true;
  artifacts_max_bytes?: number;
}
export const agentOperationSchema = z.object({
  operationId: z.string(),
  state: z.enum(['running', 'succeeded', 'failed']),
  steps: z.array(z.object({ name: z.string(), state: z.string(), detail: z.string().nullable().optional(), at: z.string().optional() }).loose()),
}).loose();

export interface MagnusClientOptions {
  baseUrl: string;
  tokens: Pick<ServiceTokenProvider, 'token' | 'invalidate'>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const envelope = z.object({ success: z.literal(true), data: z.unknown() });
const failure = z.object({ success: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) });

export class MagnusClient {
  private readonly request: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: MagnusClientOptions) {
    this.request = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = trimTrailingSlashes(options.baseUrl);
  }

  // ── Released routes ──

  /** Every Magnus-managed Ardent profile across the fleet. */
  async listProfiles(context: CallContext = {}): Promise<MagnusArdentProfile[]> {
    return z.array(magnusArdentProfileSchema).parse(await this.json('GET', '/api/v1/ardent/profiles', context));
  }

  async listInstallations(context: CallContext = {}): Promise<MagnusArdentInstallation[]> {
    return z.array(magnusArdentInstallationSchema).parse(await this.json('GET', '/api/v1/ardent/installations', context));
  }

  async getInstallation(nodeId: string, context: CallContext = {}): Promise<MagnusArdentInstallation> {
    if (!REF_PART.test(nodeId)) throw new MagnusError('Invalid node ID', 400, 'INVALID_AGENT_REF');
    return magnusArdentInstallationSchema.parse(await this.json('GET', `/api/v1/ardent/installations/${nodeId}`, context));
  }

  /** Read an allow-listed Ardent management resource through Magnus. */
  async resource(ref: string, resource: ArdentResource, context: CallContext & { query?: { after?: number; limit?: number } } = {}): Promise<unknown> {
    const { nodeId, profile } = parseAgentRef(ref);
    const query = new URLSearchParams();
    if (context.query?.after !== undefined) query.set('after', String(context.query.after));
    if (context.query?.limit !== undefined) query.set('limit', String(context.query.limit));
    const suffix = query.size ? `?${query}` : '';
    return this.json('GET', `/api/v1/ardent/installations/${nodeId}/profiles/${profile}/${resource}${suffix}`, context);
  }

  async status(ref: string, context: CallContext = {}) { return ardentStatusSchema.parse(await this.resource(ref, 'status', context)); }
  async memoryStatus(ref: string, context: CallContext = {}) { return ardentMemoryStatusSchema.parse(await this.resource(ref, 'memory/status', context)); }
  async task(ref: string, taskId: string, context: CallContext = {}) { return ardentTaskSchema.parse(await this.resource(ref, `tasks/${uuid(taskId)}`, context)); }

  async skills(ref: string, context: CallContext = {}): Promise<Array<z.infer<typeof ardentSkillSchema>>> {
    const data = await this.resource(ref, 'skills', context);
    const list = z.union([z.array(ardentSkillSchema), z.object({ skills: z.array(ardentSkillSchema) }).loose()]).parse(data);
    return Array.isArray(list) ? list : list.skills;
  }

  async taskEvents(ref: string, taskId: string, after = 0, context: CallContext = {}) {
    return z.object({ events: z.array(ardentTaskEventSchema) }).parse(await this.resource(ref, `tasks/${uuid(taskId)}/events`, { ...context, query: { after } })).events;
  }

  async identity(ref: string, kind: 'soul' | 'identity', context: CallContext = {}): Promise<unknown> {
    return this.resource(ref, `identity/${kind}`, context);
  }

  /** Artifact bytes (Magnus caps them; see MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES). */
  async artifact(ref: string, sha256: string, context: CallContext = {}): Promise<Uint8Array> {
    const { nodeId, profile } = parseAgentRef(ref);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new MagnusError('Invalid artifact ID', 400, 'VALIDATION_ERROR');
    const response = await this.send('GET', `/api/v1/ardent/installations/${nodeId}/profiles/${profile}/artifacts/${sha256}`, context);
    if (!response.ok) await this.fail(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Run a management action through Magnus's audited action route. */
  async action(ref: string, action: MagnusArdentAction, input: { target?: string; body?: unknown } = {}, context: CallContext = {}): Promise<unknown> {
    const { nodeId, profile } = parseAgentRef(ref);
    const payload: Record<string, unknown> = { action };
    if (input.target !== undefined) payload.target = input.target;
    if (input.body !== undefined) payload.body = input.body;
    return this.json('POST', `/api/v1/ardent/installations/${nodeId}/profiles/${profile}/action`, context, payload);
  }

  /** Released Magnus bounds task prompts to 4000 characters and requires a UUID idempotency key. */
  async submitTask(ref: string, body: { prompt: string; idempotency_key: string }, context: CallContext = {}) {
    if (!body.prompt.trim() || body.prompt.length > 4000) throw new MagnusError('Task prompt must be 1 to 4000 characters', 400, 'VALIDATION_ERROR');
    return ardentAcceptedTaskSchema.parse(await this.action(ref, 'task-submit', { body: { prompt: body.prompt, idempotency_key: uuid(body.idempotency_key) } }, context));
  }

  async cancelTask(ref: string, taskId: string, context: CallContext = {}): Promise<unknown> {
    return this.action(ref, 'task-cancel', { target: uuid(taskId) }, context);
  }

  async memorySearch(ref: string, query: string, context: CallContext = {}): Promise<unknown> {
    return this.action(ref, 'memory-search', { body: { query } }, context);
  }

  /** Ardent rejects a stale revision with 409, so concurrent edits never overwrite each other. */
  async saveIdentity(ref: string, kind: 'soul' | 'identity', body: { text: string; revision: string }, context: CallContext = {}): Promise<unknown> {
    return this.action(ref, 'identity-save', { target: kind, body }, context);
  }

  async setSkill(ref: string, name: string, body: { enabled: boolean; revision: string }, context: CallContext = {}): Promise<unknown> {
    return this.action(ref, 'skill-set', { target: name, body }, context);
  }

  // ── PLANNED routes (§5.3) ──

  /** PLANNED: open an Ardent session for a project conversation and role (action session-open). */
  async openSession(ref: string, body: { key: string; title?: string }, context: CallContext = {}): Promise<unknown> {
    return this.action(ref, 'session-open', { body }, context);
  }

  /** PLANNED: submit a team mission (action mission-submit, ≤200 KB). */
  async submitMission(ref: string, body: { session_id?: string; objective: string; mission: unknown; context_items?: unknown[]; labels?: Record<string, string>; idempotency_key: string }, context: CallContext = {}) {
    return ardentAcceptedTaskSchema.parse(await this.action(ref, 'mission-submit', { body }, context));
  }

  /** PLANNED: pause at the next step boundary (action task-pause). */
  async pauseTask(ref: string, taskId: string, context: CallContext = {}): Promise<unknown> {
    return this.action(ref, 'task-pause', { target: uuid(taskId) }, context);
  }

  /** PLANNED: resume a paused task (action task-resume). */
  async resumeTask(ref: string, taskId: string, context: CallContext = {}): Promise<unknown> {
    return this.action(ref, 'task-resume', { target: uuid(taskId) }, context);
  }

  /** PLANNED: a side-effect-free preview task with draft overrides (action preview-submit). */
  async submitPreview(ref: string, body: { prompt: string; overrides: { soul?: string; identity?: string; skills_enabled?: string[]; model?: string }; idempotency_key: string }, context: CallContext = {}) {
    return ardentAcceptedTaskSchema.parse(await this.action(ref, 'preview-submit', { body }, context));
  }

  /** PLANNED: record a development note (action development-note). */
  async addDevelopmentNote(ref: string, body: { kind: string; title: string; body: string; sources?: unknown[] }, context: CallContext = {}): Promise<unknown> {
    return this.action(ref, 'development-note', { body }, context);
  }

  /** PLANNED: artifact manifests a task registered (resource tasks/:id/artifacts). */
  async taskArtifacts(ref: string, taskId: string, context: CallContext = {}): Promise<unknown> {
    return this.resource(ref, `tasks/${uuid(taskId)}/artifacts` as ArdentResource, context);
  }

  /** PLANNED: one artifact manifest (resource artifacts/:sha/manifest). */
  async artifactManifest(ref: string, sha256: string, context: CallContext = {}): Promise<unknown> {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new MagnusError('Invalid artifact ID', 400, 'VALIDATION_ERROR');
    return this.resource(ref, `artifacts/${sha256}/manifest` as ArdentResource, context);
  }

  /** PLANNED: portable development records (resource development, cursor-paginated). */
  async development(ref: string, query: { after?: number; limit?: number } = {}, context: CallContext = {}): Promise<unknown> {
    return this.resource(ref, 'development' as ArdentResource, { ...context, query });
  }

  /**
   * PLANNED: follow a task's journal and live reply text (GET …/tasks/:id/stream, piped
   * unbuffered by Magnus). Yields task.event (resumable, id = journal sequence), task.text,
   * task.delta and task.done.
   */
  async *streamTask(ref: string, taskId: string, options: CallContext & { after?: number } = {}): AsyncGenerator<SseMessage> {
    const { nodeId, profile } = parseAgentRef(ref);
    const query = options.after !== undefined ? `?after=${options.after}` : '';
    const response = await this.send('GET', `/api/v1/ardent/installations/${nodeId}/profiles/${profile}/tasks/${uuid(taskId)}/stream${query}`,
      options, undefined, { accept: 'text/event-stream' }, 0);
    if (!response.ok || !response.body) await this.fail(response);
    yield* parseSse(response.body!);
  }

  /** PLANNED: Magnus New Agent deploy operation. Magnus runs it only when the acting person is an ADMIN. */
  async createAgent(body: NewAgentRequest, context: CallContext): Promise<{ operationId: string }> {
    if (!context.actingSubject) throw new MagnusError('New Agent needs the acting person', 400, 'ACTING_SUBJECT_REQUIRED');
    return z.object({ operationId: z.string() }).parse(await this.json('POST', '/api/v1/ardent/agents', context, body));
  }

  /** PLANNED: step receipts of a New Agent operation. */
  async agentOperation(operationId: string, context: CallContext = {}) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new MagnusError('Invalid operation ID', 400, 'VALIDATION_ERROR');
    return agentOperationSchema.parse(await this.json('GET', `/api/v1/ardent/agents/operations/${operationId}`, context));
  }

  // ── Transport ──

  private async json(method: string, path: string, context: CallContext, body?: unknown): Promise<unknown> {
    const response = await this.send(method, path, context, body);
    if (!response.ok) await this.fail(response);
    const parsed = envelope.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new MagnusError('Magnus answered with an unexpected body', 502, 'BAD_GATEWAY');
    return parsed.data.data;
  }

  private async send(method: string, path: string, context: CallContext, body?: unknown, extraHeaders: Record<string, string> = {}, timeoutMs = this.options.timeoutMs ?? 20_000): Promise<Response> {
    const attempt = async () => {
      const headers: Record<string, string> = { authorization: `Bearer ${await this.options.tokens.token()}`, accept: 'application/json', ...extraHeaders };
      if (context.actingSubject) headers[ACTING_SUBJECT_HEADER] = context.actingSubject;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const signals = [context.signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter((signal): signal is AbortSignal => Boolean(signal));
      return this.request(`${this.baseUrl}${path}`, {
        method, headers, redirect: 'error', ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
      });
    };
    let response = await attempt();
    if (response.status === 401) {
      // A revoked or rotated service token: fetch a new one once.
      await response.body?.cancel();
      this.options.tokens.invalidate();
      response = await attempt();
    }
    return response;
  }

  private async fail(response: Response): Promise<never> {
    const parsed = failure.safeParse(await response.json().catch(() => null));
    const message = parsed.success ? parsed.data.error.message.slice(0, 300) : `Magnus answered HTTP ${response.status}`;
    throw new MagnusError(message, response.status, parsed.success ? parsed.data.error.code : `HTTP_${response.status}`);
  }
}

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new MagnusError('Invalid Ardent task ID', 400, 'VALIDATION_ERROR');
  return value;
}
