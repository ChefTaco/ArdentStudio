// Public browser contract for the ArdentStudio API. Zod schemas only, with no server
// imports, so a static console can export, vendor and pin it. The server validates its
// own requests with these schemas, so the contract and the implementation cannot drift.
//
// Paths are relative to /api/ardentstudio/v1. Response objects strip unknown keys when
// parsed, so later releases may add fields. Errors use errorResponseSchema.
import { z } from 'zod';

export const ardentStudioBrowserContractVersion = 1;
export const ARDENT_STUDIO_API_PREFIX = '/api/ardentstudio/v1';
export const ARDENT_STUDIO_AUDIENCE = 'ardentstudio';

export const ARDENT_STUDIO_PERMISSIONS = [
  'ardentstudio:projects:read',
  'ardentstudio:projects:write',
  'ardentstudio:templates:read',
  'ardentstudio:templates:write',
  'ardentstudio:review:write',
  'ardentstudio:agents:admin',
] as const;
export const permissionSchema = z.enum(ARDENT_STUDIO_PERMISSIONS);
export type ArdentStudioPermission = z.infer<typeof permissionSchema>;

/** Every mutation sends this header. A repeated key replays the first answer; a different request with the same key is a 409. */
export const IDEMPOTENCY_HEADER = 'x-idempotency-key';
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

// ── Shared values ──
const isoDate = z.iso.datetime();
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const prefixedId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
export const projectIdSchema = prefixedId('prj');
export const requestedDeliverableIdSchema = prefixedId('req');
export const fileIdSchema = prefixedId('fil');
export const templateIdSchema = prefixedId('tpl');
export const bindingIdSchema = prefixedId('bnd');
export const teamRevisionIdSchema = prefixedId('trv');
/** A Magnus-managed Ardent profile: `<nodeId>~<profile>`, the same reference Magnus uses. */
export const agentRefSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}~[A-Za-z0-9._-]{1,128}$/);
export const roleKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
export const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const text = (max: number) => z.string().max(max);
const name = z.string().trim().min(1).max(200);
const shortList = (max: number, item = 500) => z.array(z.string().trim().min(1).max(item)).max(max);

export const errorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

// ── Projects ──
export const DELIVERABLE_FORMATS = ['md', 'txt', 'docx', 'pdf', 'svg', 'png', 'jpeg', 'webp', 'csv', 'json'] as const;
export const deliverableFormatSchema = z.enum(DELIVERABLE_FORMATS);
export const STAGES = ['create', 'research', 'discuss', 'review', 'revise', 'deliver'] as const;
export const stageSchema = z.enum(STAGES);
export const projectStatusSchema = z.enum(['active', 'archived']);
export const projectAreaSchema = z.enum(['team', 'room', 'agents', 'review']);

export const requestedDeliverableRequestSchema = z.object({
  name,
  kind: z.string().trim().min(1).max(64),
  formats: z.array(deliverableFormatSchema).min(1).max(10),
  stage: stageSchema.nullable().optional(),
  producer_role_key: roleKeySchema.nullable().optional(),
}).strict();
export const requestedDeliverableSchema = z.object({
  id: requestedDeliverableIdSchema,
  name: z.string(),
  kind: z.string(),
  formats: z.array(deliverableFormatSchema),
  stage: stageSchema.nullable(),
  producer_role_key: roleKeySchema.nullable(),
});

export const hivememStateSchema = z.enum(['pending', 'ready', 'failed']);
export const projectSchema = z.object({
  id: projectIdSchema,
  name: z.string(),
  brief_md: z.string(),
  audience: z.string().nullable(),
  constraints: z.array(z.string()),
  tags: z.array(z.string()),
  status: projectStatusSchema,
  created_by: z.string(),
  hivemem: z.object({ workspace_id: z.string(), state: hivememStateSchema, error: z.string().nullable() }),
  chattermost_channel_id: z.string().nullable(),
  last_area: projectAreaSchema.nullable(),
  deliverables: z.array(requestedDeliverableSchema),
  created_at: isoDate,
  updated_at: isoDate,
  archived_at: isoDate.nullable(),
});
export const projectSummarySchema = projectSchema.omit({ deliverables: true, brief_md: true }).extend({
  brief_excerpt: z.string(),
  file_count: z.number().int(),
  deliverable_count: z.number().int(),
  team: z.object({ revision: z.number().int().nullable(), role_count: z.number().int(), bound_count: z.number().int() }),
  /** The newest recorded project event. Never synthesized. */
  last_activity: z.object({ type: z.string(), at: isoDate }).nullable(),
});

const projectFields = {
  name,
  brief_md: text(100_000),
  audience: text(2_000).nullable(),
  constraints: shortList(50, 2_000),
  tags: shortList(20, 40),
  deliverables: z.array(requestedDeliverableRequestSchema).max(50),
};
export const createProjectRequestSchema = z.object({
  name: projectFields.name,
  brief_md: projectFields.brief_md.default(''),
  audience: projectFields.audience.default(null),
  constraints: projectFields.constraints.default([]),
  tags: projectFields.tags.default([]),
  deliverables: projectFields.deliverables.default([]),
}).strict();
export const updateProjectRequestSchema = z.object({
  name: projectFields.name.optional(),
  brief_md: projectFields.brief_md.optional(),
  audience: projectFields.audience.optional(),
  constraints: projectFields.constraints.optional(),
  tags: projectFields.tags.optional(),
  /** Replaces the whole list. Existing ids are kept for entries matched by name. */
  deliverables: projectFields.deliverables.optional(),
  last_area: projectAreaSchema.nullable().optional(),
  chattermost_channel_id: z.string().trim().min(1).max(64).nullable().optional(),
}).strict();
export const listProjectsQuerySchema = z.object({
  status: z.enum(['active', 'archived', 'all']).default('active'),
  q: z.string().trim().max(200).optional(),
});
export const listProjectsResponseSchema = z.object({ projects: z.array(projectSummarySchema) });
export const projectResponseSchema = projectSchema;

// ── Files ──
export const UPLOAD_MIME_TYPES = [
  'text/markdown', 'text/plain', 'text/csv', 'application/json', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml',
] as const;
export const uploadMimeSchema = z.enum(UPLOAD_MIME_TYPES);
export const filePurposeSchema = z.enum(['reference', 'attachment', 'avatar']);
/**
 * not_indexed: stored only (attachments, avatars). pending/indexing: queued or in flight.
 * indexed: HiveMem holds the current revision. failed: retried automatically, or by reindex.
 * unsupported: the type has no text to index yet.
 */
export const knowledgeStateSchema = z.enum(['not_indexed', 'pending', 'indexing', 'indexed', 'failed', 'unsupported']);
export const fileSchema = z.object({
  id: fileIdSchema,
  project_id: projectIdSchema,
  name: z.string(),
  mime: z.string(),
  size: z.number().int(),
  sha256: sha256Schema,
  purpose: filePurposeSchema,
  created_by: z.string(),
  created_at: isoDate,
  knowledge: z.object({
    state: knowledgeStateSchema,
    source_id: z.string().nullable(),
    revision: z.string().nullable(),
    chunks: z.number().int().nullable(),
    error: z.string().nullable(),
    attempts: z.number().int(),
    updated_at: isoDate.nullable(),
  }),
});
export const uploadFileQuerySchema = z.object({
  name: z.string().trim().min(1).max(255).refine(value => !/[/\\\0]/.test(value) && value !== '.' && value !== '..', 'Invalid file name'),
  purpose: filePurposeSchema.default('reference'),
});
export const listFilesQuerySchema = z.object({ purpose: filePurposeSchema.optional() });
export const listFilesResponseSchema = z.object({ files: z.array(fileSchema) });
export const fileResponseSchema = fileSchema;

// ── Templates ──
export const skillRefSchema = z.object({
  kind: z.enum(['local', 'hiveskills']),
  ref: z.string().regex(/^[A-Za-z0-9_.:/-]{1,128}$/),
  channel: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
}).strict();
export const avatarPresetSchema = z.object({
  preset: z.string().regex(/^[a-z0-9-]{1,40}$/),
  accent: z.string().regex(/^[a-z0-9-]{1,40}$/),
  emblem: z.string().regex(/^[a-z0-9-]{1,40}$/),
}).strict();
export const integrationSchema = z.enum(['hivemem', 'hiveskills', 'emberpath']);
export const runtimeRequirementSchema = z.object({
  ardent: z.string().max(40).nullable(),
  backend: z.enum(['llamacpp', 'codex', 'any']),
}).strict();
export const templateRefSchema = z.object({ template_id: templateIdSchema, version: z.number().int().min(1) }).strict();

export const agentTemplateBodySchema = z.object({
  name,
  category: z.string().trim().min(1).max(64),
  purpose: text(2_000),
  example_uses: shortList(20),
  soul_md: text(65_536),
  identity_md: text(65_536),
  skills: z.array(skillRefSchema).max(50),
  /** An Emberpath alias or a model name. Never a URL with credentials or a key. */
  model_hint: z.string().max(200).nullable(),
  runtime_req: runtimeRequirementSchema,
  integrations: z.array(integrationSchema).max(3),
  expected_outputs: shortList(20),
  avatar_preset: avatarPresetSchema,
}).strict();

export const RELATIONSHIP_TYPES = ['reports_to', 'delegates_to', 'hands_off_to', 'reviews'] as const;
export const relationshipTypeSchema = z.enum(RELATIONSHIP_TYPES);
export const relationshipSchema = z.object({
  from: roleKeySchema,
  to: roleKeySchema,
  type: relationshipTypeSchema,
  /** On hands_off_to, `revise` marks the one loop a workflow may contain. */
  stage: stageSchema.nullable().optional(),
  label: z.string().max(120).optional(),
}).strict();

const roleFields = {
  key: roleKeySchema,
  name,
  coordinator: z.boolean(),
  responsibilities_md: text(20_000),
  instructions_md: text(20_000),
  contributions: shortList(30),
  deliverables: shortList(30, 200),
  agent_template_ref: templateRefSchema.nullable(),
  skills: z.array(skillRefSchema).max(50),
  stage: stageSchema.nullable(),
};
export const templateRoleSchema = z.object(roleFields).strict();
export const teamTemplateBodySchema = z.object({
  name,
  category: z.string().trim().min(1).max(64),
  purpose: text(2_000),
  example_uses: shortList(20),
  roles: z.array(templateRoleSchema).min(1).max(30),
  relationships: z.array(relationshipSchema).max(200),
  stages: z.array(stageSchema).max(STAGES.length),
  integrations: z.array(integrationSchema).max(3),
  runtime_req: runtimeRequirementSchema,
}).strict();

export const templateKindSchema = z.enum(['agent', 'team']);
export const templateSourceSchema = z.enum(['seed', 'user']);
export const templateSummarySchema = z.object({
  id: templateIdSchema,
  kind: templateKindSchema,
  slug: slugSchema,
  source: templateSourceSchema,
  archived: z.boolean(),
  name: z.string(),
  category: z.string(),
  purpose: z.string(),
  latest_version: z.number().int(),
  /** Projects whose current or draft team pins any version of this template. */
  used_by: z.number().int(),
  created_at: isoDate,
  updated_at: isoDate,
});
export const templateVersionSummarySchema = z.object({
  version: z.number().int(),
  changelog: z.string(),
  created_by: z.string(),
  created_at: isoDate,
});
const versionFields = {
  template_id: templateIdSchema,
  version: z.number().int(),
  changelog: z.string(),
  created_by: z.string(),
  created_at: isoDate,
};
export const agentTemplateVersionSchema = z.object({ ...versionFields, kind: z.literal('agent'), body: agentTemplateBodySchema });
export const teamTemplateVersionSchema = z.object({ ...versionFields, kind: z.literal('team'), body: teamTemplateBodySchema });
export const templateVersionSchema = z.discriminatedUnion('kind', [agentTemplateVersionSchema, teamTemplateVersionSchema]);
export const templateDetailSchema = templateSummarySchema.extend({
  versions: z.array(templateVersionSummarySchema),
  latest: templateVersionSchema,
});
export const listTemplatesQuerySchema = z.object({
  kind: templateKindSchema.optional(),
  source: templateSourceSchema.optional(),
  archived: z.enum(['true', 'false', 'all']).default('false'),
  q: z.string().trim().max(200).optional(),
});
export const listTemplatesResponseSchema = z.object({ templates: z.array(templateSummarySchema) });
export const createTemplateRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), slug: slugSchema.optional(), changelog: text(2_000).default('Initial version'), body: agentTemplateBodySchema }).strict(),
  z.object({ kind: z.literal('team'), slug: slugSchema.optional(), changelog: text(2_000).default('Initial version'), body: teamTemplateBodySchema }).strict(),
]);
export const createTemplateVersionRequestSchema = z.object({
  /** The latest version this edit was based on. A newer version answers 409. */
  base_version: z.number().int().min(1),
  changelog: z.string().trim().min(1).max(2_000),
  body: z.union([agentTemplateBodySchema, teamTemplateBodySchema]),
}).strict();
export const archiveTemplateRequestSchema = z.object({ archived: z.boolean().default(true) }).strict();

// ── Team assignment ──
export const teamDraftRoleSchema = z.object({
  ...roleFields,
  agent_ref: agentRefSchema.nullable().default(null),
  /** Project files this role should know about. */
  knowledge: z.array(fileIdSchema).max(100).default([]),
}).strict();
export const assignmentRoleSchema = z.object({
  ...roleFields,
  agent_ref: agentRefSchema.nullable(),
  binding_id: bindingIdSchema.nullable(),
  knowledge: z.array(fileIdSchema),
});
export const teamDraftBodySchema = z.object({
  roles: z.array(teamDraftRoleSchema).max(30),
  relationships: z.array(relationshipSchema).max(200),
  stages: z.array(stageSchema).max(STAGES.length).default([]),
}).strict();
export const teamBodySchema = z.object({
  roles: z.array(assignmentRoleSchema),
  relationships: z.array(relationshipSchema),
  stages: z.array(stageSchema),
});
export const teamRevisionStatusSchema = z.enum(['draft', 'published', 'superseded']);
export const teamRevisionSchema = z.object({
  id: teamRevisionIdSchema,
  project_id: projectIdSchema,
  revision: z.number().int(),
  status: teamRevisionStatusSchema,
  source_template: templateRefSchema.nullable(),
  body: teamBodySchema,
  created_by: z.string(),
  created_at: isoDate,
  updated_at: isoDate,
  published_by: z.string().nullable(),
  published_at: isoDate.nullable(),
});
export const VALIDATION_CODES = [
  'coordinator_count', 'reporting_cycle', 'workflow_cycle', 'deliverable_without_producer',
  'duplicate_role_key', 'unknown_role', 'self_relationship', 'multiple_managers', 'coordinator_reports',
  'unbound_role', 'reviewer_is_only_producer', 'skill_not_enabled', 'agent_unavailable', 'agent_without_hivemem',
  'outside_reporting_tree', 'agent_facts_unavailable',
] as const;
export const validationIssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.enum(VALIDATION_CODES),
  message: z.string(),
  role_key: z.string().optional(),
  relationship_index: z.number().int().optional(),
  deliverable: z.string().optional(),
});
export const validationResultSchema = z.object({
  issues: z.array(validationIssueSchema),
  /** No errors. */
  can_publish: z.boolean(),
  /** No errors, and the coordinator is bound to an available agent. */
  can_start_room: z.boolean(),
  /** Whether agent availability, skills and HiveMem could be checked through Magnus. */
  agent_facts: z.enum(['complete', 'partial', 'unavailable']),
});
export const teamStateSchema = z.object({
  current: teamRevisionSchema.nullable(),
  draft: teamRevisionSchema.nullable(),
  /** Validation of the draft when there is one, else of the current revision. */
  validation: validationResultSchema.nullable(),
});
export const putTeamDraftRequestSchema = z.object({
  /** The published revision this draft builds on (null before the first publish). A newer published revision answers 409. */
  base_revision: z.number().int().min(1).nullable(),
  source_template: templateRefSchema.nullable().optional(),
  body: teamDraftBodySchema,
}).strict();
export const validateTeamRequestSchema = z.object({ body: teamDraftBodySchema.optional() }).strict();
export const publishTeamRequestSchema = z.object({ draft_revision: z.number().int().min(1) }).strict();
export const applyTemplateRequestSchema = z.object({
  template_id: templateIdSchema,
  version: z.number().int().min(1),
  /** Required to overwrite an existing draft. */
  replace_draft: z.boolean().default(false),
}).strict();
export const saveAsTemplateRequestSchema = z.object({
  from: z.enum(['draft', 'current']).default('current'),
  /** Save as a new version of this user team template instead of a new template. */
  template_id: templateIdSchema.optional(),
  base_version: z.number().int().min(1).optional(),
  slug: slugSchema.optional(),
  name,
  category: z.string().trim().min(1).max(64).default('custom'),
  purpose: text(2_000).default(''),
  changelog: z.string().trim().min(1).max(2_000).default('Saved from a project team'),
}).strict();

// ── Agents (through Magnus) ──
export const agentSchema = z.object({
  agent_ref: agentRefSchema,
  node_id: z.string(),
  node_name: z.string(),
  profile: z.string(),
  backend: z.enum(['llamacpp', 'codex']).nullable(),
  running: z.boolean(),
  reachable: z.boolean(),
  /** Running on a reachable node without a reported error. */
  available: z.boolean(),
  installation_version: z.string().nullable(),
  error: z.string().nullable(),
  /** Studio presentation name, else the cached binding name, else the profile ID. */
  display_name: z.string(),
  portrait: avatarPresetSchema.nullable(),
  binding_id: bindingIdSchema.nullable(),
  roles: z.array(z.object({ project_id: projectIdSchema, project_name: z.string(), role_key: z.string(), role_name: z.string() })),
});
export const listAgentsResponseSchema = z.object({
  agents: z.array(agentSchema),
  available_count: z.number().int(),
  magnus: z.object({ state: z.enum(['ok', 'unavailable']), error: z.string().nullable() }),
});

// ── Project snapshot and stream ──
export const snapshotResponseSchema = z.object({
  /** The stream cursor this snapshot is consistent with: reconnect with ?after=<seq>. */
  seq: z.number().int(),
  project: projectSchema,
  files: z.array(fileSchema),
  team: teamStateSchema,
});
export const streamQuerySchema = z.object({ after: z.string().regex(/^\d{1,15}$/).optional() });
export const PROJECT_EVENT_TYPES = [
  'project.created', 'project.updated', 'project.archived', 'project.reopened',
  'file.created', 'file.updated',
  'team.draft.updated', 'team.revision.published',
  'layout.updated', 'conversation.created', 'conversation.updated', 'message.created', 'message.updated',
  'presence.updated', 'task.created', 'task.updated', 'decision.created', 'decision.updated',
  'deliverable.revision.created', 'review.comment.created', 'review.comment.updated', 'review.decision.created',
  'export.created', 'agent.operation.updated',
] as const;
export const projectEventTypeSchema = z.enum(PROJECT_EVENT_TYPES);
/** A persisted event. The SSE `id` is its seq. */
export const projectEventSchema = z.object({
  seq: z.number().int(),
  project_id: projectIdSchema,
  type: projectEventTypeSchema,
  at: isoDate,
  payload: z.record(z.string(), z.unknown()),
});
export const resetEventSchema = z.object({ seq: z.number().int(), reason: z.enum(['cursor_expired', 'cursor_ahead']) });
export const heartbeatEventSchema = z.object({ seq: z.number().int(), at: isoDate });
export const messageDeltaEventSchema = z.object({ message_id: z.string(), text: z.string() });

// ── Health ──
const checkSchema = z.object({ status: z.enum(['ok', 'unavailable']), error: z.string().nullable() });
export const liveResponseSchema = z.object({ status: z.literal('ok') });
export const readyResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({
    database: checkSchema,
    magnus: checkSchema,
    hivemem: checkSchema,
    agents: z.object({ status: z.enum(['ok', 'unavailable']), available: z.number().int() }),
  }),
});

// ── Route table ──
export interface ArdentStudioBrowserRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Relative to ARDENT_STUDIO_API_PREFIX, with `{name}` for each path parameter. */
  path: string;
  query?: z.ZodType;
  /** `raw` routes take the request body as bytes, with its MIME type in Content-Type. */
  requestBody?: 'json' | 'raw';
  request?: z.ZodType;
  /** The success body. Null for a stream or a binary download. */
  response: z.ZodType | null;
  /** Every listed permission is required. An empty list means no authentication. */
  permissions: readonly ArdentStudioPermission[];
  /** The route requires the x-idempotency-key header. */
  idempotent: boolean;
  successStatus?: 201;
  /** Server-sent event payloads by event name. Read with fetch: EventSource cannot send the bearer token. */
  events?: Readonly<Record<string, z.ZodType>>;
  note?: string;
}

const READ = ['ardentstudio:projects:read'] as const;
const WRITE = ['ardentstudio:projects:write'] as const;
const TEMPLATES_READ = ['ardentstudio:templates:read'] as const;
const TEMPLATES_WRITE = ['ardentstudio:templates:write'] as const;

export const ardentStudioBrowserRoutes: readonly ArdentStudioBrowserRoute[] = [
  // Health
  { method: 'GET', path: '/health/live', response: liveResponseSchema, permissions: [], idempotent: false },
  { method: 'GET', path: '/health/ready', response: readyResponseSchema, permissions: [], idempotent: false, note: 'Answers 503 with the same body when not ready. Checks are cached for 10 seconds.' },

  // Projects
  { method: 'GET', path: '/projects', query: listProjectsQuerySchema, response: listProjectsResponseSchema, permissions: READ, idempotent: false, note: 'q matches name, brief and tags.' },
  { method: 'POST', path: '/projects', requestBody: 'json', request: createProjectRequestSchema, response: projectResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'Creates the project HiveMem workspace; when HiveMem is unavailable hivemem.state stays pending and is retried.' },
  { method: 'GET', path: '/projects/{projectId}', response: projectResponseSchema, permissions: READ, idempotent: false },
  { method: 'PATCH', path: '/projects/{projectId}', requestBody: 'json', request: updateProjectRequestSchema, response: projectResponseSchema, permissions: WRITE, idempotent: true, note: 'An archived project is read-only (409) except last_area.' },
  { method: 'POST', path: '/projects/{projectId}/archive', response: projectResponseSchema, permissions: WRITE, idempotent: true, note: '409 with details.tasks while Studio tasks are still active.' },
  { method: 'POST', path: '/projects/{projectId}/reopen', response: projectResponseSchema, permissions: WRITE, idempotent: true },
  { method: 'GET', path: '/projects/{projectId}/snapshot', response: snapshotResponseSchema, permissions: READ, idempotent: false },

  // Files
  { method: 'POST', path: '/projects/{projectId}/files', query: uploadFileQuerySchema, requestBody: 'raw', response: fileResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'Raw body up to ARDENT_STUDIO_MAX_BLOB_BYTES (default 64 MiB) with an allowed Content-Type (UPLOAD_MIME_TYPES). References are indexed into the project HiveMem workspace.' },
  { method: 'GET', path: '/projects/{projectId}/files', query: listFilesQuerySchema, response: listFilesResponseSchema, permissions: READ, idempotent: false },
  { method: 'GET', path: '/blobs/{sha256}', response: null, permissions: READ, idempotent: false, note: 'Bytes as application/octet-stream with Content-Disposition attachment; the recorded type is in X-Blob-Mime. Only blobs that a project file references are served.' },
  { method: 'POST', path: '/files/{fileId}/reindex', response: fileResponseSchema, permissions: WRITE, idempotent: true, note: 'Queues the file for HiveMem sync again.' },

  // Templates
  { method: 'GET', path: '/templates', query: listTemplatesQuerySchema, response: listTemplatesResponseSchema, permissions: TEMPLATES_READ, idempotent: false },
  { method: 'GET', path: '/templates/{templateId}', response: templateDetailSchema, permissions: TEMPLATES_READ, idempotent: false },
  { method: 'GET', path: '/templates/{templateId}/versions/{version}', response: templateVersionSchema, permissions: TEMPLATES_READ, idempotent: false },
  { method: 'POST', path: '/templates', requestBody: 'json', request: createTemplateRequestSchema, response: templateDetailSchema, permissions: TEMPLATES_WRITE, idempotent: true, successStatus: 201, note: 'Templates never carry secrets; values that look like credentials are rejected.' },
  { method: 'POST', path: '/templates/{templateId}/versions', requestBody: 'json', request: createTemplateVersionRequestSchema, response: templateDetailSchema, permissions: TEMPLATES_WRITE, idempotent: true, successStatus: 201, note: 'Versions are immutable. 409 when base_version is not the latest.' },
  { method: 'POST', path: '/templates/{templateId}/archive', requestBody: 'json', request: archiveTemplateRequestSchema, response: templateDetailSchema, permissions: TEMPLATES_WRITE, idempotent: true },

  // Team assignment
  { method: 'GET', path: '/projects/{projectId}/team', response: teamStateSchema, permissions: READ, idempotent: false },
  { method: 'PUT', path: '/projects/{projectId}/team/draft', requestBody: 'json', request: putTeamDraftRequestSchema, response: teamStateSchema, permissions: WRITE, idempotent: true },
  { method: 'POST', path: '/projects/{projectId}/team/validate', requestBody: 'json', request: validateTeamRequestSchema, response: validationResultSchema, permissions: READ, idempotent: false, note: 'Validates the given body, else the draft, else the current revision. No side effects.' },
  { method: 'POST', path: '/projects/{projectId}/team/publish', requestBody: 'json', request: publishTeamRequestSchema, response: teamStateSchema, permissions: WRITE, idempotent: true, note: '409 with details.validation when the draft has errors.' },
  { method: 'POST', path: '/projects/{projectId}/team/apply-template', requestBody: 'json', request: applyTemplateRequestSchema, response: teamStateSchema, permissions: WRITE, idempotent: true },
  { method: 'POST', path: '/projects/{projectId}/team/save-as-template', requestBody: 'json', request: saveAsTemplateRequestSchema, response: templateDetailSchema, permissions: ['ardentstudio:projects:read', 'ardentstudio:templates:write'], idempotent: true, successStatus: 201, note: 'Bindings and knowledge are not copied.' },

  // Agents
  { method: 'GET', path: '/agents', response: listAgentsResponseSchema, permissions: READ, idempotent: false, note: 'Magnus-managed Ardent profiles. When Magnus is unavailable the list is empty and magnus.state says so.' },

  // Stream
  {
    method: 'GET', path: '/projects/{projectId}/stream', query: streamQuerySchema, response: null, permissions: READ, idempotent: false,
    events: { '*': projectEventSchema, reset: resetEventSchema, heartbeat: heartbeatEventSchema, 'message.delta': messageDeltaEventSchema },
    note: 'Persisted events carry their seq as the SSE id and replay after ?after=. reset means the cursor is older than retained events (or ahead of them): refetch the snapshot. heartbeat every 15 s. The stream closes when the token expires or its session ends; reconnect with a fresh token.',
  },
];
