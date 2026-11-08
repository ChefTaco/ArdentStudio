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
export const conversationIdSchema = prefixedId('cnv');
export const messageIdSchema = prefixedId('msg');
export const taskIdSchema = prefixedId('tsk');
export const decisionIdSchema = prefixedId('dec');
export const deliverableIdSchema = prefixedId('dlv');
export const revisionIdSchema = prefixedId('drv');
export const commentIdSchema = prefixedId('cmt');
export const reviewDecisionIdSchema = prefixedId('rvd');
export const exportIdSchema = prefixedId('exp');
export const linkIdSchema = prefixedId('lnk');
export const teamProposalIdSchema = prefixedId('prp');
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
/**
 * The newest meaningful project record: a room message, a pinned decision, a received or reviewed
 * revision, an added reference or link, a published team, an export, or the project's creation or
 * archiving. type is the matching event type; text is a one-line description built from that
 * record only. Presence, sync progress and other bookkeeping do not count.
 */
export const lastActivitySchema = z.object({ type: z.string(), at: isoDate, text: z.string() });
/** Counts derived from stored records. A change is announced as project.updated with fields ["counts"]. */
export const projectCountsSchema = z.object({
  /** Agent clarifications nobody has answered yet. */
  open_questions: z.number().int(),
  /** Deliverable revisions waiting for a person: unreviewed, or changes requested and no new revision yet. */
  review_pending: z.number().int(),
  /** Studio tasks in an active state (queued, running, input_required, pausing, paused). */
  active_tasks: z.number().int(),
});
export const projectSummarySchema = projectSchema.omit({ deliverables: true, brief_md: true }).extend({
  brief_excerpt: z.string(),
  file_count: z.number().int(),
  link_count: z.number().int(),
  deliverable_count: z.number().int(),
  team: z.object({ revision: z.number().int().nullable(), role_count: z.number().int(), bound_count: z.number().int() }),
  ...projectCountsSchema.shape,
  /** Never synthesized; null only when the project has no such record. */
  last_activity: lastActivitySchema.nullable(),
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
  /** true: only projects with review_pending > 0. */
  needs_review: z.enum(['true', 'false']).optional(),
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
/** A file's or link's HiveMem sync state. source_id is the HiveMem source; revision the synced content digest. */
export const knowledgeSyncSchema = z.object({
  state: knowledgeStateSchema,
  source_id: z.string().nullable(),
  revision: z.string().nullable(),
  chunks: z.number().int().nullable(),
  error: z.string().nullable(),
  attempts: z.number().int(),
  updated_at: isoDate.nullable(),
});
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
  knowledge: knowledgeSyncSchema,
});
export const uploadFileQuerySchema = z.object({
  name: z.string().trim().min(1).max(255).refine(value => !/[/\\\0]/.test(value) && value !== '.' && value !== '..', 'Invalid file name'),
  purpose: filePurposeSchema.default('reference'),
});
export const listFilesQuerySchema = z.object({ purpose: filePurposeSchema.optional() });
export const listFilesResponseSchema = z.object({ files: z.array(fileSchema) });
export const fileResponseSchema = fileSchema;

// ── Reference links ──
/** An http or https URL without user name or password. Studio stores it; it never fetches it. */
export function isReferenceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
const referenceUrl = z.string().trim().min(1).max(2048).refine(isReferenceUrl, 'Expected an http or https URL without a user name or password');
/**
 * A link reference. Its title, URL and note are synced to the project HiveMem workspace as a
 * knowledge source (source_uri is the URL); the linked page itself is not fetched or indexed.
 */
export const referenceLinkSchema = z.object({
  id: linkIdSchema,
  project_id: projectIdSchema,
  /** Normalized (WHATWG URL serialization). */
  url: z.string(),
  title: z.string(),
  note_md: z.string(),
  created_by: z.string(),
  created_at: isoDate,
  updated_at: isoDate,
  /** Set when the link was removed; its HiveMem source is retired. */
  deleted_at: isoDate.nullable(),
  knowledge: knowledgeSyncSchema,
});
export const createLinkRequestSchema = z.object({
  url: referenceUrl,
  title: z.string().trim().min(1).max(200),
  note_md: text(4_000).default(''),
}).strict();
export const updateLinkRequestSchema = z.object({
  url: referenceUrl.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  note_md: text(4_000).optional(),
}).strict();
export const listLinksResponseSchema = z.object({ links: z.array(referenceLinkSchema) });
export const linkResponseSchema = referenceLinkSchema;

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

// ── Team proposals ──
/** A role an agent proposes. Optional fields default as shown, so a draft can be built from it. */
export const teamProposalRoleSchema = z.object({
  key: roleKeySchema,
  name,
  coordinator: z.boolean().default(false),
  responsibilities_md: text(20_000).default(''),
  instructions_md: text(20_000).default(''),
  contributions: shortList(30).default([]),
  deliverables: shortList(30, 200).default([]),
  agent_template_ref: templateRefSchema.nullable().default(null),
  skills: z.array(skillRefSchema).max(50).default([]),
  stage: stageSchema.nullable().default(null),
  /** Why the role is on the team. */
  rationale: text(2_000).default(''),
});
export const teamProposalRelationshipSchema = z.object({
  from: roleKeySchema,
  to: roleKeySchema,
  type: relationshipTypeSchema,
  stage: stageSchema.nullable().optional(),
  label: z.string().max(120).optional(),
});
/** A suggestion only: a person binds roles. agent_ref is one of the agents the request listed. */
export const teamProposalBindingSchema = z.object({ role_key: roleKeySchema, agent_ref: agentRefSchema, reason: text(1_000).default('') });
/**
 * The JSON an agent must answer a team_proposal task with. Besides the field rules: role keys are
 * unique, exactly one role is the coordinator, relationships and bindings name proposed roles, a
 * role has at most one binding, and a relationship never points at its own role.
 */
export const teamProposalSchema = z.object({
  rationale: text(4_000).default(''),
  /** The team template the proposal started from, if any. */
  source_template: templateRefSchema.nullable().default(null),
  roles: z.array(teamProposalRoleSchema).min(1).max(30),
  relationships: z.array(teamProposalRelationshipSchema).max(200).default([]),
  stages: z.array(stageSchema).max(STAGES.length).default([]),
  bindings: z.array(teamProposalBindingSchema).max(30).default([]),
}).superRefine((value, context) => {
  const keys = new Set<string>();
  value.roles.forEach((role, index) => {
    if (keys.has(role.key)) context.addIssue({ code: 'custom', path: ['roles', index, 'key'], message: `Duplicate role key "${role.key}"` });
    keys.add(role.key);
  });
  const coordinators = value.roles.filter(role => role.coordinator).length;
  if (coordinators !== 1) context.addIssue({ code: 'custom', path: ['roles'], message: `Exactly one role must be the coordinator (found ${coordinators})` });
  value.relationships.forEach((edge, index) => {
    for (const end of ['from', 'to'] as const) {
      if (!keys.has(edge[end])) context.addIssue({ code: 'custom', path: ['relationships', index, end], message: `Unknown role "${edge[end]}"` });
    }
    if (edge.from === edge.to) context.addIssue({ code: 'custom', path: ['relationships', index], message: 'A relationship cannot point at its own role' });
  });
  const bound = new Set<string>();
  value.bindings.forEach((binding, index) => {
    if (!keys.has(binding.role_key)) context.addIssue({ code: 'custom', path: ['bindings', index, 'role_key'], message: `Unknown role "${binding.role_key}"` });
    if (bound.has(binding.role_key)) context.addIssue({ code: 'custom', path: ['bindings', index, 'role_key'], message: `Role "${binding.role_key}" has more than one binding` });
    bound.add(binding.role_key);
  });
});
/** queued: waiting for the agent (also between attempts); running: the agent is working; ready: a valid proposal; failed and cancelled are final. */
export const teamProposalStateSchema = z.enum(['queued', 'running', 'ready', 'failed', 'cancelled']);
export const teamProposalAttemptSchema = z.object({
  attempt: z.number().int(),
  task_id: taskIdSchema,
  /** pending: not answered yet; invalid: the reply failed validation (error says how). */
  outcome: z.enum(['pending', 'valid', 'invalid', 'failed', 'cancelled']),
  error: z.string().nullable(),
});
export const teamProposalRecordSchema = z.object({
  id: teamProposalIdSchema,
  project_id: projectIdSchema,
  /** The agent asked: the chosen agent, else the bound coordinator. */
  agent_ref: agentRefSchema,
  /** The role that agent holds in the team the proposal was based on, if any. */
  role_key: z.string().nullable(),
  state: teamProposalStateSchema,
  /** One line from real records: the agent's progress, a retry and why, or the outcome. */
  progress: z.string().nullable(),
  /** The current attempt's Studio task (mode team_proposal). Cancel it to cancel the proposal. */
  task_id: taskIdSchema.nullable(),
  /** At most two: one retry after an invalid reply. */
  attempts: z.array(teamProposalAttemptSchema),
  /** The team the proposal was asked against. Compare with the current team before applying. */
  basis: z.object({ current_revision: z.number().int().nullable(), draft_revision: z.number().int().nullable(), source_template: templateRefSchema.nullable() }),
  /** The validated proposal when state is ready. */
  proposal: teamProposalSchema.nullable(),
  /**
   * The proposal as a team draft body: suggested bindings filled in, knowledge kept for roles whose
   * key matches the basis team. Nothing is applied: a person sends (parts of) it with PUT team/draft.
   */
  draft_body: teamDraftBodySchema.nullable(),
  error: z.string().nullable(),
  created_by: z.string(),
  created_at: isoDate,
  updated_at: isoDate,
  finished_at: isoDate.nullable(),
});
export const proposeTeamRequestSchema = z.object({
  /** Ask this agent instead of the bound coordinator of the draft (else current) team. */
  agent_ref: agentRefSchema.optional(),
}).strict();
export const teamProposalResponseSchema = teamProposalRecordSchema;
export const listTeamProposalsResponseSchema = z.object({ proposals: z.array(teamProposalRecordSchema) });

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


// ── Room: layout, conversations, messages ──
export const seatSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  kind: z.enum(['desk', 'discussion', 'review', 'shelf', 'wall']),
  x: z.number().min(-1000).max(1000),
  y: z.number().min(-1000).max(1000),
}).strict();
export const placementSchema = z.object({ role_key: roleKeySchema, seat_id: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict();
export const roomLayoutSchema = z.object({
  project_id: projectIdSchema,
  revision: z.number().int(),
  seats: z.array(seatSchema),
  placements: z.array(placementSchema),
  zone_labels: z.record(z.string(), z.string()),
  created_by: z.string(),
  created_at: isoDate,
});
export const layoutResponseSchema = z.object({ layout: roomLayoutSchema.nullable() });
export const putLayoutRequestSchema = z.object({
  /** The revision this edit was based on (null for the first). A newer revision answers 409. */
  base_revision: z.number().int().min(1).nullable(),
  seats: z.array(seatSchema).max(64),
  placements: z.array(placementSchema).max(64),
  zone_labels: z.record(z.string().regex(/^[a-z0-9-]{1,40}$/), z.string().trim().max(60)).refine(value => Object.keys(value).length <= 32, 'At most 32 zone labels').default({}),
}).strict();

export const conversationKindSchema = z.enum(['team', 'direct', 'discussion']);
export const desiredOutputSchema = z.enum(['decision', 'short_doc', 'options']);
/** running: rounds in progress; summarizing: the coordinator summary; stopped by a person; done. */
export const discussionStateSchema = z.enum(['running', 'summarizing', 'stopped', 'done']);
export const discussionSchema = z.object({
  question: z.string(),
  desired_output: desiredOutputSchema,
  participants: z.array(roleKeySchema),
  max_rounds: z.number().int(),
  round: z.number().int(),
  state: discussionStateSchema,
});
export const conversationSchema = z.object({
  id: conversationIdSchema,
  project_id: projectIdSchema,
  kind: conversationKindSchema,
  parent_id: conversationIdSchema.nullable(),
  title: z.string(),
  /** The role a direct conversation talks to. */
  role_key: roleKeySchema.nullable(),
  discussion: discussionSchema.nullable(),
  /** Project message seq of the newest message. */
  last_message_seq: z.number().int(),
  created_by: z.string(),
  created_at: isoDate,
  updated_at: isoDate,
  stopped_at: isoDate.nullable(),
});
const conversationTitle = z.string().trim().min(1).max(200);
export const createConversationRequestSchema = z.discriminatedUnion('kind', [
  /** There is one team conversation per project; creating it again answers the existing one. */
  z.object({ kind: z.literal('team'), title: conversationTitle.optional() }).strict(),
  z.object({ kind: z.literal('direct'), role_key: roleKeySchema, title: conversationTitle.optional() }).strict(),
  z.object({
    kind: z.literal('discussion'),
    title: conversationTitle.optional(),
    parent_id: conversationIdSchema.optional(),
    question: z.string().trim().min(1).max(4_000),
    desired_output: desiredOutputSchema,
    participants: z.array(roleKeySchema).min(1).max(8).refine(value => new Set(value).size === value.length, 'Duplicate participant'),
    max_rounds: z.number().int().min(1).max(4).default(2),
  }).strict(),
]);
export const listConversationsResponseSchema = z.object({ conversations: z.array(conversationSchema) });
export const conversationResponseSchema = conversationSchema;

export const messageAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), user_id: z.string() }),
  z.object({ kind: z.literal('agent'), binding_id: bindingIdSchema, role_key: z.string().nullable() }),
  z.object({ kind: z.literal('system') }),
]);
export const messageStateSchema = z.enum(['streaming', 'complete', 'failed']);
/**
 * kind: message (a person), reply (an agent's turn), summary (a discussion summary), clarification
 * (an agent's question; links.question, links.options, links.answer_message_id), answer,
 * decision_proposal (links.proposal, links.decision_id), handoff (links.handoff), discussion_question
 * and system (Studio notes such as a refused hand-off). links.task_id names the Studio task.
 */
export const messageSchema = z.object({
  id: messageIdSchema,
  project_id: projectIdSchema,
  conversation_id: conversationIdSchema,
  /** Per project, so the whole transcript has one order. */
  seq: z.number().int(),
  author: messageAuthorSchema,
  /** Role keys. */
  addressees: z.array(z.string()),
  reply_to: messageIdSchema.nullable(),
  thread_root: messageIdSchema.nullable(),
  kind: z.string(),
  /** Final text. While state is streaming, live text arrives as message.delta on the project stream. */
  body_md: z.string(),
  attachments: z.array(fileIdSchema),
  links: z.record(z.string(), z.unknown()),
  ardent: z.object({ task_id: z.string(), session_id: z.string().nullable() }).nullable(),
  state: messageStateSchema,
  created_at: isoDate,
  updated_at: isoDate,
});
export const listMessagesQuerySchema = z.object({
  after: z.string().regex(/^\d{1,15}$/).optional(),
  limit: z.string().regex(/^\d{1,3}$/).optional(),
});
export const listMessagesResponseSchema = z.object({
  messages: z.array(messageSchema),
  /** Pass as ?after= for the next page; null when this page reached the end. */
  next_after: z.number().int().nullable(),
});
export const recipientSchema = z.discriminatedUnion('kind', [
  /** Team and Coordinator start a coordinator turn (unless the text @mentions roles). */
  z.object({ kind: z.literal('team') }).strict(),
  z.object({ kind: z.literal('coordinator') }).strict(),
  /** One turn per role, in this order. */
  z.object({ kind: z.literal('roles'), roles: z.array(roleKeySchema).min(1).max(10) }).strict(),
]);
export const postMessageRequestSchema = z.object({
  body_md: z.string().trim().min(1).max(20_000),
  to: recipientSchema.default({ kind: 'team' }),
  reply_to: messageIdSchema.optional(),
  thread_root: messageIdSchema.optional(),
  /** Project files to attach. Text files are given to the agents as context. */
  attachments: z.array(fileIdSchema).max(10).default([]),
}).strict();

// ── Tasks ──
export const TASK_MODES = ['turn', 'assignment', 'discussion_turn', 'revision', 'review', 'team_proposal'] as const;
export const taskModeSchema = z.enum(TASK_MODES);
/** The Ardent state mirrored, plus pausing (requested, not yet at a step boundary). input_required waits for a person's answer. */
export const taskStateSchema = z.enum(['queued', 'running', 'input_required', 'pausing', 'paused', 'completed', 'partial', 'failed', 'cancelled', 'unknown']);
export const taskSchema = z.object({
  id: taskIdSchema,
  project_id: projectIdSchema,
  title: z.string(),
  mode: taskModeSchema,
  role_key: z.string().nullable(),
  binding_id: bindingIdSchema.nullable(),
  /** The published team revision whose rules apply to this task. */
  assignment_revision: z.number().int().nullable(),
  conversation_id: conversationIdSchema.nullable(),
  trigger_message_id: messageIdSchema.nullable(),
  instructions_md: z.string(),
  source: z.record(z.string(), z.unknown()),
  state: taskStateSchema,
  /** mission: an Ardent 2.2.0 team mission; turn: a task-submit with a composed prompt (older agents). Null until Ardent accepts it. */
  dispatch: z.enum(['mission', 'turn']).nullable(),
  ardent: z.object({ agent_ref: z.string().nullable(), task_id: z.string().nullable(), session_id: z.string().nullable() }),
  outcome: z.unknown(),
  reassigned_from: taskIdSchema.nullable(),
  /** Tasks in one ordering group start one after another. */
  group_id: z.string().nullable(),
  group_position: z.number().int(),
  created_by: z.string(),
  created_at: isoDate,
  updated_at: isoDate,
  finished_at: isoDate.nullable(),
});
export const listTasksQuerySchema = z.object({
  state: z.enum(['active', 'finished', 'all']).default('all'),
  conversation_id: conversationIdSchema.optional(),
});
export const listTasksResponseSchema = z.object({ tasks: z.array(taskSchema) });
export const createTaskRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  instructions_md: z.string().max(20_000).default(''),
  role_key: roleKeySchema,
  mode: z.enum(['assignment', 'review']).default('assignment'),
  /** Where the reply goes: this conversation, the source message's, else the team conversation. */
  conversation_id: conversationIdSchema.optional(),
  source_message_id: messageIdSchema.optional(),
}).strict();
export const reassignTaskRequestSchema = z.object({ role_key: roleKeySchema }).strict();
export const taskResponseSchema = taskSchema;
export const postMessageResponseSchema = z.object({ message: messageSchema, tasks: z.array(taskSchema) });
export const answerRequestSchema = z.object({ body_md: z.string().trim().min(1).max(20_000), option: z.string().trim().min(1).max(300).optional() }).strict();
export const followUpRequestSchema = z.object({ body_md: z.string().trim().max(20_000).default('') }).strict();

// ── Decisions ──
export const decisionSchema = z.object({
  id: decisionIdSchema,
  project_id: projectIdSchema,
  title: z.string(),
  statement_md: z.string(),
  rationale_md: z.string(),
  sources: z.array(z.object({ kind: z.string(), ref: z.string() })),
  decided_by: z.string(),
  superseded_by: decisionIdSchema.nullable(),
  created_at: isoDate,
});
export const createDecisionRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  statement_md: z.string().trim().min(1).max(20_000),
  rationale_md: z.string().max(20_000).default(''),
  /** Pin a message (for example an agent's proposal) as the decision's source. */
  source_message_id: messageIdSchema.optional(),
}).strict();
export const supersedeDecisionRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  statement_md: z.string().trim().min(1).max(20_000),
  rationale_md: z.string().max(20_000).default(''),
}).strict();
export const listDecisionsResponseSchema = z.object({ decisions: z.array(decisionSchema) });
export const decisionResponseSchema = decisionSchema;

// ── Activity (derived from real records only) ──
/**
 * offline/available come from the 30-second status probe only. queued, working, reviewing, asking,
 * waiting (behind another turn in its ordering group), paused and delivering come from Studio tasks
 * and Ardent journal events. Speaking is not stored: it is the live message.delta stream itself.
 * unknown: not probed yet.
 */
export const activityStateSchema = z.enum(['offline', 'available', 'queued', 'working', 'reviewing', 'asking', 'waiting', 'paused', 'delivering', 'unknown']);
export const activitySchema = z.object({
  binding_id: bindingIdSchema,
  agent_ref: agentRefSchema,
  state: activityStateSchema,
  label: z.string(),
  source: z.record(z.string(), z.unknown()),
  since: isoDate,
});


// ── Deliverable review ──
/** A received revision's review status. Distinct from the task that produced it and from the file's receipt. */
export const reviewStatusSchema = z.enum(['unreviewed', 'changes_requested', 'accepted', 'rejected', 'superseded']);
export const deliverableRevisionSchema = z.object({
  id: revisionIdSchema,
  deliverable_id: deliverableIdSchema,
  revision: z.number().int(),
  /** Download through GET /blobs/{sha256}. */
  blob_sha256: sha256Schema,
  mime: z.string(),
  size: z.number().int(),
  producer_binding_id: bindingIdSchema.nullable(),
  source_task_id: taskIdSchema.nullable(),
  source_message_id: messageIdSchema.nullable(),
  /** The Ardent registration: agent_ref, artifact_id, task_id and the full artifact manifest. */
  ardent: z.record(z.string(), z.unknown()).nullable(),
  supersedes_revision_id: revisionIdSchema.nullable(),
  received_at: isoDate,
  review_status: reviewStatusSchema,
});
export const deliverableSchema = z.object({
  id: deliverableIdSchema,
  project_id: projectIdSchema,
  requested_deliverable_id: requestedDeliverableIdSchema.nullable(),
  name: z.string(),
  kind: z.string(),
  producer_role: z.string().nullable(),
  final_revision_id: revisionIdSchema.nullable(),
  created_at: isoDate,
  updated_at: isoDate,
  revisions: z.array(deliverableRevisionSchema),
  comments: z.object({ open: z.number().int(), resolved: z.number().int() }),
});
/** An artifact an agent registered. pending: being streamed in; failed: not stored (error says why, such as a digest mismatch). */
export const artifactImportSchema = z.object({
  artifact_id: z.string(),
  task_id: taskIdSchema,
  agent_ref: agentRefSchema,
  name: z.string(),
  mime: z.string(),
  size: z.number().int(),
  sha256: sha256Schema,
  state: z.enum(['pending', 'imported', 'failed']),
  attempts: z.number().int(),
  error: z.string().nullable(),
  revision_id: revisionIdSchema.nullable(),
  updated_at: isoDate,
});
export const listDeliverablesResponseSchema = z.object({ deliverables: z.array(deliverableSchema), imports: z.array(artifactImportSchema) });
export const deliverableResponseSchema = deliverableSchema;

const unit = z.number().min(0).max(1);
/**
 * Where a comment points. text: UTF-16 offsets into the revision decoded as UTF-8, with the quoted
 * text and the revision digest (Markdown, plain text, CSV, JSON, SVG source). docx: a paragraph of
 * the stored conversion. pdf: a page, with an optional normalized rectangle and quote. image: a
 * normalized region, with SVG viewBox coordinates when known. file: the whole file.
 */
export const commentAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), start: z.number().int().min(0), end: z.number().int().min(0), quote: z.string().max(4_000), source_sha256: sha256Schema }).strict(),
  z.object({ kind: z.literal('docx'), paragraph_id: z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/), start: z.number().int().min(0), end: z.number().int().min(0), quote: z.string().max(4_000) }).strict(),
  z.object({ kind: z.literal('pdf'), page: z.number().int().min(1).max(10_000), rect: z.object({ x: unit, y: unit, w: unit, h: unit }).strict().optional(), quote: z.string().max(4_000).optional() }).strict(),
  z.object({ kind: z.literal('image'), x: unit, y: unit, w: unit, h: unit,
    viewbox: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }).strict().optional() }).strict(),
  z.object({ kind: z.literal('file') }).strict(),
]);
export const reviewCommentSchema = z.object({
  id: commentIdSchema,
  project_id: projectIdSchema,
  revision_id: revisionIdSchema,
  anchor: commentAnchorSchema,
  body_md: z.string(),
  author: z.string(),
  state: z.enum(['open', 'resolved']),
  /** The revision task this comment was sent with. */
  revision_task_id: taskIdSchema.nullable(),
  /** The revision that came back from that task. Resolving stays a person's choice. */
  addressed_in_revision_id: revisionIdSchema.nullable(),
  created_at: isoDate,
  resolved_at: isoDate.nullable(),
  updated_at: isoDate.nullable(),
});
export const createCommentRequestSchema = z.object({ anchor: commentAnchorSchema, body_md: z.string().trim().min(1).max(20_000) }).strict();
export const listCommentsResponseSchema = z.object({ comments: z.array(reviewCommentSchema) });
export const commentResponseSchema = reviewCommentSchema;
export const reviewDecisionKindSchema = z.enum(['accepted', 'changes_requested', 'rejected']);
export const reviewDecisionSchema = z.object({
  id: reviewDecisionIdSchema,
  project_id: projectIdSchema,
  revision_id: revisionIdSchema,
  decision: reviewDecisionKindSchema,
  note_md: z.string(),
  decided_by: z.string(),
  created_at: isoDate,
});
export const createReviewDecisionRequestSchema = z.object({ decision: reviewDecisionKindSchema, note_md: z.string().max(20_000).default('') }).strict();
export const reviewDecisionResponseSchema = reviewDecisionSchema;
export const revisionDetailResponseSchema = z.object({
  revision: deliverableRevisionSchema,
  deliverable: deliverableSchema,
  comments: z.array(reviewCommentSchema),
  decisions: z.array(reviewDecisionSchema),
});
export const setFinalRequestSchema = z.object({ revision_id: revisionIdSchema }).strict();
export const revisionRequestSchema = z.object({
  /** Comments on revisions of one deliverable. */
  comment_ids: z.array(commentIdSchema).min(1).max(50).refine(value => new Set(value).size === value.length, 'Duplicate comment'),
  /** Defaults to the deliverable's producer role. */
  role_key: roleKeySchema.optional(),
  instructions_md: z.string().max(20_000).default(''),
}).strict();
export const revisionRequestResponseSchema = z.object({ message: messageSchema, task: taskSchema, comments: z.array(reviewCommentSchema) });
export const exportRecordSchema = z.object({
  id: exportIdSchema,
  project_id: projectIdSchema,
  revision_ids: z.array(revisionIdSchema),
  /** The zip: download through GET /blobs/{sha256}. */
  blob_sha256: sha256Schema,
  manifest: z.record(z.string(), z.unknown()),
  created_by: z.string(),
  created_at: isoDate,
});
export const createExportRequestSchema = z.object({ deliverable_ids: z.array(deliverableIdSchema).min(1).max(200).optional() }).strict();
export const listExportsResponseSchema = z.object({ exports: z.array(exportRecordSchema) });
export const exportResponseSchema = exportRecordSchema;
/** A DOCX converted by the canvas Word codec, stored once per file or revision so paragraph ids stay stable. */
export const docxDocumentResponseSchema = z.object({
  source: z.object({ kind: z.enum(['file', 'revision']), id: z.string() }),
  blob_sha256: sha256Schema,
  codec: z.string(),
  codec_version: z.string(),
  document_sha256: sha256Schema,
  paragraphs: z.array(z.object({ id: z.string(), text: z.string() })),
  /** The exchange document and canvas-editor value. */
  document: z.unknown(),
});


// ── Agent Studio ──
export const presentationSchema = z.object({
  agent_ref: agentRefSchema,
  display_name: z.string().nullable(),
  portrait: avatarPresetSchema.nullable(),
  avatar_file_id: fileIdSchema.nullable(),
  updated_by: z.string().nullable(),
  updated_at: isoDate.nullable(),
});
export const putPresentationRequestSchema = z.object({
  display_name: z.string().trim().min(1).max(80).nullable(),
  portrait: avatarPresetSchema.nullable(),
  /** A project file uploaded with purpose avatar. */
  avatar_file_id: fileIdSchema.nullable().default(null),
}).strict();
const skillName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
/** Unsaved changes to an agent. Each person has one draft per agent; Apply writes it through Magnus. */
export const agentDraftBodySchema = z.object({
  soul: z.string().min(1).max(131_072).optional(),
  identity: z.string().min(1).max(131_072).optional(),
  /** The complete set of enabled local skills. */
  skills_enabled: z.array(skillName).max(100).optional(),
  /** An Emberpath alias or model name, for Preview. */
  model: z.string().trim().min(1).max(200).optional(),
}).strict();
/** The revisions the draft was based on; Apply refuses to overwrite a newer revision. */
export const agentDraftBaseSchema = z.object({
  soul_revision: sha256Schema.optional(),
  identity_revision: sha256Schema.optional(),
  /** Ardent's configuration revision, needed to change skills. */
  config_revision: sha256Schema.optional(),
}).strict();
export const agentDraftSchema = z.object({
  agent_ref: agentRefSchema,
  user_id: z.string(),
  base: agentDraftBaseSchema,
  draft: agentDraftBodySchema,
  created_at: isoDate,
  updated_at: isoDate,
});
export const agentDraftResponseSchema = z.object({ draft: agentDraftSchema.nullable() });
export const putAgentDraftRequestSchema = z.object({
  /** Omitted soul and identity revisions are read from the agent through Magnus. */
  base: agentDraftBaseSchema.default({}),
  draft: agentDraftBodySchema,
}).strict();
export const previewRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(16_000),
  /** Run with this person's draft (soul, identity, skills, model) instead of the saved agent. */
  use_draft: z.boolean().default(true),
  /** Start a fresh preview conversation instead of continuing the last one. */
  new_session: z.boolean().default(false),
}).strict();
export const previewAcceptedEventSchema = z.object({ task_id: z.string(), session_id: z.string().nullable() });
export const previewTextEventSchema = z.object({ step: z.number().int(), text: z.string() });
/** Journal progress only (sequence and kind); details stay in Ardent. */
export const previewJournalEventSchema = z.object({ sequence: z.number().int(), kind: z.string() });
export const previewDoneEventSchema = z.object({ task_id: z.string(), state: z.string(), result: z.string().nullable(), error: z.string().nullable() });
export const previewErrorEventSchema = z.object({ code: z.string(), message: z.string() });
export const APPLY_PARTS = ['soul', 'identity', 'skills', 'model'] as const;
export const applyRequestSchema = z.object({
  parts: z.array(z.enum(APPLY_PARTS)).min(1).max(APPLY_PARTS.length).refine(value => new Set(value).size === value.length, 'Duplicate part'),
}).strict();
export const applyResultSchema = z.object({
  part: z.enum(APPLY_PARTS),
  /** applied; unchanged (the draft has no change for it); failed (error and code say why); unsupported (Studio cannot change it; use the Magnus console). */
  status: z.enum(['applied', 'unchanged', 'failed', 'unsupported']),
  error: z.string().nullable(),
  code: z.string().nullable(),
  /** The new Ardent revision when applied. */
  revision: z.string().nullable(),
});
export const applyResponseSchema = z.object({
  results: z.array(applyResultSchema),
  /** Studio tasks still running on this agent; they keep the instructions they started with. */
  active_tasks: z.number().int(),
  note: z.string().nullable(),
  /** What is left of the draft: applied parts are removed from it. */
  draft: agentDraftSchema.nullable(),
});
export const developmentQuerySchema = z.object({
  after: z.string().regex(/^[A-Za-z0-9_-]{1,400}$/).optional(),
  limit: z.string().regex(/^\d{1,3}$/).optional(),
  kind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
});
export const developmentCommentSchema = z.object({ id: z.string(), agent_ref: agentRefSchema, record_ref: z.string(), body_md: z.string(), author: z.string(), created_at: isoDate });
/** An Ardent development record. author and epistemic say who reported it: agent_reported records are the agent's own account. */
export const developmentRecordSchema = z.object({
  id: z.string(),
  agent_ref: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  author: z.enum(['agent', 'operator', 'runtime']),
  epistemic: z.enum(['agent_reported', 'operator_reported', 'observed']),
  before_sha256: sha256Schema.nullable(),
  after_sha256: sha256Schema.nullable(),
  sources: z.array(z.object({ kind: z.string(), ref: z.string() })),
  created_at: z.string(),
  comments: z.array(developmentCommentSchema),
});
export const developmentResponseSchema = z.object({
  /** False when the agent's runtime does not publish development records; reason says why. */
  supported: z.boolean(),
  reason: z.string().nullable(),
  records: z.array(developmentRecordSchema),
  next: z.string().nullable(),
});
export const createDevelopmentCommentRequestSchema = z.object({
  body_md: z.string().trim().min(1).max(8_000),
  /** Also record the comment in the agent's development history (an operator note). */
  relay_to_agent: z.boolean().default(false),
}).strict();
export const createDevelopmentCommentResponseSchema = z.object({ comment: developmentCommentSchema, relayed: z.boolean(), relay_error: z.string().nullable() });
const credentialFreeUrl = (value: string) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
};
/** An Emberpath alias, or an OpenAI-compatible endpoint and model. Never credentials. */
export const newAgentModelSchema = z.union([
  z.object({ emberpath_alias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/) }).strict(),
  z.object({ base_url: z.string().max(2048).refine(credentialFreeUrl, 'Expected an HTTP(S) URL without credentials, query or fragment'), model: z.string().min(1).max(200) }).strict(),
]);
export const newAgentRequestSchema = z.object({
  node_id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  profile: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  api_port: z.number().int().min(1024).max(65535).optional(),
  /** An agent template version: its soul, identity, local skills and portrait fill what is not given. */
  template: templateRefSchema.optional(),
  soul_md: z.string().min(1).max(131_072).optional(),
  identity_md: z.string().min(1).max(131_072).optional(),
  model: newAgentModelSchema,
  skills: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(100).optional(),
  artifacts_max_bytes: z.number().int().min(1024).max(67_108_864).optional(),
  /** Relay the operation's progress to this project's stream. */
  project_id: projectIdSchema.optional(),
  role_key: roleKeySchema.optional(),
}).strict();
export const agentOperationStepSchema = z.object({
  name: z.string(),
  status: z.enum(['pending', 'running', 'succeeded', 'skipped', 'failed']),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  receipt: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
});
/** A Magnus New Agent operation as Studio relays it. */
export const agentOperationSchema = z.object({
  id: z.string(),
  agent_ref: agentRefSchema,
  project_id: projectIdSchema.nullable(),
  role_key: z.string().nullable(),
  kind: z.enum(['deploy', 'hivemem']),
  status: z.enum(['running', 'succeeded', 'failed']),
  steps: z.array(agentOperationStepSchema),
  error: z.string().nullable(),
  attempts: z.number().int(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});
export const agentOperationResponseSchema = agentOperationSchema;

// ── Project snapshot and stream ──
export const snapshotResponseSchema = z.object({
  /** The stream cursor this snapshot is consistent with: reconnect with ?after=<seq>. */
  seq: z.number().int(),
  project: projectSchema,
  /** The same summary the project list shows: counts and last activity. */
  summary: projectSummarySchema,
  files: z.array(fileSchema),
  /** Link references that are not deleted. */
  links: z.array(referenceLinkSchema),
  team: teamStateSchema,
  conversations: z.array(conversationSchema),
  /** Active tasks and those waiting for an answer. */
  tasks: z.array(taskSchema),
  decisions: z.array(decisionSchema),
  activity: z.array(activitySchema),
  layout: roomLayoutSchema.nullable(),
  /** Team proposals that are still queued or running. */
  team_proposals: z.array(teamProposalRecordSchema),
});
export const streamQuerySchema = z.object({ after: z.string().regex(/^\d{1,15}$/).optional() });
export const PROJECT_EVENT_TYPES = [
  'project.created', 'project.updated', 'project.archived', 'project.reopened',
  'file.created', 'file.updated',
  'team.draft.updated', 'team.revision.published',
  'layout.updated', 'conversation.created', 'conversation.updated', 'message.created', 'message.updated',
  'presence.updated', 'task.created', 'task.updated', 'decision.created', 'decision.updated',
  'deliverable.revision.created', 'review.comment.created', 'review.comment.updated', 'review.decision.created',
  'export.created', 'agent.operation.updated', 'deliverable.updated', 'artifact.import.updated',
  'link.created', 'link.updated', 'link.deleted', 'team.proposal.updated',
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
/**
 * Live reply text, never persisted or replayed. mode append adds text to the message's current
 * step; replace sets the whole step (a new step, or a snapshot sent when a stream connects).
 * The stored message (message.updated) replaces it when the turn ends.
 */
export const messageDeltaEventSchema = z.object({ message_id: z.string(), text: z.string(), mode: z.enum(['append', 'replace']).optional(), step: z.number().int().optional() });

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
const REVIEW = ['ardentstudio:review:write'] as const;
const AGENTS_ADMIN = ['ardentstudio:agents:admin'] as const;

export const ardentStudioBrowserRoutes: readonly ArdentStudioBrowserRoute[] = [
  // Health
  { method: 'GET', path: '/health/live', response: liveResponseSchema, permissions: [], idempotent: false },
  { method: 'GET', path: '/health/ready', response: readyResponseSchema, permissions: [], idempotent: false, note: 'Answers 503 with the same body when not ready. Checks are cached for 10 seconds.' },

  // Projects
  { method: 'GET', path: '/projects', query: listProjectsQuerySchema, response: listProjectsResponseSchema, permissions: READ, idempotent: false, note: 'q matches name, brief and tags. needs_review=true keeps projects with review_pending > 0.' },
  { method: 'POST', path: '/projects', requestBody: 'json', request: createProjectRequestSchema, response: projectResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'Creates the project HiveMem workspace; when HiveMem is unavailable hivemem.state stays pending and is retried.' },
  { method: 'GET', path: '/projects/{projectId}', response: projectResponseSchema, permissions: READ, idempotent: false },
  { method: 'PATCH', path: '/projects/{projectId}', requestBody: 'json', request: updateProjectRequestSchema, response: projectResponseSchema, permissions: WRITE, idempotent: true, note: 'An archived project is read-only (409) except last_area.' },
  { method: 'POST', path: '/projects/{projectId}/archive', response: projectResponseSchema, permissions: WRITE, idempotent: true, note: '409 with details.tasks while Studio tasks are still active.' },
  { method: 'POST', path: '/projects/{projectId}/reopen', response: projectResponseSchema, permissions: WRITE, idempotent: true },
  { method: 'GET', path: '/projects/{projectId}/snapshot', response: snapshotResponseSchema, permissions: READ, idempotent: false },

  // Reference links
  { method: 'POST', path: '/projects/{projectId}/links', requestBody: 'json', request: createLinkRequestSchema, response: linkResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'http and https only, without credentials. 409 LINK_EXISTS when the project already has this URL. Synced to the project HiveMem workspace as a knowledge source (title, URL and note; the page is not fetched).' },
  { method: 'GET', path: '/projects/{projectId}/links', response: listLinksResponseSchema, permissions: READ, idempotent: false, note: 'Links that are not deleted.' },
  { method: 'PATCH', path: '/links/{linkId}', requestBody: 'json', request: updateLinkRequestSchema, response: linkResponseSchema, permissions: WRITE, idempotent: true, note: 'A change queues the link for HiveMem sync again.' },
  { method: 'DELETE', path: '/links/{linkId}', response: linkResponseSchema, permissions: WRITE, idempotent: true, note: 'Marks the link deleted and retires its HiveMem source.' },
  { method: 'POST', path: '/links/{linkId}/reindex', response: linkResponseSchema, permissions: WRITE, idempotent: true, note: 'Queues the link for HiveMem sync again.' },

  // Files
  { method: 'POST', path: '/projects/{projectId}/files', query: uploadFileQuerySchema, requestBody: 'raw', response: fileResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'Raw body up to ARDENT_STUDIO_MAX_BLOB_BYTES (default 64 MiB) with an allowed Content-Type (UPLOAD_MIME_TYPES). References are indexed into the project HiveMem workspace.' },
  { method: 'GET', path: '/projects/{projectId}/files', query: listFilesQuerySchema, response: listFilesResponseSchema, permissions: READ, idempotent: false },
  { method: 'GET', path: '/blobs/{sha256}', response: null, permissions: READ, idempotent: false, note: 'Bytes as application/octet-stream with Content-Disposition attachment; the recorded type is in X-Blob-Mime. Only blobs that a project file, a deliverable revision or an export references are served.' },
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
  { method: 'POST', path: '/projects/{projectId}/team/propose', requestBody: 'json', request: proposeTeamRequestSchema, response: teamProposalResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'Asks one agent through Magnus (a mission at studio level 2 with Ardent 2.2.0, else task-submit) for a TeamProposal JSON reply with the brief, deliverables, templates and available agents. An invalid reply is retried once with the validation error, then the proposal fails. Progress arrives as team.proposal.updated; nothing is applied. 409 NO_COORDINATOR without agent_ref and a bound coordinator, 409 PROPOSAL_IN_PROGRESS while one is queued or running, 422 UNKNOWN_AGENT, 409 AGENT_UNAVAILABLE, 503 MAGNUS_UNAVAILABLE.' },
  { method: 'GET', path: '/projects/{projectId}/team/proposals', response: listTeamProposalsResponseSchema, permissions: READ, idempotent: false, note: 'Newest first, at most 20.' },
  { method: 'GET', path: '/projects/{projectId}/team/proposals/{proposalId}', response: teamProposalResponseSchema, permissions: READ, idempotent: false },
  { method: 'POST', path: '/projects/{projectId}/team/save-as-template', requestBody: 'json', request: saveAsTemplateRequestSchema, response: templateDetailSchema, permissions: ['ardentstudio:projects:read', 'ardentstudio:templates:write'], idempotent: true, successStatus: 201, note: 'Bindings and knowledge are not copied.' },

  // Agents
  { method: 'GET', path: '/agents', response: listAgentsResponseSchema, permissions: READ, idempotent: false, note: 'Magnus-managed Ardent profiles. When Magnus is unavailable the list is empty and magnus.state says so.' },
  { method: 'POST', path: '/agents', requestBody: 'json', request: newAgentRequestSchema, response: agentOperationResponseSchema, permissions: AGENTS_ADMIN, idempotent: true, successStatus: 201, note: 'Magnus New Agent with the acting person: Magnus also requires that person to be a Magnus ADMIN (403 ACTING_ADMIN_REQUIRED). The agent always gets HiveMem. Progress is relayed as agent.operation.updated on project_id\'s stream.' },
  { method: 'GET', path: '/agents/operations/{operationId}', response: agentOperationResponseSchema, permissions: READ, idempotent: false, note: 'Operations started from Studio. Magnus\'s current view, or the last relayed one when Magnus is unreachable.' },
  { method: 'GET', path: '/agents/{agentRef}/presentation', response: presentationSchema, permissions: READ, idempotent: false },
  { method: 'PUT', path: '/agents/{agentRef}/presentation', requestBody: 'json', request: putPresentationRequestSchema, response: presentationSchema, permissions: WRITE, idempotent: true, note: 'Studio-only display name and portrait; the agent itself is unchanged.' },
  { method: 'GET', path: '/agents/{agentRef}/draft', response: agentDraftResponseSchema, permissions: READ, idempotent: false, note: 'The calling person\'s draft.' },
  { method: 'PUT', path: '/agents/{agentRef}/draft', requestBody: 'json', request: putAgentDraftRequestSchema, response: agentDraftResponseSchema, permissions: WRITE, idempotent: true },
  { method: 'DELETE', path: '/agents/{agentRef}/draft', response: agentDraftResponseSchema, permissions: WRITE, idempotent: true },
  {
    method: 'POST', path: '/agents/{agentRef}/preview', requestBody: 'json', request: previewRequestSchema, response: null, permissions: WRITE, idempotent: false,
    events: { 'preview.accepted': previewAcceptedEventSchema, 'preview.text': previewTextEventSchema, 'preview.delta': previewTextEventSchema, 'preview.event': previewJournalEventSchema, 'preview.done': previewDoneEventSchema, 'preview.error': previewErrorEventSchema },
    note: 'Streams a side-effect-free Ardent preview task (no memory writes, no mission tools, no identity changes, artifacts expire). Needs the agent\'s Magnus node agent at studio level 2: otherwise 409 PREVIEW_UNAVAILABLE. Sending x-idempotency-key again streams the same preview task.',
  },
  { method: 'POST', path: '/agents/{agentRef}/apply', requestBody: 'json', request: applyRequestSchema, response: applyResponseSchema, permissions: AGENTS_ADMIN, idempotent: true, note: 'Applies parts of the calling person\'s draft through Magnus (identity-save, skill-set) with the acting person, each against its base revision. Results are per part; running tasks keep their instructions.' },
  { method: 'GET', path: '/agents/{agentRef}/development', query: developmentQuerySchema, response: developmentResponseSchema, permissions: READ, idempotent: false },
  { method: 'POST', path: '/agents/{agentRef}/development/{recordId}/comments', requestBody: 'json', request: createDevelopmentCommentRequestSchema, response: createDevelopmentCommentResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201 },

  // Room
  { method: 'GET', path: '/projects/{projectId}/layout', response: layoutResponseSchema, permissions: READ, idempotent: false },
  { method: 'PUT', path: '/projects/{projectId}/layout', requestBody: 'json', request: putLayoutRequestSchema, response: layoutResponseSchema, permissions: WRITE, idempotent: true, note: 'Each save is a new revision. 409 when base_revision is not the latest.' },
  { method: 'GET', path: '/projects/{projectId}/conversations', response: listConversationsResponseSchema, permissions: READ, idempotent: false },
  { method: 'POST', path: '/projects/{projectId}/conversations', requestBody: 'json', request: createConversationRequestSchema, response: conversationResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'A discussion posts its question and starts round 1 at once: one turn per participant in order, then the next round, then a coordinator summary. Needs a published team with the participants bound (409 TEAM_NOT_READY).' },
  { method: 'POST', path: '/conversations/{conversationId}/stop', response: conversationResponseSchema, permissions: WRITE, idempotent: true, note: 'Unstarted turns are cancelled; started ones are cancelled through Magnus.' },
  { method: 'GET', path: '/conversations/{conversationId}/messages', query: listMessagesQuerySchema, response: listMessagesResponseSchema, permissions: READ, idempotent: false, note: 'Oldest first after ?after=<seq>; at most 200 (default 100).' },
  { method: 'POST', path: '/conversations/{conversationId}/messages', requestBody: 'json', request: postMessageRequestSchema, response: postMessageResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'Team or Coordinator starts a coordinator turn; roles or @role_key mentions start one turn per addressee in order. A direct conversation always goes to its role; a discussion takes notes without starting turns. 409 TEAM_NOT_READY without a published team and bound roles.' },
  { method: 'POST', path: '/messages/{messageId}/answer', requestBody: 'json', request: answerRequestSchema, response: postMessageResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'Answers a clarification: the answer continues the same agent session. 409 when it is already answered.' },
  { method: 'POST', path: '/messages/{messageId}/follow-up', requestBody: 'json', request: followUpRequestSchema, response: postMessageResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: "Asks the agent that wrote the message to follow up on it." },

  // Decisions and tasks
  { method: 'GET', path: '/projects/{projectId}/decisions', response: listDecisionsResponseSchema, permissions: READ, idempotent: false },
  { method: 'POST', path: '/projects/{projectId}/decisions', requestBody: 'json', request: createDecisionRequestSchema, response: decisionResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'Pinning is a person\'s act; an agent can only propose.' },
  { method: 'POST', path: '/decisions/{decisionId}/supersede', requestBody: 'json', request: supersedeDecisionRequestSchema, response: decisionResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'Creates the new decision and marks this one superseded by it. 409 when it is already superseded.' },
  { method: 'GET', path: '/projects/{projectId}/tasks', query: listTasksQuerySchema, response: listTasksResponseSchema, permissions: READ, idempotent: false },
  { method: 'POST', path: '/projects/{projectId}/tasks', requestBody: 'json', request: createTaskRequestSchema, response: taskResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201 },
  { method: 'POST', path: '/tasks/{taskId}/pause', response: taskResponseSchema, permissions: WRITE, idempotent: true, note: 'A started task pauses at its next step boundary (state pausing, then paused); an unstarted one is held. 409 AGENT_UPGRADE_REQUIRED when the agent cannot pause.' },
  { method: 'POST', path: '/tasks/{taskId}/resume', response: taskResponseSchema, permissions: WRITE, idempotent: true },
  { method: 'POST', path: '/tasks/{taskId}/cancel', response: taskResponseSchema, permissions: WRITE, idempotent: true },
  { method: 'POST', path: '/tasks/{taskId}/reassign', requestBody: 'json', request: reassignTaskRequestSchema, response: taskResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'Cancels the task when it is still active and creates the same work for another role, with reassigned_from.' },

  // Deliverable review
  { method: 'GET', path: '/projects/{projectId}/deliverables', response: listDeliverablesResponseSchema, permissions: READ, idempotent: false, note: 'Deliverables with every revision, plus artifact imports that are still pending or failed.' },
  { method: 'GET', path: '/deliverables/{deliverableId}', response: deliverableResponseSchema, permissions: READ, idempotent: false },
  { method: 'GET', path: '/revisions/{revisionId}', response: revisionDetailResponseSchema, permissions: READ, idempotent: false },
  { method: 'GET', path: '/revisions/{revisionId}/comments', response: listCommentsResponseSchema, permissions: READ, idempotent: false },
  { method: 'POST', path: '/revisions/{revisionId}/comments', requestBody: 'json', request: createCommentRequestSchema, response: commentResponseSchema, permissions: REVIEW, idempotent: true, successStatus: 201, note: 'The anchor kind must fit the revision type (422 ANCHOR_KIND). A text anchor must quote the revision exactly (422 ANCHOR_MISMATCH) and name its digest (409 ANCHOR_STALE). A docx anchor needs the stored conversion (409 DOCX_NOT_CONVERTED).' },
  { method: 'POST', path: '/comments/{commentId}/resolve', response: commentResponseSchema, permissions: REVIEW, idempotent: true },
  { method: 'POST', path: '/revisions/{revisionId}/decisions', requestBody: 'json', request: createReviewDecisionRequestSchema, response: reviewDecisionResponseSchema, permissions: REVIEW, idempotent: true, successStatus: 201, note: 'changes_requested needs a note or an open comment (422 NOTE_REQUIRED).' },
  { method: 'POST', path: '/deliverables/{deliverableId}/final', requestBody: 'json', request: setFinalRequestSchema, response: deliverableResponseSchema, permissions: REVIEW, idempotent: true, note: 'One final revision per deliverable; a rejected revision cannot be final (409).' },
  { method: 'POST', path: '/projects/{projectId}/revision-requests', requestBody: 'json', request: revisionRequestSchema, response: revisionRequestResponseSchema, permissions: ['ardentstudio:review:write', 'ardentstudio:projects:write'], idempotent: true, successStatus: 201, note: 'Starts a revision task for the producer role with the anchored comments as context, and links the comments to it. The revised file comes back as the next revision, superseding this one.' },
  { method: 'GET', path: '/projects/{projectId}/exports', response: listExportsResponseSchema, permissions: READ, idempotent: false },
  { method: 'POST', path: '/projects/{projectId}/exports', requestBody: 'json', request: createExportRequestSchema, response: exportResponseSchema, permissions: REVIEW, idempotent: true, successStatus: 201, note: 'A zip of the final revisions with manifest.json (Ardent manifest fields, review status and decisions). Deliverables without a final revision are listed as excluded; none at all answers 409 NOTHING_FINAL.' },
  { method: 'GET', path: '/files/{fileId}/docx', response: docxDocumentResponseSchema, permissions: READ, idempotent: false, note: 'Answers 501 DOCX_CONVERTER_UNAVAILABLE until the canvas Word codec package is installed.' },
  { method: 'GET', path: '/revisions/{revisionId}/docx', response: docxDocumentResponseSchema, permissions: READ, idempotent: false, note: 'Answers 501 DOCX_CONVERTER_UNAVAILABLE until the canvas Word codec package is installed.' },

  // Stream
  {
    method: 'GET', path: '/projects/{projectId}/stream', query: streamQuerySchema, response: null, permissions: READ, idempotent: false,
    events: { '*': projectEventSchema, reset: resetEventSchema, heartbeat: heartbeatEventSchema, 'message.delta': messageDeltaEventSchema },
    note: 'Persisted events carry their seq as the SSE id and replay after ?after=. reset means the cursor is older than retained events (or ahead of them): refetch the snapshot. message.delta (live reply text) has no id; on connect each streaming message gets one replace delta with its current text. heartbeat every 15 s. The stream closes when the token expires or its session ends; reconnect with a fresh token.',
  },
];
