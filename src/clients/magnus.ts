// Magnus is the only way ArdentStudio reaches an agent. It calls the Magnus control API
// with its own Oathweave service identity (audience `magnus`) and, for work a person asked
// for, forwards that person's Oathweave subject in x-acting-subject so Magnus can check
// and audit both. ArdentStudio never talks to nodes or Ardent directly and holds no Ardent token.
//
// Released Magnus 2.1.x serves the profile, installation, resource and action routes. The Studio
// routes (sessions, task streams, streamed artifacts, New Agent, missions, pause, previews,
// development) are typed here from Magnus's `packages/contracts/src/ardent-service.ts`
// (`ardentServiceRoutes`) and `browser.ts`, because the published @hivemagnus/magnus-contracts
// does not contain them yet. Switch these local schemas to that package once a release ships them.
// The agent changes (identity-save, skill-set, config-save and reading config) need an acting
// Magnus ADMIN in x-acting-subject; their shapes are typed here from the same file.
// A node agent reports `capabilities.studio`: 1 for sessions, streams and artifacts, 2 for missions,
// pause and resume, previews and development; below that Magnus answers 409 AGENT_UPGRADE_REQUIRED.
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
  /** The node agent's Studio level (ARDENT_STUDIO_CAPABILITY). Absent on agents that predate it. */
  capabilities: z.object({ studio: z.number().int().min(0).optional() }).loose().optional(),
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
/** Admission of task-submit, mission-submit and preview-submit: durable acceptance, never completion. */
export const ardentAcceptedTaskSchema = z.object({ task_id: z.string(), state: z.string() });

/** Profile resources released Magnus lets a caller read (routes/ardent.ts allow-list). */
export type ArdentResource =
  | 'openapi' | 'status' | 'profile' | 'config' | 'config/schema' | 'providers' | 'channels' | 'peers' | 'peers/config'
  | 'memory/status' | 'skills' | 'sessions' | 'tasks' | `tasks/${string}` | `tasks/${string}/events` | `sessions/${string}/messages`
  | 'identity/soul' | 'identity/identity' | 'identity/soul/history' | 'identity/identity/history'
  // studio >= 2
  | `tasks/${string}/artifacts` | `artifacts/${string}/manifest` | 'development';

/** Actions released Magnus accepts on POST …/action (an ADMIN person; a service identity gets the Studio subset below). */
export const RELEASED_ACTIONS = ['profile-create', 'config-validate', 'config-save', 'peer-validate', 'peer-save', 'identity-save', 'identity-restore',
  'provider-test', 'channel-test', 'peer-test', 'memory-search', 'task-submit', 'task-cancel', 'skill-set', 'service-start', 'service-stop',
  'service-restart', 'package-install', 'context-stage', 'context-adopt', 'context-rollback'] as const;
/**
 * Actions added for Ardent Project Studio. session-open needs studio >= 1, skill-install studio >= 3 and a
 * Magnus with a HiveSkills registry, the others studio >= 2 and Ardent 2.2.0.
 */
export const STUDIO_ACTIONS = ['session-open', 'mission-submit', 'task-pause', 'task-resume', 'preview-submit', 'development-note', 'skill-install'] as const;
export type MagnusArdentAction = typeof RELEASED_ACTIONS[number] | typeof STUDIO_ACTIONS[number];
/**
 * Agent changes Magnus runs for a service identity only with x-acting-subject naming a linked Magnus
 * ADMIN (Magnus ARDENT_SERVICE_ADMIN_ACTIONS). Without one: 403 ACTING_ADMIN_REQUIRED; an unlinked
 * subject: 403 ACTING_SUBJECT_UNLINKED. A stale revision answers 409 CONFLICT. Reading config needs
 * the same acting ADMIN.
 */
export const ARDENT_SERVICE_ADMIN_ACTIONS = ['identity-save', 'skill-set', 'config-save', 'skill-install'] as const;
/**
 * The only configuration values a service's config-save may change (Magnus ARDENT_SERVICE_CONFIG_PATHS).
 * A change anywhere else answers 403 CONFIG_PATH_FORBIDDEN. An array is one value.
 */
export const ARDENT_SERVICE_CONFIG_PATHS = [
  'execution.backend',
  'providers.llamacpp.model', 'providers.llamacpp.request_timeout_seconds', 'providers.llamacpp.context_window_tokens',
  'providers.llamacpp.max_output_tokens', 'providers.llamacpp.reasoning_effort',
  'providers.codex.model',
  'skills.enabled',
  'artifacts.max_bytes',
] as const;
export type ArdentServiceConfigPath = typeof ARDENT_SERVICE_CONFIG_PATHS[number];
/**
 * Whether Magnus lets the Studio service identity run service-restart. It does not: a service may run
 * only the session, task, mission, preview, development and ARDENT_SERVICE_ADMIN_ACTIONS actions, so a
 * profile restart stays a person's act in the Magnus console.
 */
export const ARDENT_SERVICE_CAN_RESTART = false;
/** Node agent Studio levels (Magnus ARDENT_STUDIO_CAPABILITY). */
export const ARDENT_STUDIO_CAPABILITY = { bridge: 1, missions: 2, skillInstall: 3 } as const;
/** Journal event kinds Ardent 2.2.0 adds. Others appear too; readers accept unknown kinds. */
export const ARDENT_STUDIO_EVENT_KINDS = ['mission', 'team_handoff', 'team_ask_user', 'team_propose_decision', 'artifact_registered', 'development_note',
  'team_result', 'team_result_rejected', 'pause_requested', 'paused', 'resumed', 'preview'] as const;

const utf8Length = (value: string) => Buffer.byteLength(value, 'utf8');
const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const boundedId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const missionText = (bytes: number) => z.string().trim().min(1).refine(value => utf8Length(value) <= bytes, `Exceeds ${bytes} bytes`);
const missionTexts = (minimum = 0) => z.array(missionText(1000)).min(minimum).max(32).refine(value => new Set(value).size === value.length, 'Duplicate entries');

export const ardentSessionContextSchema = z.enum(['direct', 'mission', 'preview']);
export type ArdentSessionContext = z.infer<typeof ardentSessionContextSchema>;
/** GET …/identity/soul and …/identity/identity, and the identity-save answer. */
export const ardentIdentityFileSchema = z.object({ kind: z.enum(['soul', 'identity']), name: z.string(), text: z.string(), revision: digest });
export type ArdentIdentityFile = z.infer<typeof ardentIdentityFileSchema>;
/** GET …/config: the raw config.yaml and its revision (the base for skill-set and config-save). Secrets appear only as environment variable names. */
export const ardentConfigFileSchema = z.object({ revision: digest, text: z.string() });
export type ArdentConfigFile = z.infer<typeof ardentConfigFileSchema>;
/** The skill-set and config-save answer: the new configuration revision. The change applies once the profile restarts. */
export const ardentConfigSavedSchema = z.object({ revision: digest, activation_required: z.boolean() });
export type ArdentConfigSaved = z.infer<typeof ardentConfigSavedSchema>;
/** action identity-save */
export const ardentIdentityEditSchema = z.object({ text: z.string().min(1).max(128 * 1024), revision: digest }).strict();
/** action skill-set: revision is the configuration revision. */
export const ardentSkillEditSchema = z.object({ enabled: z.boolean(), revision: digest }).strict();
export const ardentSkillTargetSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
/**
 * action skill-install (Magnus ardentSkillInstallSchema): a HiveSkills catalog release that Magnus fetches,
 * checks against the catalog digest and installs onto the profile; with enable, the configuration revision.
 */
export const ardentSkillInstallSchema = z.object({
  source: z.literal('hiveskills'),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  version: z.string().max(64).regex(/^v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i),
  channel: z.enum(['stable', 'canary']).optional(),
  enable: z.boolean().optional(),
  revision: digest.optional(),
}).strict().refine(value => !value.enable || value.revision !== undefined, { message: 'enable needs the configuration revision', path: ['revision'] });
/** The skill-install answer. A failed enable leaves the skill installed, with enable_error saying why. */
export const ardentSkillInstallResultSchema = z.object({
  source: z.literal('hiveskills'), name: z.string(), version: z.string(), sha256: digest, files: z.number().int(),
  changed: z.boolean(), enabled: z.boolean(), revision: digest.nullable(), enable_error: z.string().nullable(), activation_required: z.boolean(),
});
export type ArdentSkillInstallResult = z.infer<typeof ardentSkillInstallResultSchema>;
/** action config-save: the whole config.yaml and the configuration revision it replaces. */
export const ardentConfigEditSchema = z.object({ text: z.string().min(1).max(200_000), revision: digest }).strict();
/** action session-open */
export const ardentSessionOpenSchema = z.object({ key: z.string().trim().min(1).max(256), reset: z.boolean().optional(), context: ardentSessionContextSchema.optional() }).strict();
export const ardentSessionSchema = z.object({ id: guid, caller: z.string(), context: z.string(), key: z.string(), created_ms: z.number(), updated_ms: z.number() });
/** action task-submit */
export const ardentTaskSubmitSchema = z.object({ prompt: z.string().trim().min(1).max(16_000), idempotency_key: guid, session_id: guid.optional() }).strict();
/** Ardent TeamMission 1.0 (src/team-contract.ts). */
export const ardentTeamMissionSchema = z.object({
  id: boundedId,
  revision: z.number().int().min(1).max(2_147_483_647),
  parent_task: boundedId.nullable(),
  constraints: missionTexts(),
  allowed_actions: z.array(z.enum(['observe', 'analyze', 'create_artifact', 'create_draft', 'reversible_change', 'deploy', 'external_publish', 'destructive_response']))
    .min(1).max(8).refine(value => new Set(value).size === value.length, 'Duplicate action'),
  /** Tool and memory grants, such as tool:artifact_write or project:<id>. */
  resources: missionTexts(1),
  /** Unix seconds. */
  deadline: z.number().int().min(1).max(253_402_300_799),
  acceptance_criteria: missionTexts(1),
  expected_artifacts: missionTexts(),
}).strict();
export type ArdentTeamMission = z.infer<typeof ardentTeamMissionSchema>;
export const ARDENT_CONTEXT_ITEMS_MAX_BYTES = 64 * 1024;
export const ardentContextItemSchema = z.object({
  title: z.string().trim().min(1).max(200), mime: z.string().regex(/^[a-z]+\/[A-Za-z0-9.+-]+$/).max(100).optional(), text: z.string().min(1),
}).strict();
export type ArdentContextItem = z.infer<typeof ardentContextItemSchema>;
/** action mission-submit (the whole action body is at most 200 KB). The session must have context mission. */
export const ardentMissionSubmitSchema = z.object({
  session_id: guid.optional(),
  objective: z.string().trim().min(1).max(16_000),
  mission: ardentTeamMissionSchema,
  context_items: z.array(ardentContextItemSchema).max(64).optional()
    .refine(items => utf8Length((items ?? []).map(item => item.title + item.text).join('')) <= ARDENT_CONTEXT_ITEMS_MAX_BYTES, 'Context items exceed 64 KiB'),
  labels: z.record(z.string().regex(/^[a-z][a-z0-9._:-]{0,63}$/), z.string().max(256)).refine(value => Object.keys(value).length <= 32, 'At most 32 labels').optional(),
  idempotency_key: z.string().min(1).max(128),
}).strict();
export type ArdentMissionSubmit = z.infer<typeof ardentMissionSubmitSchema>;
/** action preview-submit (at most 300 KB). Needs x-acting-subject. */
export const ardentPreviewOverridesSchema = z.object({
  soul: z.string().min(1).max(131_072).optional(),
  identity: z.string().min(1).max(131_072).optional(),
  skills_enabled: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)).max(100).optional(),
  model: z.string().trim().min(1).max(200).optional(),
}).strict();
export const ardentPreviewSubmitSchema = z.object({
  prompt: z.string().trim().min(1).max(16_000),
  overrides: ardentPreviewOverridesSchema.optional(),
  session_id: guid.optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
}).strict();
export type ArdentPreviewSubmit = z.infer<typeof ardentPreviewSubmitSchema>;
/** action development-note. Needs x-acting-subject. */
export const ardentDevelopmentNoteSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
  sources: z.array(z.object({ kind: z.enum(['task', 'artifact', 'memory', 'url', 'identity', 'skill', 'note']), ref: z.string().trim().min(1).max(512) }).strict()).max(16).optional(),
  author: z.enum(['operator', 'agent']).optional(),
}).strict();
export const ardentDevelopmentRecordSchema = z.object({
  id: z.string(), agent_ref: z.string(), kind: z.string(), title: z.string(), body: z.string(),
  author: z.enum(['agent', 'operator', 'runtime']), epistemic: z.enum(['agent_reported', 'operator_reported', 'observed']),
  before_sha256: digest.nullable(), after_sha256: digest.nullable(),
  sources: z.array(z.object({ kind: z.string(), ref: z.string() })), created_at: z.string(),
});
export type ArdentDevelopmentRecord = z.infer<typeof ardentDevelopmentRecordSchema>;
export const ardentDevelopmentPageSchema = z.object({ records: z.array(ardentDevelopmentRecordSchema), next: z.string().nullable() });
/** actions task-pause and task-resume. A finished task answers 409. */
export const ardentTaskPauseStateSchema = z.object({ task_id: z.string(), state: z.string(), admission: z.enum(['open', 'paused']) });
/** Ardent artifact manifest 1.0 (key fields; Ardent adds others). */
export const ardentArtifactManifestSchema = z.looseObject({
  schema_version: z.string(), name: z.string(), mime: z.string(), sha256: digest, size: z.number().int().min(0),
  revision: z.number().int(), supersedes_sha256: digest.nullable(),
  acceptance_status: z.enum(['unreviewed', 'approved', 'partial', 'rejected']), created_at: z.number(), expires_at: z.number().optional(),
});
export type ArdentArtifactManifest = z.infer<typeof ardentArtifactManifestSchema>;
export const ardentArtifactRecordSchema = z.object({ task_id: z.string(), superseded_by_sha256: digest.nullable(), manifest: ardentArtifactManifestSchema });
export const ardentTaskArtifactsSchema = z.object({ artifacts: z.array(ardentArtifactRecordSchema) });

// Task stream events (GET …/tasks/:taskId/stream).
/** task.text: the current step's visible reply text (on connect and when a step starts). task.delta appends to it. Never replayed. */
export const ardentTaskTextEventSchema = z.object({ step: z.number().int(), text: z.string() });
/** task.event: one journal event; its SSE id is the sequence to resume after. */
export const ardentTaskJournalEventSchema = ardentTaskEventSchema;
/** task.done: the final task record. */
export const ardentTaskDoneEventSchema = z.object({ id: z.string(), state: z.string(), result: z.string().nullable().optional(), error: z.string().nullable().optional() }).loose();
export type ArdentTaskEvent = z.infer<typeof ardentTaskEventSchema>;

// New Agent (POST /ardent/agents) and its operations.
const credentialFreeUrl = (value: string) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
};
const identityText = z.string().max(131_072).refine(value => value.trim().length > 0 && utf8Length(value) <= 131_072, 'Identity text must be 1 to 128 KiB');
/** An Emberpath alias or an OpenAI-compatible endpoint and model. Never credentials. */
export const ardentAgentModelSchema = z.union([
  z.object({ emberpath_alias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/) }).strict(),
  z.object({ base_url: z.string().max(2048).refine(credentialFreeUrl, 'Expected an HTTP(S) URL without credentials, query or fragment'), model: z.string().min(1).max(200) }).strict(),
]);
export const ardentAgentDeployRequestSchema = z.object({
  nodeId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  profile: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  apiPort: z.number().int().min(1024).max(65535).optional(),
  soul_md: identityText,
  identity_md: identityText,
  model: ardentAgentModelSchema,
  skills: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(100).default([]),
  hivemem: z.literal(true),
  artifacts_max_bytes: z.number().int().min(1024).max(67_108_864).optional(),
}).strict();
export type NewAgentRequest = z.input<typeof ardentAgentDeployRequestSchema>;
export const ardentAgentStepSchema = z.object({
  name: z.string(),
  status: z.enum(['pending', 'running', 'succeeded', 'skipped', 'failed']),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  receipt: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
});
export const agentOperationSchema = z.object({
  id: z.string(),
  kind: z.enum(['deploy', 'hivemem']),
  nodeId: z.string(),
  profile: z.string(),
  status: z.enum(['running', 'succeeded', 'failed']),
  steps: z.array(ardentAgentStepSchema),
  error: z.string().nullable(),
  createdBy: z.string(),
  attempts: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
}).loose();
export type MagnusAgentOperation = z.infer<typeof agentOperationSchema>;

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
    return z.object({ events: z.array(ardentTaskEventSchema) }).parse(await this.resource(ref, `tasks/${uuid(taskId)}/events`, { ...context, query: { after } })).events;
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
    return ardentAcceptedTaskSchema.parse(await this.action(ref, 'task-submit', { body: parsed.data }, context));
  }

  async cancelTask(ref: string, taskId: string, context: CallContext = {}): Promise<unknown> {
    return this.action(ref, 'task-cancel', { target: uuid(taskId) }, context);
  }

  async memorySearch(ref: string, query: string, context: CallContext = {}): Promise<unknown> {
    return this.action(ref, 'memory-search', { body: { query } }, context);
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

  // ── Studio routes (typed locally; see the header) ──

  /** The node agent's Studio level for a node: 0 when it reports none. */
  async studioLevel(nodeId: string, context: CallContext = {}): Promise<number> {
    return (await this.getInstallation(nodeId, context)).capabilities?.studio ?? 0;
  }

  /** Open (or reopen: the same key answers the same session) an Ardent session. studio >= 1; a context needs studio >= 2. */
  async openSession(ref: string, body: z.input<typeof ardentSessionOpenSchema>, context: CallContext = {}) {
    return ardentSessionSchema.parse(await this.action(ref, 'session-open', { body: ardentSessionOpenSchema.parse(body) }, context));
  }

  /** Submit a team mission in a session opened with context mission. studio >= 2. */
  async submitMission(ref: string, body: z.input<typeof ardentMissionSubmitSchema>, context: CallContext = {}) {
    const parsed = ardentMissionSubmitSchema.safeParse(body);
    if (!parsed.success) throw new MagnusError(`Mission is invalid: ${parsed.error.issues[0]?.message ?? 'invalid'}`, 400, 'VALIDATION_ERROR');
    return ardentAcceptedTaskSchema.parse(await this.action(ref, 'mission-submit', { body: parsed.data }, context));
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
    return ardentAcceptedTaskSchema.parse(await this.action(ref, 'preview-submit', { body: ardentPreviewSubmitSchema.parse(body) }, context));
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
    return z.object({ operationId: z.string() }).parse(await this.json('POST', '/api/v1/ardent/agents', context, ardentAgentDeployRequestSchema.parse(body)));
  }

  /** Step receipts of a New Agent or Enable HiveMem operation. */
  async agentOperation(operationId: string, context: CallContext = {}) {
    return agentOperationSchema.parse(await this.json('GET', `/api/v1/ardent/agents/operations/${operationIdOf(operationId)}`, context));
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
    return z.object({ operationId: z.string() }).parse(await this.json('POST', `/api/v1/ardent/agents/operations/${operationIdOf(operationId)}/resume`, context));
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

function validated<T>(schema: z.ZodType<T>, value: unknown, action: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MagnusError(`The ${action} request is invalid: ${parsed.error.issues[0]?.message ?? 'invalid'}`, 400, 'VALIDATION_ERROR');
  return parsed.data;
}

function operationIdOf(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new MagnusError('Invalid operation ID', 400, 'VALIDATION_ERROR');
  return value;
}

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new MagnusError('Invalid Ardent task ID', 400, 'VALIDATION_ERROR');
  return value;
}
