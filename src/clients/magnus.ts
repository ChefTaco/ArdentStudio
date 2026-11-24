// Magnus is the only way ArdentStudio reaches an agent. It calls the Magnus control API
// with its own Oathweave service identity (audience `magnus`) and, for work a person asked
// for, forwards that person's Oathweave subject in x-acting-subject so Magnus can check
// and audit both. ArdentStudio never talks to nodes or Ardent directly and holds no Ardent token.
//
// The routes, action bodies and answers come from @hivemagnus/magnus-contracts/ardent-service
// (`ardentServiceRoutes`, the routes a linked service identity may call), pinned to the Magnus
// release Studio is built against. Only shapes that contract leaves open are typed here: the
// installation (which it answers as a record) and the Ardent management resources it relays as-is.
// The agent changes (identity-save, skill-set, config-save, skill-install and reading config) need an
// acting Magnus ADMIN in x-acting-subject (ARDENT_SERVICE_ADMIN_ACTIONS).
// A node agent reports `capabilities.studio` (ARDENT_STUDIO_CAPABILITY): 1 for sessions, streams and
// artifacts, 2 for missions, pause and resume, previews and development, 3 for skill-install; below
// that Magnus answers 409 AGENT_UPGRADE_REQUIRED. A node agent that reports `capabilities.lineage` >= 1
// (Magnus 3.3.0) accepts an optional top-level `execution` (HiveCommon execution context v1) next to
// `action` and `body` on task-submit and mission-submit; older Magnus refuses unknown fields there.
//
// Magnus 3.3.0 node agents (studio 4) also report per-profile runtime levels in the installation report:
// `recovery` >= 1 (tasks/{id}/recovery and the task-recovery action), `lineage` >= 1 (tasks/{id}/lineage)
// and `artifact_transfer` >= 2 (artifacts/{sha256}/content with Range, renditions, manifest/v2). A profile
// below a level answers 409 unsupported_capability with { capability, required_version, installed_version }.
// Those answers are validated with the local schemas below until a magnus-contracts release carries them.
//
// Every call carries x-request-id and traceparent (the current request's, or new ones for background
// work) and, when the call belongs to a task, x-hive-execution. Magnus ignores headers it does not know.
import { formatTraceparent, generateRequestId, generateTraceparent, HIVE_HEADERS, outboundHeaders } from '@hivemagnus/hive-common/context';
import { EXECUTION_HEADER, executionHeaders, type ExecutionContext } from '@hivemagnus/hive-common/execution';
import { retryAfterFromHeaders } from '@hivemagnus/hive-common/retry';
import {
  ARDENT_ACTING_SUBJECT_HEADER,
  ARDENT_SERVICE_CONFIG_PATHS,
  ardentAgentDeployRequestSchema,
  ardentAgentOperationSchema,
  ardentConfigEditSchema,
  ardentConfigFileSchema,
  ardentConfigSavedSchema,
  ardentContextItemSchema,
  ardentDevelopmentNoteSchema,
  ardentDevelopmentPageSchema,
  ardentDevelopmentRecordSchema,
  ardentIdentityEditSchema,
  ardentIdentityFileSchema,
  ardentMissionSubmitSchema,
  ardentPreviewSubmitSchema,
  ardentServiceProfileSchema,
  ardentServiceSessionSchema,
  ardentServiceSkillSetRequestSchema,
  ardentServiceTaskSubmitRequestSchema,
  ardentSessionContextSchema,
  ardentSessionOpenSchema,
  ardentSkillEditSchema,
  ardentSkillInstallResultSchema,
  ardentSkillInstallSchema,
  ardentTaskAdmissionSchema,
  ardentTaskArtifactsSchema,
  ardentArtifactRecordSchema,
  ardentTaskJournalEventSchema,
  ardentTaskPauseStateSchema,
  ardentTeamMissionSchema,
} from '@hivemagnus/magnus-contracts/ardent-service';
import { z } from 'zod';
import { parseSse, type SseMessage } from './sse.js';
import type { ServiceTokenProvider } from './service-token.js';
import { trimTrailingSlashes } from '../url.js';

export {
  ARDENT_SERVICE_ADMIN_ACTIONS, ARDENT_SERVICE_CONFIG_PATHS, ARDENT_STUDIO_CAPABILITY, ARDENT_STUDIO_EVENT_KINDS,
  ardentAgentOperationSchema, ardentTaskDoneEventSchema, ardentTaskJournalEventSchema, ardentTaskTextEventSchema, ardentTeamMissionSchema,
} from '@hivemagnus/magnus-contracts/ardent-service';
export { ARDENT_CONTEXT_ITEMS_MAX_BYTES } from '@hivemagnus/magnus-contracts/browser';

export const ACTING_SUBJECT_HEADER = ARDENT_ACTING_SUBJECT_HEADER;

export class MagnusError extends Error {
  override name = 'MagnusError';
  /** The wait Magnus asked for with Retry-After, in milliseconds, when it sent one. */
  readonly retryAfterMs: number | undefined;
  /** error.details of the answer (for unsupported_capability: capability, required_version, installed_version). */
  readonly details: unknown;
  constructor(message: string, readonly status: number, readonly code: string, options: { retryAfterMs?: number | undefined; details?: unknown } = {}) {
    super(message);
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }
}

/** The 409 code of a profile that lacks a runtime capability a route or action needs (Magnus 3.3.0). */
export const ARDENT_UNSUPPORTED_CAPABILITY = 'unsupported_capability';
export const ardentUnsupportedCapabilityDetailsSchema = z.object({
  capability: z.string(), required_version: z.string(), installed_version: z.string().nullable(),
}).loose();

/** The per-profile runtime levels Studio needs: recovery and lineage reads, and artifact transfer v2. */
export const ARDENT_RUNTIME_LEVELS = { recovery: 1, lineage: 1, artifact_transfer: 2 } as const;
export type ArdentRuntimeCapability = keyof typeof ARDENT_RUNTIME_LEVELS;
/** What one profile offers through Magnus. Levels a node agent does not report are 0. */
export interface ArdentProfileRuntime { studio: number; version: string | null; recovery: number; lineage: number; artifact_transfer: number }

/** The lineage level from which a node agent accepts `execution` on task-submit and mission-submit. */
export const ARDENT_LINEAGE_CAPABILITY = { execution: 1 } as const;

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
  /** The execution context the call belongs to (a task's), sent as x-hive-execution. Attribution only. */
  execution?: ExecutionContext | undefined;
}

/** A task-submit or mission-submit action request, validated and serialized once so a retry can resend it unchanged. */
export interface PreparedSubmission {
  action: 'task-submit' | 'mission-submit';
  /** The exact JSON body for POST …/action. */
  request: string;
}

export type MagnusArdentProfile = z.infer<typeof ardentServiceProfileSchema>;

/**
 * GET /ardent/installations and /ardent/installations/{nodeId}. The service contract answers these
 * as records, so Studio reads only the fields it uses (Magnus ArdentFleetInstallationSchema).
 */
export const magnusArdentInstallationSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  owner: z.string(),
  profiles: z.array(ardentServiceProfileSchema.pick({ id: true, name: true, backend: true, apiPort: true, running: true, a2aEnabled: true, channels: true, error: true }).extend({
    /** The Ardent version the profile runs (studio >= 4). */
    version: z.string().nullable().optional(),
    /** The profile's runtime levels, capped by the node agent (studio >= 4). Absent on older agents, which means 0. */
    capabilities: z.object({
      recovery: z.number().int().min(0).optional(), lineage: z.number().int().min(0).optional(), artifact_transfer: z.number().int().min(0).optional(),
    }).loose().optional(),
  })),
  checkedAt: z.string(),
  nodeId: z.string(),
  nodeName: z.string(),
  hostname: z.string(),
  reachable: z.boolean(),
  error: z.string().nullable(),
  /** The node agent's Studio level (ARDENT_STUDIO_CAPABILITY). Absent on agents that predate it. */
  capabilities: z.object({
    studio: z.number().int().min(0).optional(),
    /** Execution lineage level (ARDENT_LINEAGE_CAPABILITY). Absent on agents that predate it, which means 0. */
    lineage: z.number().int().min(0).optional(),
  }).loose().optional(),
});
export type MagnusArdentInstallation = z.infer<typeof magnusArdentInstallationSchema>;

// Ardent management shapes, as Ardent's OpenAPI document defines them. Magnus relays these resources unchanged.
export const ardentTaskStateSchema = z.enum(['queued', 'running', 'input_required', 'completed', 'partial', 'failed', 'cancelled', 'unknown']);
export const ardentTaskSchema = z.object({
  id: z.string(), caller: z.string(), context: z.string(), session_id: z.string().nullable(), prompt: z.string(), content_hash: z.string(),
  idempotency_key: z.string().nullable(), backend: z.string(), state: ardentTaskStateSchema, result: z.string().nullable(), error: z.string().nullable(),
  deadline_ms: z.number(), created_ms: z.number(), updated_ms: z.number(),
  /** Ardent 3.2.0: the task's execution recovery when it was ever interrupted (validated by ardentTaskRecoverySchema where it is used). */
  recovery: z.unknown().optional(),
});

// Ardent 3.2.0 runtime contracts (C3, lineage and artifact transfer v2), as Magnus 3.3.0 relays them.
export const ARDENT_RECOVERY_ACTIONS = ['mark_applied', 'mark_not_applied', 'retry_with_new_deadline', 'abandon'] as const;
export const ardentRecoveryActionSchema = z.enum(ARDENT_RECOVERY_ACTIONS);
export type ArdentRecoveryAction = z.infer<typeof ardentRecoveryActionSchema>;
export const ARDENT_RECOVERY_STATUSES = ['ready', 'reconciling', 'resumed', 'awaiting_decision', 'unsupported', 'resolved'] as const;
/** A task's execution recovery (C3). Fields Ardent may add are kept. */
export const ardentTaskRecoverySchema = z.object({
  status: z.enum(ARDENT_RECOVERY_STATUSES),
  reason: z.object({ code: z.string().max(128), message: z.string().max(2000) }),
  attempt: z.number().int().min(1),
  checkpoint: z.object({
    step: z.number().int(), completed_calls: z.number().int().min(0),
    pending_calls: z.array(z.object({ call_id: z.string(), tool: z.string(), effect: z.string(), dispatched_at: z.string().nullable(), reconcilable: z.boolean() }).loose()).max(256),
  }).loose().optional(),
  actions: z.array(ardentRecoveryActionSchema),
  continuation_task_id: z.string().optional(),
  decided: z.object({ action: ardentRecoveryActionSchema, by: z.string(), at: z.string(), note: z.string().optional() }).loose().optional(),
}).loose();
export type ArdentTaskRecovery = z.infer<typeof ardentTaskRecoverySchema>;
/** The task-recovery action body: a decision on a task held awaiting_decision. result (mark_applied) is at most 64 KiB. */
export const ardentTaskRecoveryDecisionSchema = z.object({
  action: ardentRecoveryActionSchema,
  call_id: z.string().min(1).max(256).optional(),
  result: z.unknown().optional().refine(value => value === undefined || new TextEncoder().encode(JSON.stringify(value) ?? '').length <= 64 * 1024, 'Exceeds 65536 bytes'),
  note: z.string().min(1).max(2000).optional(),
  deadline_seconds: z.number().int().min(1).max(86_400).optional(),
}).strict();
export type ArdentTaskRecoveryDecision = z.infer<typeof ardentTaskRecoveryDecisionSchema>;
/** GET tasks/{id}/lineage: what the profile knows about a task's causal tree. Relayed as-is; only its frame is checked. */
export const ardentTaskLineageSchema = z.object({
  task_id: z.string(),
  continuations: z.array(z.object({ ref: z.string(), local_task_id: z.string() }).loose()).optional(),
}).loose();
export type ArdentTaskLineage = z.infer<typeof ardentTaskLineageSchema>;
/** GET artifacts/{sha256}/renditions: the original first. */
export const ardentArtifactRenditionSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/), role: z.string().min(1).max(64), mime: z.string().min(1).max(200), size: z.number().int().min(0),
  purpose: z.string().max(64).optional(), width: z.number().int().min(0).optional(), height: z.number().int().min(0).optional(), has_alpha: z.boolean().optional(),
}).loose();
export type ArdentArtifactRendition = z.infer<typeof ardentArtifactRenditionSchema>;
export const ardentArtifactRenditionsSchema = z.object({ renditions: z.array(ardentArtifactRenditionSchema).max(64) }).loose();

/** One read of artifact transfer v2 content: the status, the bytes and what the headers say about them. */
export interface ArtifactContent {
  status: 200 | 206;
  body: ReadableStream<Uint8Array>;
  /** First byte of the body in the artifact (0 for a 200). */
  start: number;
  /** The artifact's whole size when Magnus said it (Content-Range total, or Content-Length of a 200). */
  total: number | undefined;
  /** X-Content-SHA256 (or the ETag digest) when sent. */
  sha256: string | undefined;
  mime: string | undefined;
}
export const ardentStatusSchema = z.object({ version: z.string(), profile: z.string(), backend: z.string(), tasks: z.number().int() });
export const ardentMemoryStatusSchema = z.object({
  status: z.enum(['ready', 'degraded']), agent_id: z.string(), workspace_id: z.string(),
  retrieval: z.string().nullable(), storage: z.string().nullable(), reason: z.string().nullable(),
});
export const ardentSkillSchema = z.object({ name: z.string(), enabled: z.boolean() }).loose();

/** Profile resources Magnus lets a service identity read (the resource note of ardentServiceRoutes). */
export type ArdentResource =
  | 'status' | 'profile' | 'skills' | 'memory/status' | 'sessions' | `sessions/${string}/messages`
  | 'tasks' | `tasks/${string}` | `tasks/${string}/events` | 'identity/soul' | 'identity/identity' | 'config'
  // studio >= 2
  | `tasks/${string}/artifacts` | `artifacts/${string}/manifest` | 'development'
  // studio >= 4 with the profile's runtime level (ARDENT_RUNTIME_LEVELS)
  | `tasks/${string}/recovery` | `tasks/${string}/lineage` | `artifacts/${string}/renditions`;

/** Actions released Magnus accepts on POST …/action (an ADMIN person; a service identity gets the Studio subset below). */
export const RELEASED_ACTIONS = ['profile-create', 'config-validate', 'config-save', 'peer-validate', 'peer-save', 'identity-save', 'identity-restore',
  'provider-test', 'channel-test', 'peer-test', 'memory-search', 'task-submit', 'task-cancel', 'skill-set', 'service-start', 'service-stop',
  'service-restart', 'package-install', 'context-stage', 'context-adopt', 'context-rollback'] as const;
/**
 * Actions added for Ardent Project Studio. session-open needs studio >= 1, skill-install studio >= 3 and a
 * Magnus with a HiveSkills registry, the others studio >= 2 and Ardent 2.2.0.
 */
export const STUDIO_ACTIONS = ['session-open', 'mission-submit', 'task-pause', 'task-resume', 'preview-submit', 'development-note', 'skill-install'] as const;
/** Actions of the Ardent 3.2.0 runtime contracts (Magnus 3.3.0, studio >= 4): task-recovery needs the profile's recovery >= 1. */
export const RUNTIME_ACTIONS = ['task-recovery'] as const;
export type MagnusArdentAction = typeof RELEASED_ACTIONS[number] | typeof STUDIO_ACTIONS[number] | typeof RUNTIME_ACTIONS[number];
/** A configuration value a service's config-save may change (ARDENT_SERVICE_CONFIG_PATHS); anything else answers 403 CONFIG_PATH_FORBIDDEN. */
export type ArdentServiceConfigPath = typeof ARDENT_SERVICE_CONFIG_PATHS[number];
/**
 * Whether Magnus lets the Studio service identity run service-restart. It does not: a service may run
 * only the session, task, mission, preview, development and ARDENT_SERVICE_ADMIN_ACTIONS actions, so a
 * profile restart stays a person's act in the Magnus console.
 */
export const ARDENT_SERVICE_CAN_RESTART = false;

export type ArdentSessionContext = z.infer<typeof ardentSessionContextSchema>;
export type ArdentIdentityFile = z.infer<typeof ardentIdentityFileSchema>;
export type ArdentConfigFile = z.infer<typeof ardentConfigFileSchema>;
export type ArdentConfigSaved = z.infer<typeof ardentConfigSavedSchema>;
export type ArdentSkillInstallResult = z.infer<typeof ardentSkillInstallResultSchema>;
export type ArdentTeamMission = z.infer<typeof ardentTeamMissionSchema>;
export type ArdentContextItem = z.infer<typeof ardentContextItemSchema>;
export type ArdentDevelopmentRecord = z.infer<typeof ardentDevelopmentRecordSchema>;
export type ArdentTaskEvent = z.infer<typeof ardentTaskJournalEventSchema>;
export type NewAgentRequest = z.input<typeof ardentAgentDeployRequestSchema>;
export type MagnusAgentOperation = z.infer<typeof ardentAgentOperationSchema>;

/** action task-submit: the prompt is at most 16000 characters and the idempotency key a UUID. */
const ardentTaskSubmitSchema = ardentServiceTaskSubmitRequestSchema.shape.body;
/** action skill-set: the skill name is the target. */
const ardentSkillTargetSchema = ardentServiceSkillSetRequestSchema.shape.target;
/** The New Agent and resume answers. */
const operationAcceptedSchema = z.object({ operationId: z.string() });

export interface MagnusClientOptions {
  baseUrl: string;
  tokens: Pick<ServiceTokenProvider, 'token' | 'invalidate'>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const envelope = z.object({ success: z.literal(true), data: z.unknown() });
const failure = z.object({ success: z.literal(false), error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });

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
    return z.array(ardentServiceProfileSchema).parse(await this.json('GET', '/api/v1/ardent/profiles', context));
  }

  async listInstallations(context: CallContext = {}): Promise<MagnusArdentInstallation[]> {
    return z.array(magnusArdentInstallationSchema).parse(await this.json('GET', '/api/v1/ardent/installations', context));
  }

  async getInstallation(nodeId: string, context: CallContext = {}): Promise<MagnusArdentInstallation> {
    if (!REF_PART.test(nodeId)) throw new MagnusError('Invalid node ID', 400, 'INVALID_AGENT_REF');
    return magnusArdentInstallationSchema.parse(await this.json('GET', `/api/v1/ardent/installations/${nodeId}`, context));
  }

  /** Read an allow-listed Ardent management resource through Magnus. */
  async resource(ref: string, resource: ArdentResource, context: CallContext & { query?: { after?: number | string; limit?: number; kind?: string; context?: ArdentSessionContext } } = {}): Promise<unknown> {
    const { nodeId, profile } = parseAgentRef(ref);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(context.query ?? {})) if (value !== undefined) query.set(key, String(value));
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
    return z.object({ events: z.array(ardentTaskJournalEventSchema) }).parse(await this.resource(ref, `tasks/${uuid(taskId)}/events`, { ...context, query: { after } })).events;
  }

  async identity(ref: string, kind: 'soul' | 'identity', context: CallContext = {}): Promise<ArdentIdentityFile> {
    return ardentIdentityFileSchema.parse(await this.resource(ref, `identity/${kind}`, context));
  }

  /** The profile's config.yaml and its revision. Needs an acting Magnus ADMIN. */
  async config(ref: string, context: CallContext = {}): Promise<ArdentConfigFile> {
    return ardentConfigFileSchema.parse(await this.resource(ref, 'config', context));
  }

  /** Artifact bytes, buffered (Magnus caps them; see MAGNUS_AGENT_ARDENT_ARTIFACT_MAX_BYTES). Prefer artifactStream for large files. */
  async artifact(ref: string, sha256: string, context: CallContext = {}): Promise<Uint8Array> {
    const response = await this.artifactStream(ref, sha256, context);
    return new Uint8Array(await new Response(response.body).arrayBuffer());
  }

  /** Artifact bytes as Magnus streams them, never buffered here. The caller verifies the digest. */
  async artifactStream(ref: string, sha256: string, context: CallContext = {}): Promise<{ body: ReadableStream<Uint8Array>; size: number | undefined }> {
    const { nodeId, profile } = parseAgentRef(ref);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new MagnusError('Invalid artifact ID', 400, 'VALIDATION_ERROR');
    const response = await this.send('GET', `/api/v1/ardent/installations/${nodeId}/profiles/${profile}/artifacts/${sha256}`, context,
      undefined, { accept: 'application/octet-stream' }, 0);
    if (!response.ok || !response.body) await this.fail(response);
    const length = Number(response.headers.get('content-length') ?? '');
    return { body: response.body!, size: Number.isSafeInteger(length) && length >= 0 && response.headers.has('content-length') ? length : undefined };
  }

  /** Run a management action through Magnus's audited action route. */
  async action(ref: string, action: MagnusArdentAction, input: { target?: string; body?: unknown } = {}, context: CallContext = {}): Promise<unknown> {
    const { nodeId, profile } = parseAgentRef(ref);
    const payload: Record<string, unknown> = { action };
    if (input.target !== undefined) payload.target = input.target;
    if (input.body !== undefined) payload.body = input.body;
    return this.json('POST', `/api/v1/ardent/installations/${nodeId}/profiles/${profile}/action`, context, payload);
  }

  /** A direct task. The prompt is at most 16000 characters; the idempotency key is a UUID; a session (studio >= 1) carries the conversation. */
  async submitTask(ref: string, body: z.input<typeof ardentTaskSubmitSchema>, context: CallContext = {}) {
    const parsed = ardentTaskSubmitSchema.safeParse(body);
    if (!parsed.success) throw new MagnusError(`Task submission is invalid: ${parsed.error.issues[0]?.message ?? 'invalid'}`, 400, 'VALIDATION_ERROR');
    return ardentTaskAdmissionSchema.parse(await this.action(ref, 'task-submit', { body: parsed.data }, context));
  }

  /**
   * Validate and serialize a task-submit (`dispatch` turn) or mission-submit request. `execution` is included
   * only when given: send it only to a node agent with lineage >= 1, as older Magnus refuses the field.
   */
  prepareSubmission(input: { action: 'task-submit'; body: z.input<typeof ardentTaskSubmitSchema> } | { action: 'mission-submit'; body: z.input<typeof ardentMissionSubmitSchema> },
    execution?: ExecutionContext): PreparedSubmission {
    const schema = input.action === 'task-submit' ? ardentTaskSubmitSchema : ardentMissionSubmitSchema;
    const parsed = schema.safeParse(input.body);
    if (!parsed.success) {
      throw new MagnusError(`${input.action === 'task-submit' ? 'Task submission' : 'Mission'} is invalid: ${parsed.error.issues[0]?.message ?? 'invalid'}`, 400, 'VALIDATION_ERROR');
    }
    return { action: input.action, request: JSON.stringify({ action: input.action, body: parsed.data, ...(execution ? { execution } : {}) }) };
  }

  /** Send a prepared submission exactly as it was serialized. */
  async submitPrepared(ref: string, submission: Pick<PreparedSubmission, 'request'>, context: CallContext = {}) {
    const { nodeId, profile } = parseAgentRef(ref);
    return ardentTaskAdmissionSchema.parse(await this.json('POST', `/api/v1/ardent/installations/${nodeId}/profiles/${profile}/action`, context, new SerializedBody(submission.request)));
  }

  async cancelTask(ref: string, taskId: string, context: CallContext = {}): Promise<unknown> {
    return this.action(ref, 'task-cancel', { target: uuid(taskId) }, context);
  }

  /** Ardent rejects a stale revision with 409, so concurrent edits never overwrite each other. */
  async saveIdentity(ref: string, kind: 'soul' | 'identity', body: { text: string; revision: string }, context: CallContext = {}): Promise<ArdentIdentityFile> {
    return ardentIdentityFileSchema.parse(await this.action(ref, 'identity-save', { target: kind, body: validated(ardentIdentityEditSchema, body, 'identity-save') }, context));
  }

  /** Each change answers the next configuration revision: chain it into the next skill-set or config-save. */
  async setSkill(ref: string, name: string, body: { enabled: boolean; revision: string }, context: CallContext = {}): Promise<ArdentConfigSaved> {
    const target = validated(ardentSkillTargetSchema, name, 'skill-set');
    return ardentConfigSavedSchema.parse(await this.action(ref, 'skill-set', { target, body: validated(ardentSkillEditSchema, body, 'skill-set') }, context));
  }

  /**
   * Install a HiveSkills catalog release (studio >= 3). Magnus answers 503 HIVESKILLS_UNCONFIGURED without a registry,
   * 409 SKILL_VERSION_UNAVAILABLE or SKILL_CONFLICT, and 422 SKILL_ARCHIVE_INVALID; a Magnus that predates the action
   * answers 400 "Invalid Ardent action".
   */
  async installSkill(ref: string, body: z.input<typeof ardentSkillInstallSchema>, context: CallContext = {}): Promise<ArdentSkillInstallResult> {
    return ardentSkillInstallResultSchema.parse(await this.action(ref, 'skill-install', { body: validated(ardentSkillInstallSchema, body, 'skill-install') }, context));
  }

  /** Magnus refuses (403 CONFIG_PATH_FORBIDDEN) a text that changes anything outside ARDENT_SERVICE_CONFIG_PATHS. */
  async saveConfig(ref: string, body: { text: string; revision: string }, context: CallContext = {}): Promise<ArdentConfigSaved> {
    return ardentConfigSavedSchema.parse(await this.action(ref, 'config-save', { body: validated(ardentConfigEditSchema, body, 'config-save') }, context));
  }

  // ── Ardent 3.2.0 runtime contracts (Magnus 3.3.0) ──

  /** A profile's runtime levels from its node's installation report. Levels the node agent does not report are 0. */
  async runtime(ref: string, context: CallContext = {}): Promise<ArdentProfileRuntime> {
    const { nodeId, profile } = parseAgentRef(ref);
    const installation = await this.getInstallation(nodeId, context);
    const entry = installation.profiles.find(item => item.id === profile);
    const level = (name: ArdentRuntimeCapability) => entry?.capabilities?.[name] ?? 0;
    return { studio: installation.capabilities?.studio ?? 0, version: entry?.version ?? installation.version, recovery: level('recovery'),
      lineage: level('lineage'), artifact_transfer: level('artifact_transfer') };
  }

  /** A task's execution recovery. recovery >= 1; Magnus answers 404 when the task was never interrupted. */
  async taskRecovery(ref: string, taskId: string, context: CallContext = {}): Promise<ArdentTaskRecovery> {
    return ardentTaskRecoverySchema.parse(await this.resource(ref, `tasks/${uuid(taskId)}/recovery`, context));
  }

  /** Decide a task Ardent holds awaiting_decision (action task-recovery). Answers the recovery; continuation_task_id names the continuation. */
  async decideRecovery(ref: string, taskId: string, body: ArdentTaskRecoveryDecision, context: CallContext = {}): Promise<ArdentTaskRecovery> {
    return ardentTaskRecoverySchema.parse(await this.action(ref, 'task-recovery', { target: uuid(taskId), body: validated(ardentTaskRecoveryDecisionSchema, body, 'task-recovery') }, context));
  }

  /** A task's lineage as the profile records it. lineage >= 1. */
  async taskLineage(ref: string, taskId: string, context: CallContext = {}): Promise<ArdentTaskLineage> {
    return ardentTaskLineageSchema.parse(await this.resource(ref, `tasks/${uuid(taskId)}/lineage`, context));
  }

  /** The renditions of an artifact, the original first. artifact_transfer >= 2. */
  async artifactRenditions(ref: string, sha256: string, context: CallContext = {}): Promise<ArdentArtifactRendition[]> {
    return ardentArtifactRenditionsSchema.parse(await this.resource(ref, `artifacts/${sha(sha256)}/renditions`, context)).renditions;
  }

  /**
   * Artifact transfer v2 content, streamed. `range` asks for the bytes from an offset (`bytes=<from>-`) and
   * `ifRange` (the ETag `"<sha256>"`) makes Ardent send the whole artifact instead when it is not that one.
   * Answers 200 or 206; anything else throws a MagnusError (416 for a range past the end). artifact_transfer >= 2.
   */
  async artifactContent(ref: string, sha256: string, options: CallContext & { from?: number; ifRange?: string } = {}): Promise<ArtifactContent> {
    const { nodeId, profile } = parseAgentRef(ref);
    const headers: Record<string, string> = { accept: '*/*' };
    if (options.from !== undefined && options.from > 0) {
      if (!Number.isSafeInteger(options.from)) throw new MagnusError('Invalid range', 400, 'VALIDATION_ERROR');
      headers.range = `bytes=${options.from}-`;
      if (options.ifRange) headers['if-range'] = options.ifRange;
    }
    const response = await this.send('GET', `/api/v1/ardent/installations/${nodeId}/profiles/${profile}/artifacts/${sha(sha256)}/content`, options, undefined, headers, 0);
    if ((response.status !== 200 && response.status !== 206) || !response.body) await this.fail(response);
    const digest = response.headers.get('x-content-sha256') ?? /^"([a-f0-9]{64})"$/.exec(response.headers.get('etag') ?? '')?.[1] ?? undefined;
    const length = response.headers.has('content-length') ? Number(response.headers.get('content-length')) : NaN;
    let start = 0;
    let total: number | undefined = response.status === 200 && Number.isSafeInteger(length) && length >= 0 ? length : undefined;
    if (response.status === 206) {
      const range = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/.exec(response.headers.get('content-range') ?? '');
      if (!range) { await response.body!.cancel().catch(() => undefined); throw new MagnusError('Magnus answered 206 without a usable Content-Range', 502, 'BAD_GATEWAY'); }
      start = Number(range[1]);
      total = Number(range[3]);
    }
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || undefined;
    return { status: response.status as 200 | 206, body: response.body!, start, total, sha256: digest && /^[a-f0-9]{64}$/.test(digest) ? digest : undefined, mime };
  }

  // ── Studio routes ──

  /** The node agent's Studio level for a node: 0 when it reports none. */
  async studioLevel(nodeId: string, context: CallContext = {}): Promise<number> {
    return (await this.getInstallation(nodeId, context)).capabilities?.studio ?? 0;
  }

  /** Open (or reopen: the same key answers the same session) an Ardent session. studio >= 1; a context needs studio >= 2. */
  async openSession(ref: string, body: z.input<typeof ardentSessionOpenSchema>, context: CallContext = {}) {
    return ardentServiceSessionSchema.parse(await this.action(ref, 'session-open', { body: ardentSessionOpenSchema.parse(body) }, context));
  }

  /** Submit a team mission in a session opened with context mission. studio >= 2. */
  async submitMission(ref: string, body: z.input<typeof ardentMissionSubmitSchema>, context: CallContext = {}) {
    const parsed = ardentMissionSubmitSchema.safeParse(body);
    if (!parsed.success) throw new MagnusError(`Mission is invalid: ${parsed.error.issues[0]?.message ?? 'invalid'}`, 400, 'VALIDATION_ERROR');
    return ardentTaskAdmissionSchema.parse(await this.action(ref, 'mission-submit', { body: parsed.data }, context));
  }

  /** Pause at the next step boundary. studio >= 2; a finished task answers 409. */
  async pauseTask(ref: string, taskId: string, context: CallContext = {}) {
    return ardentTaskPauseStateSchema.parse(await this.action(ref, 'task-pause', { target: uuid(taskId) }, context));
  }

  async resumeTask(ref: string, taskId: string, context: CallContext = {}) {
    return ardentTaskPauseStateSchema.parse(await this.action(ref, 'task-resume', { target: uuid(taskId) }, context));
  }

  /** A side-effect-free preview task with draft overrides. studio >= 2; needs the acting person. */
  async submitPreview(ref: string, body: z.input<typeof ardentPreviewSubmitSchema>, context: CallContext) {
    if (!context.actingSubject) throw new MagnusError('A preview needs the acting person', 400, 'ACTING_SUBJECT_REQUIRED');
    return ardentTaskAdmissionSchema.parse(await this.action(ref, 'preview-submit', { body: ardentPreviewSubmitSchema.parse(body) }, context));
  }

  /** Record a development note. studio >= 2; needs the acting person. */
  async addDevelopmentNote(ref: string, body: z.input<typeof ardentDevelopmentNoteSchema>, context: CallContext) {
    if (!context.actingSubject) throw new MagnusError('A development note needs the acting person', 400, 'ACTING_SUBJECT_REQUIRED');
    return ardentDevelopmentRecordSchema.parse(await this.action(ref, 'development-note', { body: ardentDevelopmentNoteSchema.parse(body) }, context));
  }

  /** Artifact manifests a task registered, oldest first. studio >= 2. */
  async taskArtifacts(ref: string, taskId: string, context: CallContext = {}) {
    return ardentTaskArtifactsSchema.parse(await this.resource(ref, `tasks/${uuid(taskId)}/artifacts`, context)).artifacts;
  }

  /** One artifact manifest. studio >= 2. */
  async artifactManifest(ref: string, sha256: string, context: CallContext = {}) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new MagnusError('Invalid artifact ID', 400, 'VALIDATION_ERROR');
    return ardentArtifactRecordSchema.parse(await this.resource(ref, `artifacts/${sha256}/manifest`, context));
  }

  /** Portable development records, cursor-paginated. studio >= 2. */
  async development(ref: string, query: { after?: string; limit?: number; kind?: string } = {}, context: CallContext = {}) {
    if (query.after !== undefined && !/^[A-Za-z0-9_-]{1,400}$/.test(query.after)) throw new MagnusError('Invalid development cursor', 400, 'VALIDATION_ERROR');
    return ardentDevelopmentPageSchema.parse(await this.resource(ref, 'development', { ...context, query }));
  }

  /**
   * Follow a task's journal and live reply text (GET …/tasks/:id/stream, piped unbuffered by
   * Magnus). Yields task.event (resumable, id = journal sequence), task.text, task.delta and
   * task.done. Ardent ends a stream after 60 seconds; reconnect with `after`.
   */
  async *streamTask(ref: string, taskId: string, options: CallContext & { after?: number } = {}): AsyncGenerator<SseMessage> {
    const { nodeId, profile } = parseAgentRef(ref);
    const query = options.after !== undefined ? `?after=${options.after}` : '';
    const response = await this.send('GET', `/api/v1/ardent/installations/${nodeId}/profiles/${profile}/tasks/${uuid(taskId)}/stream${query}`,
      options, undefined, { accept: 'text/event-stream' }, 0);
    if (!response.ok || !response.body) await this.fail(response);
    yield* parseSse(response.body!);
  }

  /** Magnus New Agent deploy operation. Magnus runs it only when the acting person is a Magnus ADMIN. */
  async createAgent(body: NewAgentRequest, context: CallContext): Promise<{ operationId: string }> {
    if (!context.actingSubject) throw new MagnusError('New Agent needs the acting person', 400, 'ACTING_SUBJECT_REQUIRED');
    return operationAcceptedSchema.parse(await this.json('POST', '/api/v1/ardent/agents', context, ardentAgentDeployRequestSchema.parse(body)));
  }

  /** Step receipts of a New Agent or Enable HiveMem operation. */
  async agentOperation(operationId: string, context: CallContext = {}) {
    return ardentAgentOperationSchema.parse(await this.json('GET', `/api/v1/ardent/agents/operations/${operationIdOf(operationId)}`, context));
  }

  /** Live operation updates: `operation` events, then one `done`. */
  async *streamAgentOperation(operationId: string, options: CallContext = {}): AsyncGenerator<SseMessage> {
    const response = await this.send('GET', `/api/v1/ardent/agents/operations/${operationIdOf(operationId)}/stream`, options, undefined, { accept: 'text/event-stream' }, 0);
    if (!response.ok || !response.body) await this.fail(response);
    yield* parseSse(response.body!);
  }

  /** Resume a failed operation from its first unfinished step. Needs an acting ADMIN. */
  async resumeAgentOperation(operationId: string, context: CallContext): Promise<{ operationId: string }> {
    if (!context.actingSubject) throw new MagnusError('Resuming an operation needs the acting person', 400, 'ACTING_SUBJECT_REQUIRED');
    return operationAcceptedSchema.parse(await this.json('POST', `/api/v1/ardent/agents/operations/${operationIdOf(operationId)}/resume`, context));
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
    const correlation = correlationHeaders(context.execution);
    const attempt = async () => {
      const headers: Record<string, string> = { ...correlation, authorization: `Bearer ${await this.options.tokens.token()}`, accept: 'application/json', ...extraHeaders };
      if (context.actingSubject) headers[ACTING_SUBJECT_HEADER] = context.actingSubject;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const signals = [context.signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter((signal): signal is AbortSignal => Boolean(signal));
      return this.request(`${this.baseUrl}${path}`, {
        method, headers, redirect: 'error', ...(body !== undefined ? { body: body instanceof SerializedBody ? body.text : JSON.stringify(body) } : {}),
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
    const retryAfterMs = retryAfterFromHeaders(response.headers);
    throw new MagnusError(message, response.status, parsed.success ? parsed.data.error.code : `HTTP_${response.status}`,
      { retryAfterMs, ...(parsed.success && parsed.data.error.details !== undefined ? { details: parsed.data.error.details } : {}) });
  }
}

/** A request body already serialized (a frozen submission): sent byte for byte. */
class SerializedBody {
  constructor(readonly text: string) {}
}

/**
 * x-request-id, traceparent (and tracestate) of the current request, or new ones for background work, and
 * x-hive-execution: the call's own execution context when it has one, otherwise the request's.
 */
export function correlationHeaders(execution?: ExecutionContext): Record<string, string> {
  const headers = outboundHeaders();
  if (!headers[HIVE_HEADERS.requestId]) {
    headers[HIVE_HEADERS.requestId] = generateRequestId();
    headers[HIVE_HEADERS.traceparent] = formatTraceparent(generateTraceparent());
  }
  if (execution) {
    delete headers[EXECUTION_HEADER];
    Object.assign(headers, executionHeaders(execution));
  }
  return headers;
}

function validated<T>(schema: z.ZodType<T>, value: unknown, action: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MagnusError(`The ${action} request is invalid: ${parsed.error.issues[0]?.message ?? 'invalid'}`, 400, 'VALIDATION_ERROR');
  return parsed.data;
}

function operationIdOf(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new MagnusError('Invalid operation ID', 400, 'VALIDATION_ERROR');
  return value;
}

function sha(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new MagnusError('Invalid artifact ID', 400, 'VALIDATION_ERROR');
  return value;
}

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new MagnusError('Invalid Ardent task ID', 400, 'VALIDATION_ERROR');
  return value;
}
