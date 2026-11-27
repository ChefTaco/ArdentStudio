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
  'ardentstudio:audit:read',
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
export const workflowRunIdSchema = prefixedId('wfr');
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
// ── Project membership ──
/**
 * Optional per-project membership. A project starts open to everyone linked (mode everyone): its
 * creator is its owner and every other linked person an editor. With mode members only the listed
 * Oathweave subjects, and people whose token carries a listed Oathweave role (the roles Oathweave
 * groups grant), have access, each with the highest role that matches. A person holding
 * ardentstudio:agents:admin is an owner of every project. A project role only narrows: a person
 * still needs the route's Oathweave permissions. Without access to a project, its routes, stream
 * and blobs answer 404 NOT_FOUND; with too low a role, 403 PROJECT_ROLE_REQUIRED
 * (details required, role).
 */
export const PROJECT_ROLES = ['viewer', 'editor', 'owner'] as const;
export const projectRoleSchema = z.enum(PROJECT_ROLES);
export type ProjectRole = z.infer<typeof projectRoleSchema>;
export const projectMembershipModeSchema = z.enum(['everyone', 'members']);
/** The calling person's access to the project. */
export const projectAccessSchema = z.object({ mode: projectMembershipModeSchema, role: projectRoleSchema });
const memberSubject = z.string().trim().min(1).max(256);
const memberRoleName = z.string().trim().min(1).max(128);
export const projectMemberRequestSchema = z.discriminatedUnion('kind', [
  /** An Oathweave subject. issuer null matches the subject from any accepted issuer. */
  z.object({ kind: z.literal('subject'), subject: memberSubject, issuer: z.url().max(2_048).nullable().default(null), role: projectRoleSchema }).strict(),
  /** Everyone whose Oathweave token carries this role (directly or through an Oathweave group). */
  z.object({ kind: z.literal('oathweave_role'), name: memberRoleName, role: projectRoleSchema }).strict(),
]);
export const projectMemberSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('subject'), subject: z.string(), issuer: z.string().nullable(), role: projectRoleSchema,
    /** The linked Studio user and display name for this subject, when an account link names it. */
    user_id: z.string().nullable(), display_name: z.string().nullable(),
    added_by: z.string(), added_at: isoDate,
  }),
  z.object({ kind: z.literal('oathweave_role'), name: z.string(), role: projectRoleSchema, added_by: z.string(), added_at: isoDate }),
]);
export const projectMembersResponseSchema = z.object({
  project_id: projectIdSchema,
  mode: projectMembershipModeSchema,
  /** Increments on every change; send it back as base_revision. */
  revision: z.number().int(),
  /** Empty in mode everyone. */
  members: z.array(projectMemberSchema),
  access: projectAccessSchema,
});
const memberKey = (member: z.infer<typeof projectMemberRequestSchema>) =>
  member.kind === 'subject' ? `subject\u0000${member.issuer ?? ''}\u0000${member.subject}` : `oathweave_role\u0000${member.name}`;
export const putProjectMembersRequestSchema = z.object({
  /** 409 VERSION_CONFLICT when it is not the current revision. */
  base_revision: z.number().int().min(0),
  mode: projectMembershipModeSchema,
  /** Must be empty for mode everyone. For mode members it needs at least one owner. */
  members: z.array(projectMemberRequestSchema).max(500).default([]),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.members.forEach((member, index) => {
    const key = memberKey(member);
    if (seen.has(key)) context.addIssue({ code: 'custom', path: ['members', index], message: 'Each member is listed once' });
    seen.add(key);
  });
});
/** A person with an account link, for choosing members. */
export const linkedPersonSchema = z.object({ user_id: z.string(), subject: z.string(), issuer: z.string(), display_name: z.string().nullable() });
/** The most people a GET /people search (q) returns. */
export const PEOPLE_SEARCH_LIMIT = 50;
export const listPeopleQuerySchema = z.object({
  /**
   * Case-insensitive prefix of the user id, the Oathweave subject, the display name or a word of it.
   * With q at most PEOPLE_SEARCH_LIMIT people are returned (truncated true when more match);
   * without it (or with an empty q), every linked person.
   */
  q: z.string().trim().max(200).optional(),
});
export const listPeopleResponseSchema = z.object({
  people: z.array(linkedPersonSchema),
  /** True when a search matched more people than it returned; narrow q. Always false without q. */
  truncated: z.boolean(),
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
  /** The calling person's membership mode and role (see Project membership). Always sent; absent only from releases before membership. */
  access: projectAccessSchema.optional(),
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
  /** Only projects where this agent (<magnusNodeId>~<profile>) is bound to a role in the published or the draft team. */
  agentRef: agentRefSchema.optional(),
});
export const listProjectsResponseSchema = z.object({ projects: z.array(projectSummarySchema) });
export const projectResponseSchema = projectSchema;

/**
 * Purges an archived project for good. confirm_name must equal the project's name exactly
 * (422 CONFIRMATION_MISMATCH otherwise).
 */
export const purgeProjectRequestSchema = z.object({ confirm_name: z.string().max(400) }).strict();
export const purgeProjectResponseSchema = z.object({
  project_id: projectIdSchema,
  name: z.string(),
  purged_at: isoDate,
  /** Rows removed per kind (events, files, links, conversations, messages, tasks, deliverables, revisions, ...). */
  removed: z.record(z.string(), z.number().int()),
  /** HiveMem sources queued for retirement (retried until HiveMem takes them). The workspace itself is kept. */
  knowledge: z.object({ sources_retiring: z.number().int() }),
});
/** project.purged stream payload: sent live (never replayed) to open streams of the project, which then close. */
export const projectPurgedEventSchema = z.object({ project_id: projectIdSchema, at: isoDate });

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
/** GET /blobs/{sha256}: inline for previews (raster images get their real type), attachment otherwise. */
export const blobQuerySchema = z.object({ disposition: z.enum(['attachment', 'inline']).default('attachment') });
export const listFilesResponseSchema = z.object({ files: z.array(fileSchema) });
export const fileResponseSchema = fileSchema;
/**
 * DELETE /files/{fileId}. knowledge retiring: the file's HiveMem source is being retired (the file is
 * hidden now and removed once HiveMem took the retirement); none: nothing was indexed and it is gone.
 */
export const deleteFileResponseSchema = z.object({ file: fileSchema, deleted_at: isoDate, knowledge: z.enum(['retiring', 'none']) });
/** POST /projects/{projectId}/reindex: how many reference files and links were queued for HiveMem sync. */
export const reindexProjectResponseSchema = z.object({ files: z.number().int(), links: z.number().int() });

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
  /** A pinned HiveSkills release: its version and the release archive's SHA-256 (both, on hiveskills skills only). */
  version: z.string().max(64).regex(/^v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine(value => (value.version === undefined) === (value.sha256 === undefined) && (value.version === undefined || value.kind === 'hiveskills'),
  { message: 'A pinned skill is a hiveskills skill with both version and sha256', path: ['version'] });
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

// ── Workflows (spec) ──
/** A workflow is a small DAG of sub-prompts: each node runs as an ordinary Studio task for a team role. */
export const WORKFLOW_MAX_NODES = 16;
export const workflowNodeKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
export const workflowNodeSpecSchema = z.object({
  key: workflowNodeKeySchema,
  /** A role of the project's published team. The node runs with that role's agent, tools and grants. */
  role: roleKeySchema,
  title: z.string().trim().min(1).max(200).optional(),
  /** The node's instructions (the task's instructions_md). */
  prompt: z.string().trim().min(1).max(20_000),
  /** Nodes whose results this node waits for (a join when there are several). */
  needs: z.array(workflowNodeKeySchema).max(WORKFLOW_MAX_NODES).default([]),
  /** A node that is not required may be skipped; its dependents then go on without its result. */
  required: z.boolean().default(true),
  /** How the needs join: every one of them done (or skipped). */
  join: z.literal('all').default('all'),
}).strict();

interface WorkflowGraph { nodes: ReadonlyArray<{ key: string; needs?: readonly string[] | undefined; required?: boolean | undefined }>; output: string }
export interface WorkflowGraphIssue { path: Array<string | number>; message: string }

/**
 * Structural problems of a workflow spec: duplicate keys, unknown or repeated needs, a cycle, an
 * unknown output, and anything but exactly one output (every other node must lead to it, and no
 * node may need it).
 */
export function workflowGraphIssues(spec: WorkflowGraph): WorkflowGraphIssue[] {
  const issues: WorkflowGraphIssue[] = [];
  const index = new Map<string, number>();
  spec.nodes.forEach((node, position) => {
    if (index.has(node.key)) issues.push({ path: ['nodes', position, 'key'], message: `Duplicate node key "${node.key}"` });
    else index.set(node.key, position);
  });
  spec.nodes.forEach((node, position) => {
    const seen = new Set<string>();
    (node.needs ?? []).forEach((need, at) => {
      if (need === node.key) issues.push({ path: ['nodes', position, 'needs', at], message: `Node "${node.key}" needs itself` });
      else if (!index.has(need)) issues.push({ path: ['nodes', position, 'needs', at], message: `Node "${node.key}" needs unknown node "${need}"` });
      if (seen.has(need)) issues.push({ path: ['nodes', position, 'needs', at], message: `Node "${node.key}" needs "${need}" twice` });
      seen.add(need);
    });
  });
  if (issues.length) return issues;
  // Cycles: depth-first search over needs.
  const state = new Map<string, 'open' | 'done'>();
  const byKey = new Map(spec.nodes.map(node => [node.key, node]));
  let cycle: string[] | undefined;
  const visit = (key: string, path: string[]): void => {
    if (cycle || state.get(key) === 'done') return;
    if (state.get(key) === 'open') { cycle = [...path.slice(path.indexOf(key)), key]; return; }
    state.set(key, 'open');
    for (const need of byKey.get(key)?.needs ?? []) visit(need, [...path, key]);
    state.set(key, 'done');
  };
  for (const node of spec.nodes) visit(node.key, []);
  if (cycle) return [{ path: ['nodes'], message: `The workflow has a cycle: ${cycle.join(' → ')}` }];
  const output = byKey.get(spec.output);
  if (!output) return [{ path: ['output'], message: `The output node "${spec.output}" is not a node of the workflow` }];
  if (output.required === false) issues.push({ path: ['output'], message: 'The output node must be required' });
  spec.nodes.forEach((node, position) => {
    if ((node.needs ?? []).includes(spec.output)) issues.push({ path: ['nodes', position, 'needs'], message: `Node "${node.key}" needs the output node; the output must be the last node` });
  });
  // Exactly one output: every node leads to it.
  const leads = new Set<string>([spec.output]);
  const pending = [spec.output];
  while (pending.length) for (const need of byKey.get(pending.pop()!)?.needs ?? []) if (!leads.has(need)) { leads.add(need); pending.push(need); }
  spec.nodes.forEach((node, position) => {
    if (!leads.has(node.key)) issues.push({ path: ['nodes', position, 'key'], message: `Node "${node.key}" does not lead to the output "${spec.output}"; a workflow has exactly one output node` });
  });
  return issues;
}

export const workflowSpecSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  nodes: z.array(workflowNodeSpecSchema).min(1).max(WORKFLOW_MAX_NODES),
  /** The one node whose result is the workflow's result. */
  output: workflowNodeKeySchema,
}).strict().superRefine((spec, ctx) => {
  for (const issue of workflowGraphIssues(spec)) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
});
/** A workflow a team template offers. Its roles are the template's roles. */
export const teamWorkflowSchema = z.object({
  key: workflowNodeKeySchema,
  name,
  purpose: text(2_000).default(''),
  spec: workflowSpecSchema,
}).strict();

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
  /** Workflows a project with this team can start (POST /projects/{projectId}/workflow-runs with template_ref). */
  workflows: z.array(teamWorkflowSchema).max(8).optional(),
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
/** The agent definition a template version was imported from (POST /templates/import-definition). */
export const sourceDefinitionSchema = z.object({ name: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const agentTemplateVersionSchema = z.object({ ...versionFields, kind: z.literal('agent'), body: agentTemplateBodySchema, source_definition: sourceDefinitionSchema.nullable() });
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
/** Decisions on a task Ardent holds for one (Ardent 3.2.0 task recovery, C3). */
export const RECOVERY_ACTIONS = ['mark_applied', 'mark_not_applied', 'retry_with_new_deadline', 'abandon'] as const;
export const recoveryActionSchema = z.enum(RECOVERY_ACTIONS);
/**
 * ready, reconciling, resumed: Ardent is continuing the interrupted run under the same task (the Studio
 * task stays running and shows as recovering). awaiting_decision: Ardent holds it (Studio unknown) until a
 * person decides with one of `actions`. unsupported: Ardent cannot continue it. resolved: decided; a
 * continuation_task_id names the Ardent task that continues the work for the same Studio task.
 */
export const recoveryStatusSchema = z.enum(['ready', 'reconciling', 'resumed', 'awaiting_decision', 'unsupported', 'resolved']);
export const taskRecoverySchema = z.object({
  status: recoveryStatusSchema,
  /** Actionable, e.g. UNSETTLED_EXTERNAL_WRITE, CODEX_THREAD_NOT_DURABLE, DEADLINE_ELAPSED_DURING_OUTAGE. */
  reason: z.object({ code: z.string(), message: z.string() }),
  attempt: z.number().int(),
  checkpoint: z.object({
    step: z.number().int(), completed_calls: z.number().int(),
    pending_calls: z.array(z.object({ call_id: z.string(), tool: z.string(), effect: z.string(), dispatched_at: z.string().nullable(), reconcilable: z.boolean() })),
  }).optional(),
  /** The decisions Studio can send now: empty when the agent's Ardent or Magnus agent cannot take them (supported false). */
  actions: z.array(recoveryActionSchema),
  continuation_task_id: z.string().optional(),
  decided: z.object({ action: recoveryActionSchema, by: z.string(), at: z.string(), note: z.string().optional() }).optional(),
  /** Whether the agent supports recovery decisions through Magnus (profile recovery >= 1). */
  supported: z.boolean(),
  observed_at: isoDate,
});
/** The task's execution context references (attribution only): the causal root, parent and the task itself, qualified `hx1:` references. */
export const taskExecutionRefsSchema = z.object({
  root: z.string(), parent: z.string().nullable(), self: z.string().nullable(), attempt: z.number().int().nullable(), inputs: z.array(z.string()),
});
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
  /** task_id is the current Ardent task; attempts the earlier ones (recovery continuations), oldest first. */
  ardent: z.object({ agent_ref: z.string().nullable(), task_id: z.string().nullable(), session_id: z.string().nullable(), attempts: z.array(z.string()) }),
  outcome: z.unknown(),
  reassigned_from: taskIdSchema.nullable(),
  /** Tasks in one ordering group start one after another. */
  group_id: z.string().nullable(),
  group_position: z.number().int(),
  created_by: z.string(),
  created_at: isoDate,
  updated_at: isoDate,
  finished_at: isoDate.nullable(),
  execution: taskExecutionRefsSchema.nullable(),
  /** The last Ardent recovery Studio observed, or null when the run was never interrupted. A running task with one is recovering. */
  recovery: taskRecoverySchema.nullable(),
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
/**
 * GET /tasks/{taskId}/recovery. source live: read now through Magnus; stored: as last recorded (the agent
 * cannot be asked, see unavailable). supported false: no actions can be sent (unavailable says why).
 */
export const taskRecoveryResponseSchema = z.object({
  task: taskSchema,
  recovery: taskRecoverySchema.nullable(),
  supported: z.boolean(),
  source: z.enum(['live', 'stored']),
  unavailable: z.object({ code: z.string(), message: z.string() }).nullable(),
});
/** POST /tasks/{taskId}/recovery: a person's decision on a task Ardent holds awaiting_decision. */
export const taskRecoveryRequestSchema = z.object({
  action: recoveryActionSchema,
  /** The pending call the decision is about; needed when several are pending. */
  call_id: z.string().min(1).max(256).optional(),
  /** mark_applied: the call's result when known (JSON, at most 64 KiB), checked against the tool's output schema. */
  result: z.unknown().optional().refine(value => value === undefined || new TextEncoder().encode(JSON.stringify(value) ?? '').length <= 64 * 1024, 'Exceeds 65536 bytes'),
  note: z.string().trim().min(1).max(2000).optional(),
  /** retry_with_new_deadline: the new deadline in seconds (Ardent caps it). */
  deadline_seconds: z.number().int().min(1).max(86_400).optional(),
}).strict();
export const taskRecoveryDecisionResponseSchema = z.object({ task: taskSchema, recovery: taskRecoverySchema });
/** A Studio task in a lineage listing. */
export const lineageTaskSchema = z.object({ task_id: taskIdSchema, ref: z.string().nullable(), role_key: z.string().nullable(), state: taskStateSchema, mode: taskModeSchema });
/**
 * GET /tasks/{taskId}/lineage: how the task sits in the suite-wide causal tree. studio: Studio's own
 * relationships. ardent: each Ardent attempt's lineage as the profile records it (current last), or null
 * with ardent_unavailable when the agent cannot answer. emberpath: the filter for provider traces.
 */
export const taskLineageResponseSchema = z.object({
  task_id: taskIdSchema,
  studio: z.object({
    self: z.string().nullable(),
    root: z.string().nullable(),
    parent: z.string().nullable(),
    execution: taskExecutionRefsSchema.nullable(),
    /** Tasks whose execution parent is this task (hand-offs, reassignments, the next discussion turn). */
    children: z.array(lineageTaskSchema),
    reassigned_from: lineageTaskSchema.nullable(),
    reassigned_to: z.array(lineageTaskSchema),
    /** Hand-offs: the task that handed this one over (direction from) and those it handed over (direction to). */
    handoffs: z.array(lineageTaskSchema.extend({ direction: z.enum(['from', 'to']), relationship: z.string().nullable() })),
    /** The team revision the task runs under, and the deliverable revisions it produced. */
    assignment_revision: z.number().int().nullable(),
    revisions: z.array(z.object({ revision_id: revisionIdSchema, deliverable_id: deliverableIdSchema, revision: z.number().int(), blob_sha256: sha256Schema })),
    workflow: z.object({ run_id: workflowRunIdSchema, node_key: z.string(), attempt: z.number().int(), ref: z.string().nullable() }).nullable(),
  }),
  ardent: z.object({
    agent_ref: agentRefSchema,
    attempts: z.array(z.object({
      ardent_task_id: z.string(),
      ref: z.string().nullable(),
      current: z.boolean(),
      /** The profile's GET /api/v1/tasks/{id}/lineage answer, relayed as-is; null with error when it could not be read. */
      lineage: z.record(z.string(), z.unknown()).nullable(),
      error: z.object({ code: z.string(), message: z.string() }).nullable(),
    })),
  }).nullable(),
  ardent_unavailable: z.object({ code: z.string(), message: z.string() }).nullable(),
  emberpath: z.object({ filter: z.object({ executionRoot: z.string().nullable() }) }),
});

// ── Workflow runs ──
export const workflowRunStateSchema = z.enum(['running', 'blocked', 'completed', 'failed', 'cancelled']);
export const workflowNodeStateSchema = z.enum(['waiting', 'ready', 'running', 'done', 'failed', 'blocked', 'skipped', 'cancelled']);
export const WORKFLOW_ACTIONS = ['retry', 'skip', 'cancel_run'] as const;
export const workflowActionSchema = z.enum(WORKFLOW_ACTIONS);
export type WorkflowAction = z.infer<typeof workflowActionSchema>;
const workflowInputKey = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
/** Values every node receives as data (a context item), never as instructions. */
export const workflowInputsSchema = z.record(workflowInputKey, z.string().max(8_000))
  .refine(value => Object.keys(value).length <= 16, 'At most 16 inputs');
export const workflowSourceTemplateSchema = z.object({ template_id: templateIdSchema, version: z.number().int(), workflow: workflowNodeKeySchema });
/** An artifact a node's task delivered that Studio imported: `ardent-artifact:<sha256>`. */
export const workflowArtifactRefSchema = z.object({ ref: z.string(), name: z.string(), sha256: sha256Schema, mime: z.string(), size: z.number().int() });
export const workflowNodeResultSchema = z.object({
  task_id: taskIdSchema,
  state: z.enum(['completed', 'partial']),
  /** The task's final reply (the TeamResult summary of a mission). */
  summary: z.string(),
  artifacts: z.array(workflowArtifactRefSchema),
});
export const workflowNodeSchema = z.object({
  key: workflowNodeKeySchema,
  role: roleKeySchema,
  title: z.string(),
  prompt: z.string(),
  needs: z.array(workflowNodeKeySchema),
  required: z.boolean(),
  join_rule: z.literal('all'),
  /** 1, counting up with every retry. Each attempt is a new task. */
  attempt: z.number().int(),
  state: workflowNodeStateSchema,
  /** The current attempt's task, else the last attempt's. */
  task_id: taskIdSchema.nullable(),
  /** Every attempt's task, oldest first. */
  attempts: z.array(z.object({ attempt: z.number().int(), task_id: taskIdSchema })),
  result: workflowNodeResultSchema.nullable(),
  error: z.string().nullable(),
  /** Needs that keep a blocked node from starting. */
  blocked_by: z.array(workflowNodeKeySchema),
  /** What a person can do with this node now. */
  actions: z.array(workflowActionSchema),
  updated_at: isoDate,
});
export const workflowRunSchema = z.object({
  id: workflowRunIdSchema,
  project_id: projectIdSchema,
  name: z.string().nullable(),
  state: workflowRunStateSchema,
  output: workflowNodeKeySchema,
  spec: workflowSpecSchema,
  spec_sha256: sha256Schema,
  inputs: z.record(z.string(), z.string()),
  source_template: workflowSourceTemplateSchema.nullable(),
  /** The run's qualified execution reference `hx1:studio:<inst>:workflow:<run id>`, the parent of every node task. */
  root_ref: z.string().nullable(),
  created_by: z.string(),
  created_at: isoDate,
  updated_at: isoDate,
  finished_at: isoDate.nullable(),
  nodes: z.array(workflowNodeSchema),
});
export const createWorkflowRunRequestSchema = z.object({
  /** An inline workflow. Send this or template_ref with workflow. */
  spec: workflowSpecSchema.optional(),
  /** A team template version that defines the workflow. */
  template_ref: templateRefSchema.optional(),
  /** The key of the template's workflow. */
  workflow: workflowNodeKeySchema.optional(),
  inputs: workflowInputsSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.spec !== undefined && (value.template_ref !== undefined || value.workflow !== undefined)) ctx.addIssue({ code: 'custom', path: ['spec'], message: 'Send spec or template_ref with workflow, not both' });
  else if (value.spec === undefined && (value.template_ref === undefined || value.workflow === undefined)) ctx.addIssue({ code: 'custom', path: ['template_ref'], message: 'Send spec, or template_ref with workflow' });
});
export const listWorkflowRunsQuerySchema = z.object({ state: z.enum(['active', 'finished', 'all']).default('all') });
export const listWorkflowRunsResponseSchema = z.object({ runs: z.array(workflowRunSchema) });
export const workflowRunResponseSchema = workflowRunSchema;
export const workflowNodeActionRequestSchema = z.object({ action: workflowActionSchema }).strict();
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
 * offline/available come from the 30-second status probe. queued, working (only after the journal
 * shows model_started or tool_attempt), reviewing, asking, waiting (behind another turn in its
 * ordering group, or on a role it handed work to), paused, blocked (the agent's newest task failed,
 * ended in an unknown Ardent state or reported itself blocked) and delivering (shortly after a
 * verified deliverable revision) come from Studio tasks and Ardent journal events. unknown: not
 * probed yet. When several apply, the highest wins: offline, paused, blocked, asking, reviewing,
 * working, queued, waiting, delivering, available, unknown. Speaking is not stored: it is the live
 * message.delta stream itself.
 */
export const activityStateSchema = z.enum(['offline', 'available', 'queued', 'working', 'reviewing', 'asking', 'waiting', 'paused', 'blocked', 'delivering', 'unknown']);
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
/** A rendition of a revision's artifact (artifact transfer v2), the original first. Download through GET /blobs/{sha256}. */
export const deliverableRenditionSchema = z.object({
  role: z.string(), sha256: sha256Schema, mime: z.string(), size: z.number().int(), purpose: z.string().nullable(),
  width: z.number().int().nullable(), height: z.number().int().nullable(), has_alpha: z.boolean().nullable(),
});
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
  /** Renditions Ardent listed for the artifact (original first, then previews and model inputs); empty from agents without artifact transfer v2. */
  renditions: z.array(deliverableRenditionSchema),
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
  /** Why the import failed or waits for a retry: DIGEST_MISMATCH, TOO_LARGE, SIZE_MISMATCH, RANGE_MISMATCH, TRANSFER_INCOMPLETE, MAGNUS_REFUSED, TRANSFER_FAILED or TASK_GONE. */
  error_code: z.string().nullable(),
  revision_id: revisionIdSchema.nullable(),
  /** Bytes received so far (a ranged import resumes from here). */
  received_bytes: z.number().int(),
  /** range: artifact transfer v2 with Range and resume; whole: the v1 download. Null until the transfer starts. */
  transfer: z.enum(['range', 'whole']).nullable(),
  /** How often the transfer continued from a partial file. */
  resumes: z.number().int(),
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
  /** Ardent's configuration revision, needed to change skills and the model. */
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
  /**
   * Omitted soul and identity revisions are read from the agent through Magnus, and the configuration
   * revision too when the draft changes skills or the model (reading it needs a Magnus ADMIN).
   */
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
/**
 * Codes of a failed part besides Magnus's own: ACTING_ADMIN_REQUIRED and ACTING_SUBJECT_UNLINKED (the
 * person is not a linked Magnus ADMIN), CONFIG_PATH_FORBIDDEN, CONFLICT (the agent changed since the
 * draft's base revision), INVALID_INPUT (Magnus or Ardent rejected the value), BASE_REVISION_MISSING,
 * CONFIG_REVISION_REQUIRED, UNKNOWN_SKILL and CONFIG_UNREADABLE.
 */
export const applyResultSchema = z.object({
  part: z.enum(APPLY_PARTS),
  /** applied; unchanged (the draft has no change for it); failed (error and code say why); unsupported (Studio cannot change it; use the Magnus console). */
  status: z.enum(['applied', 'unchanged', 'failed', 'unsupported']),
  error: z.string().nullable(),
  code: z.string().nullable(),
  /** The new Ardent revision when applied (the identity file's, or the configuration's for skills and model). */
  revision: z.string().nullable(),
  /** The applied change takes effect only after the agent's profile restarts (skills and model). */
  activation_required: z.boolean(),
});
export const applyResponseSchema = z.object({
  results: z.array(applyResultSchema),
  /** Studio tasks still running on this agent; they keep the instructions they started with. */
  active_tasks: z.number().int(),
  note: z.string().nullable(),
  /** What is left of the draft: applied parts are removed from it. */
  draft: agentDraftSchema.nullable(),
  /** Some applied change waits for a profile restart. */
  activation_required: z.boolean(),
  /**
   * Whether Studio can restart the profile. Magnus does not let Studio's service identity run
   * service-restart, so available is false and reason says to restart it from the Magnus console.
   */
  restart: z.object({ available: z.boolean(), reason: z.string().nullable() }),
});
/**
 * POST /agents/{agentRef}/skills/install: a HiveSkills catalog release (the slug and the version promoted on
 * the channel) that Magnus fetches, checks against the catalog digest and installs onto the agent. With
 * enable, revision is the agent's configuration revision and the skill is enabled in the same step.
 */
export const installSkillRequestSchema = z.object({
  source: z.literal('hiveskills'),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  version: z.string().max(64).regex(/^v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i),
  channel: z.enum(['stable', 'canary']).optional(),
  enable: z.boolean().optional(),
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine(value => !value.enable || value.revision !== undefined, { message: 'enable needs the configuration revision', path: ['revision'] });
/**
 * What Magnus installed. changed is false when the same release was installed already. When enabling was
 * asked for and failed, the skill stays installed, enabled is false and enable_error says why. revision is
 * the new configuration revision when the skill was enabled. The change applies once the profile restarts.
 */
export const installSkillResponseSchema = z.object({
  source: z.literal('hiveskills'), name: z.string(), version: z.string(), sha256: z.string(), files: z.number().int(),
  changed: z.boolean(), enabled: z.boolean(), revision: z.string().nullable(), enable_error: z.string().nullable(),
  activation_required: z.boolean(), note: z.string().nullable(),
  restart: z.object({ available: z.boolean(), reason: z.string().nullable() }),
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
/**
 * An Emberpath client key (Magnus's ARDENT_EMBERPATH_CLIENT_KEY_PATTERN): 16 to 512 characters without
 * whitespace. Write-only: Studio relays it to Magnus for one request and never stores, logs, audits or returns it.
 */
export const EMBERPATH_CLIENT_KEY_PATTERN = /^[A-Za-z0-9._~+/=-]{16,512}$/u;
export const emberpathClientKeySchema = z.string().regex(EMBERPATH_CLIENT_KEY_PATTERN, 'Expected an Emberpath client key: 16 to 512 characters without whitespace');
/** Request fields that carry a credential: never stored, and left out of the idempotency fingerprint. */
export const WRITE_ONLY_REQUEST_FIELDS = ['emberpath_client_key'] as const;

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
  /**
   * The Emberpath client key the operator created in Emberpath, required with an emberpath_alias model (Magnus
   * answers 400 EMBERPATH_KEY_REQUIRED without it). Relayed to Magnus, which delivers it to the new profile.
   */
  emberpath_client_key: emberpathClientKeySchema.optional(),
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
  /** definition: an install of an agent definition (POST /templates/{templateId}/versions/{version}/deploy). */
  kind: z.enum(['deploy', 'hivemem', 'definition']),
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

// ── Agent definitions (hive-agent-definition/1) ──
// One portable, complete agent definition, as Magnus 3.3.0 validates and installs it. This is the shape of
// @hivemagnus/magnus-contracts `agent-definition`, repeated here because this file imports only zod (HiveXUI
// vendors it as one file); test/definition.test.ts fails when the two differ. The server verifies, seals and
// digests definitions with magnus-contracts itself. `sha256` is the SHA-256 of the canonical JSON (sorted keys, no whitespace) of the definition
// without `sha256`; `persona.sha256` that of `{ soul_md, identity_md }`. A definition never carries a
// credential: secrets are named environment variables, installation resources are named bindings, and
// history, memory, sessions and artifacts are always excluded.
export const AGENT_DEFINITION_SCHEMA = 'hive-agent-definition/1' as const;
export const AGENT_DEFINITION_EXCLUDES = ['history', 'memory', 'sessions', 'artifacts'] as const;
export const AGENT_DEFINITION_BINDING_KINDS = ['hivemem', 'emberpath_alias', 'hiveskills', 'channel', 'peer'] as const;
/** The preflight problem codes Magnus reports today (a later Magnus may add codes). */
export const AGENT_DEFINITION_PROBLEM_CODES = [
  'MISSING_BINDING', 'SKILL_VERSION_UNAVAILABLE', 'EXTENSION_NOT_REVIEWED', 'RUNTIME_INCOMPATIBLE', 'CAPABILITY_MISSING', 'SECRET_UNBOUND',
] as const;

const definitionUtf8Length = (value: string) => new TextEncoder().encode(value).length;
const definitionDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const definitionPersonaText = z.string().max(131_072)
  .refine(value => value.trim().length > 0 && definitionUtf8Length(value) <= 131_072, 'Identity text must be 1 to 128 KiB');
const definitionPackageName = z.string().max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u);
const definitionDistinct = (values: string[]) => new Set(values).size === values.length;
/** An Emberpath alias: the only portable model reference. */
export const emberpathAliasSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u);

/** A requirement's key: `hivemem`, `model`, `hiveskills`, `channel:<name>`, `peers`. */
export const agentDefinitionBindingKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}(?::[a-z0-9][a-z0-9_-]{0,63})?$/u);
/**
 * What an install binds each requirement to: a HiveMem workspace or `default`, an Emberpath alias, `default`
 * for HiveSkills; `secret:<ENV_NAME>` to `provided` or `none`, never a value.
 */
export const agentDefinitionBindingsSchema = z.record(
  z.union([agentDefinitionBindingKeySchema, z.string().regex(/^secret:[A-Z][A-Z0-9_]{0,127}$/u)]),
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u),
).refine(value => Object.keys(value).length <= 128, 'At most 128 bindings');

const agentDefinitionFields = {
  schema: z.literal(AGENT_DEFINITION_SCHEMA),
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2000).optional(),
  created_at: z.iso.datetime({ offset: true }),
  source_template: z.object({ template_id: z.string().min(1).max(128), version: z.number().int().min(1) }).strict().optional(),
  persona: z.object({ soul_md: definitionPersonaText, identity_md: definitionPersonaText, sha256: definitionDigest }).strict(),
  runtime: z.object({
    package: definitionPackageName,
    version: z.string().max(64).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
    required_capabilities: z.array(z.string().regex(/^[a-z0-9.-]{1,64}$/u)).max(32).refine(items => definitionDistinct(items), 'Duplicate capability'),
  }).strict(),
  /** Reviewed extension packages, by reference: the npm SRI of the archive and the reviewed package tree digest. */
  extensions: z.array(z.object({
    name: definitionPackageName,
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/u),
    package_tree_sha256: definitionDigest,
    plugins: z.array(z.string().min(1).max(500)).min(1).max(32).optional(),
  }).strict()).max(32).refine(items => definitionDistinct(items.map(item => item.name)), 'Duplicate extension'),
  /** HiveSkills releases: the catalog slug, the release version and the archive's SHA-256. */
  skills: z.array(z.object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/u),
    version: z.string().max(64).regex(/^v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu),
    sha256: definitionDigest,
  }).strict()).max(100).refine(items => definitionDistinct(items.map(item => item.slug)), 'Duplicate skill'),
  config: z.object({
    execution: z.object({
      backend: z.enum(['llamacpp', 'codex']),
      deadline_seconds: z.number().int().min(1).max(86_400).optional(),
      max_parallel_tasks: z.number().int().min(1).max(16).optional(),
      max_parallel_tool_calls: z.number().int().min(1).max(16).optional(),
    }).strict(),
    /** Absent alias: the target binds `model`. */
    model: z.object({ emberpath_alias: emberpathAliasSchema.optional() }).strict(),
    artifacts: z.object({ max_bytes: z.number().int().min(1024).max(67_108_864).optional() }).strict(),
    channels: z.literal('excluded'),
  }).strict(),
  requirements: z.object({
    bindings: z.array(z.object({ key: agentDefinitionBindingKeySchema, kind: z.enum(AGENT_DEFINITION_BINDING_KINDS), required: z.boolean() }).strict())
      .max(64).refine(items => definitionDistinct(items.map(item => item.key)), 'Duplicate binding key'),
    secrets: z.array(z.object({ env_name: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u), purpose: z.string().trim().min(1).max(200) }).strict())
      .max(64).refine(items => definitionDistinct(items.map(item => item.env_name)), 'Duplicate secret'),
  }).strict(),
  excludes: z.tuple([z.literal('history'), z.literal('memory'), z.literal('sessions'), z.literal('artifacts')]),
};
/** The definition without its digest, as it is hashed. */
export const agentDefinitionBodySchema = z.object(agentDefinitionFields).strict();
/** The shape only; Studio also checks both digests and the credential guard before it trusts one. */
export const agentDefinitionSchema = z.object({ ...agentDefinitionFields, sha256: definitionDigest }).strict()
  .refine(value => definitionUtf8Length(JSON.stringify(value)) <= 512 * 1024, 'A definition is at most 512 KiB');
export const agentDefinitionProblemSchema = z.object({ code: z.string().max(64), detail: z.string().max(500) });
/** Magnus's preflight report: ok exactly when there are no problems. */
export const agentDefinitionPreflightSchema = z.object({ ok: z.boolean(), problems: z.array(agentDefinitionProblemSchema) });

/** What a template has that a definition cannot carry. */
export const definitionOmissionSchema = z.object({ kind: z.enum(['skill', 'model']), name: z.string(), reason: z.string() });
// POST /templates/{templateId}/versions/{version}/definition
export const buildDefinitionRequestSchema = z.object({}).strict();
export const buildDefinitionResponseSchema = z.object({ definition: agentDefinitionSchema, omitted: z.array(definitionOmissionSchema) });
// POST /templates/import-definition
export const importDefinitionRequestSchema = z.object({
  /** Checked by the route: schema, both digests and the credential guard (422). */
  definition: z.unknown(),
  /** Add the version to this agent template. Omitted: the definition's source_template when it is here, else a new template. */
  template_id: templateIdSchema.optional(),
  /** The latest version this import is based on (a newer one answers 409). Omitted: the definition's source_template version. */
  base_version: z.number().int().min(1).optional(),
  changelog: z.string().trim().min(1).max(2_000).optional(),
}).strict();
export const importDefinitionResponseSchema = z.object({
  template: templateDetailSchema,
  version: z.number().int(),
  /** A new template was created (no template matched). */
  created: z.boolean(),
  source_definition: sourceDefinitionSchema,
  /** Definition fields a template cannot represent, by JSON path. */
  ignored: z.array(z.object({ path: z.string(), reason: z.string() })),
});
// POST /templates/{templateId}/versions/{version}/deploy-check
export const definitionDeployCheckRequestSchema = z.object({
  node_id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  bindings: agentDefinitionBindingsSchema.optional(),
  /**
   * The Emberpath client key the install will deliver, so Magnus can check it against Emberpath. Without it, a
   * definition whose model is an Emberpath alias (backend llamacpp) reports SECRET_UNBOUND (Emberpath key missing).
   */
  emberpath_client_key: emberpathClientKeySchema.optional(),
}).strict();
export const definitionDeployCheckResponseSchema = z.object({
  definition: sourceDefinitionSchema,
  omitted: z.array(definitionOmissionSchema),
  preflight: agentDefinitionPreflightSchema,
});
// POST /templates/{templateId}/versions/{version}/deploy
export const definitionDeployRequestSchema = z.object({
  node_id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  profile: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  bindings: agentDefinitionBindingsSchema,
  api_port: z.number().int().min(1024).max(65535).optional(),
  /**
   * The Emberpath client key for the definition's Emberpath alias, required for one: Magnus delivers it to the
   * new profile and it satisfies the definition's model-key secret. Never stored or returned.
   */
  emberpath_client_key: emberpathClientKeySchema.optional(),
  /** Relay the operation's progress to this project's stream. */
  project_id: projectIdSchema.optional(),
  role_key: roleKeySchema.optional(),
}).strict();

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
/**
 * task.recovery payload. change: recovering (Ardent continues the same task), held (unknown until a
 * decision), continued (the task follows the continuation ardent_task_id; previous_ardent_task_id is the
 * attempt it continues), resolved (ended without a continuation), unsupported (Ardent cannot continue it).
 */
export const taskRecoveryEventSchema = z.object({
  task_id: taskIdSchema,
  change: z.enum(['recovering', 'held', 'continued', 'resolved', 'unsupported']),
  recovery: taskRecoverySchema,
  ardent_task_id: z.string().nullable(),
  previous_ardent_task_id: z.string().optional(),
});
/** artifact.import.progress payload: a transfer moved on (at most every 2 s). State changes and outcomes arrive as artifact.import.updated. */
export const artifactImportProgressEventSchema = z.object({ import: artifactImportSchema });
export const PROJECT_EVENT_TYPES = [
  'project.created', 'project.updated', 'project.archived', 'project.reopened',
  'file.created', 'file.updated', 'file.deleted',
  'team.draft.updated', 'team.revision.published',
  'layout.updated', 'conversation.created', 'conversation.updated', 'message.created', 'message.updated',
  'presence.updated', 'task.created', 'task.updated', 'decision.created', 'decision.updated',
  'deliverable.revision.created', 'review.comment.created', 'review.comment.updated', 'review.decision.created',
  'export.created', 'agent.operation.updated', 'deliverable.updated', 'artifact.import.updated',
  'link.created', 'link.updated', 'link.deleted', 'team.proposal.updated',
  'workflow.run.created', 'workflow.run.updated', 'workflow.node.updated',
  'task.recovery', 'artifact.import.progress',
  'project.members.updated',
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

// ── Audit export (HiveAuditRecord v1, shared across the suite) ──
/** The suite-wide audit record. Every product serves the same shape so one collector can parse them all. */
const auditScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const hiveAuditRecordSchema = z.object({
  id: z.string().regex(/^(hivemem|hiveskills|ardentstudio|embermend):audit:[A-Za-z0-9._:-]{1,200}$/),
  product: z.enum(['hivemem', 'hiveskills', 'ardentstudio', 'embermend']),
  occurredAt: z.iso.datetime(),
  action: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/).max(128),
  outcome: z.enum(['success', 'failure']),
  actor: z.object({
    type: z.enum(['user', 'service', 'agent', 'system']),
    id: z.string().min(1).max(256),
    issuer: z.string().max(512).optional(),
    displayName: z.string().max(256).optional(),
  }).strict(),
  /** Omitted when empty. */
  target: z.object({ type: z.string().max(64).optional(), id: z.string().max(256).optional() }).strict().optional(),
  /** Omitted when empty. */
  subject: z.object({ actorId: z.string().max(256).optional(), agentRef: z.string().max(257).optional(), nodeId: z.string().max(128).optional() }).strict().optional(),
  /** Flat scalars, at most 4 KB serialized, already redacted. Never secrets, memory content, prompts or file contents. */
  details: z.record(z.string(), auditScalarSchema),
}).strict();
export type HiveAuditRecord = z.infer<typeof hiveAuditRecordSchema>;

export const auditExportQuerySchema = z.object({
  /** The opaque nextCursor of the previous page. Omit for the oldest record. */
  after: z.string().max(512).optional(),
  /** 1 to 200; default 100. Larger values are clamped to 200. */
  limit: z.string().regex(/^\d{1,6}$/).optional(),
});
export const auditExportResponseSchema = z.object({
  data: z.array(hiveAuditRecordSchema),
  /** The last record's cursor whenever `data` is not empty, even on the last page; null only when `data` is empty (caught up). Send it as `after` to read on. */
  nextCursor: z.string().nullable(),
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
  /** A linked person holding this permission passes instead of `permissions` (Studio admins). */
  orPermission?: ArdentStudioPermission;
  /** `any` also accepts Oathweave service (client-credentials) tokens; the default is people only. */
  accept?: 'user' | 'any';
  /** The route requires the x-idempotency-key header. */
  idempotent: boolean;
  successStatus?: 201;
  /** Server-sent event payloads by event name. Read with fetch: EventSource cannot send the bearer token. */
  events?: Readonly<Record<string, z.ZodType>>;
  /** The project role this route needs, when it differs from projectRoleOf's default. */
  projectRole?: ProjectRole;
  note?: string;
}

const READ = ['ardentstudio:projects:read'] as const;
const WRITE = ['ardentstudio:projects:write'] as const;
const TEMPLATES_READ = ['ardentstudio:templates:read'] as const;
const TEMPLATES_WRITE = ['ardentstudio:templates:write'] as const;
const REVIEW = ['ardentstudio:review:write'] as const;
const AGENTS_ADMIN = ['ardentstudio:agents:admin'] as const;
const AUDIT_READ = ['ardentstudio:audit:read'] as const;

export const ardentStudioBrowserRoutes: readonly ArdentStudioBrowserRoute[] = [
  // Health
  { method: 'GET', path: '/health/live', response: liveResponseSchema, permissions: [], idempotent: false },
  { method: 'GET', path: '/health/ready', response: readyResponseSchema, permissions: [], idempotent: false, note: 'Answers 503 with the same body when not ready. Checks are cached for 10 seconds.' },

  // Projects
  { method: 'GET', path: '/projects', query: listProjectsQuerySchema, response: listProjectsResponseSchema, permissions: READ, idempotent: false, note: 'q matches name, brief and tags. needs_review=true keeps projects with review_pending > 0. agentRef keeps projects where that agent is bound to a role in the published or the draft team; an agent with no roles gets an empty list. 400 VALIDATION_ERROR for a malformed agentRef.' },
  { method: 'POST', path: '/projects', requestBody: 'json', request: createProjectRequestSchema, response: projectResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'Creates the project HiveMem workspace; when HiveMem is unavailable hivemem.state stays pending and is retried.' },
  { method: 'GET', path: '/projects/{projectId}', response: projectResponseSchema, permissions: READ, idempotent: false },
  { method: 'PATCH', path: '/projects/{projectId}', requestBody: 'json', request: updateProjectRequestSchema, response: projectResponseSchema, permissions: WRITE, idempotent: true, note: 'An archived project is read-only (409) except last_area.' },
  { method: 'POST', path: '/projects/{projectId}/archive', response: projectResponseSchema, permissions: WRITE, idempotent: true, note: '409 with details.tasks while Studio tasks are still active.' },
  { method: 'POST', path: '/projects/{projectId}/reopen', response: projectResponseSchema, permissions: WRITE, idempotent: true },
  { method: 'GET', path: '/projects/{projectId}/snapshot', response: snapshotResponseSchema, permissions: READ, idempotent: false },
  { method: 'POST', path: '/projects/{projectId}/purge', requestBody: 'json', request: purgeProjectRequestSchema, response: purgeProjectResponseSchema, permissions: AGENTS_ADMIN, idempotent: true, projectRole: 'owner',
    note: 'Deletes an archived project for good: its events, files, links, team, room, tasks, workflow runs, deliverables, reviews and exports. Bytes nothing else references are removed (at once, or by the hourly sweep), the HiveMem sources of its references and links are retired (retried until HiveMem takes them; the workspace is kept), and audit records are kept. Open streams of the project get project.purged and close. 409 PROJECT_NOT_ARCHIVED, 422 CONFIRMATION_MISMATCH (confirm_name is not the exact project name), 409 TASKS_ACTIVE, 409 FILE_IN_USE (details agents: an agent portrait uses one of its files).' },

  // Project membership
  { method: 'GET', path: '/projects/{projectId}/members', response: projectMembersResponseSchema, permissions: READ, idempotent: false, note: 'The membership mode, the listed members and the caller\'s access. See Project membership.' },
  { method: 'PUT', path: '/projects/{projectId}/members', requestBody: 'json', request: putProjectMembersRequestSchema, response: projectMembersResponseSchema, permissions: READ, idempotent: true, projectRole: 'owner',
    note: 'Replaces the membership (project owners and ardentstudio:agents:admin). mode everyone opens the project to everyone linked again. 409 VERSION_CONFLICT (details revision) when base_revision is stale, 422 MEMBERS_NOT_ALLOWED when mode everyone lists members, 422 OWNER_REQUIRED when mode members has no owner, 422 SELF_LOCKOUT when a caller who is not an admin would no longer be an owner. Announced as project.members.updated (mode, revision); open streams of people who lose access close.' },
  { method: 'GET', path: '/people', query: listPeopleQuerySchema, response: listPeopleResponseSchema, permissions: READ, idempotent: false,
    note: 'People with an account link (Studio user, Oathweave subject and issuer, display name), to choose project members from. Only for people who can edit a members list: ardentstudio:agents:admin, or the owner of at least one project (one they created that is open to everyone linked, or one that lists them as owner); anyone else gets 403 PROJECT_ROLE_REQUIRED (details required owner). q searches by prefix and returns at most 50 people (truncated true when more match).' },

  // Reference links
  { method: 'POST', path: '/projects/{projectId}/links', requestBody: 'json', request: createLinkRequestSchema, response: linkResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'http and https only, without credentials. 409 LINK_EXISTS when the project already has this URL. Synced to the project HiveMem workspace as a knowledge source (title, URL and note; the page is not fetched).' },
  { method: 'GET', path: '/projects/{projectId}/links', response: listLinksResponseSchema, permissions: READ, idempotent: false, note: 'Links that are not deleted.' },
  { method: 'PATCH', path: '/links/{linkId}', requestBody: 'json', request: updateLinkRequestSchema, response: linkResponseSchema, permissions: WRITE, idempotent: true, note: 'A change queues the link for HiveMem sync again.' },
  { method: 'DELETE', path: '/links/{linkId}', response: linkResponseSchema, permissions: WRITE, idempotent: true, note: 'Marks the link deleted and retires its HiveMem source.' },
  { method: 'POST', path: '/links/{linkId}/reindex', response: linkResponseSchema, permissions: WRITE, idempotent: true, note: 'Queues the link for HiveMem sync again.' },

  // Files
  { method: 'POST', path: '/projects/{projectId}/files', query: uploadFileQuerySchema, requestBody: 'raw', response: fileResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'Raw body up to ARDENT_STUDIO_MAX_BLOB_BYTES (default 64 MiB) with an allowed Content-Type (UPLOAD_MIME_TYPES). References are indexed into the project HiveMem workspace.' },
  { method: 'GET', path: '/projects/{projectId}/files', query: listFilesQuerySchema, response: listFilesResponseSchema, permissions: READ, idempotent: false },
  { method: 'GET', path: '/blobs/{sha256}', query: blobQuerySchema, response: null, permissions: READ, idempotent: false, note: 'Bytes as application/octet-stream with Content-Disposition attachment; the recorded type is in X-Blob-Mime and the digest in X-Content-SHA256 (ETag "<sha256>"). Range (one bytes= range) answers 206 with Content-Range, 416 when unsatisfiable; If-Range with another ETag answers the whole blob. disposition=inline answers Content-Disposition inline and, for raster images (PNG, JPEG, WebP, GIF), their real Content-Type, for previews. Only blobs that a project file, a deliverable revision or rendition, or an export references are served.' },
  { method: 'POST', path: '/files/{fileId}/reindex', response: fileResponseSchema, permissions: WRITE, idempotent: true, note: 'Queues the file for HiveMem sync again.' },
  { method: 'DELETE', path: '/files/{fileId}', response: deleteFileResponseSchema, permissions: WRITE, idempotent: true, note: 'Deletes the file: it leaves the file list, the snapshot and /blobs at once, its HiveMem source is retired (retried until HiveMem takes it), and its bytes are removed once nothing else references them (within about an hour). Announced as file.deleted. 409 FILE_IN_USE (details agents, roles) while an agent portrait or a role of the current or draft team names it; 409 PROJECT_ARCHIVED.' },
  { method: 'POST', path: '/projects/{projectId}/reindex', response: reindexProjectResponseSchema, permissions: WRITE, idempotent: true, note: 'Queues every reference file and link of the project for HiveMem sync again, for example after restoring a backup.' },

  // Templates
  { method: 'GET', path: '/templates', query: listTemplatesQuerySchema, response: listTemplatesResponseSchema, permissions: TEMPLATES_READ, idempotent: false },
  { method: 'GET', path: '/templates/{templateId}', response: templateDetailSchema, permissions: TEMPLATES_READ, idempotent: false },
  { method: 'GET', path: '/templates/{templateId}/versions/{version}', response: templateVersionSchema, permissions: TEMPLATES_READ, idempotent: false },
  { method: 'POST', path: '/templates', requestBody: 'json', request: createTemplateRequestSchema, response: templateDetailSchema, permissions: TEMPLATES_WRITE, idempotent: true, successStatus: 201, note: 'Templates never carry secrets; values that look like credentials are rejected.' },
  { method: 'POST', path: '/templates/{templateId}/versions', requestBody: 'json', request: createTemplateVersionRequestSchema, response: templateDetailSchema, permissions: TEMPLATES_WRITE, idempotent: true, successStatus: 201, note: 'Versions are immutable. 409 when base_version is not the latest.' },
  { method: 'POST', path: '/templates/{templateId}/archive', requestBody: 'json', request: archiveTemplateRequestSchema, response: templateDetailSchema, permissions: TEMPLATES_WRITE, idempotent: true },
  { method: 'POST', path: '/templates/{templateId}/versions/{version}/definition', requestBody: 'json', request: buildDefinitionRequestSchema, response: buildDefinitionResponseSchema, permissions: TEMPLATES_READ, idempotent: false, note: 'Builds a sealed hive-agent-definition/1 from an agent template version: persona, pinned HiveSkills releases, Emberpath model alias, runtime and bindings. Nothing is stored and the same version always gives the same definition (created_at is the version\'s). Skills without a pinned version and digest, and a model that is not an alias, are listed in omitted. 422 NOT_AGENT_TEMPLATE, 422 DEFINITION_INCOMPLETE (empty soul or identity), 422 DEFINITION_CONTAINS_CREDENTIAL.' },
  { method: 'POST', path: '/templates/{templateId}/versions/{version}/deploy-check', requestBody: 'json', request: definitionDeployCheckRequestSchema, response: definitionDeployCheckResponseSchema, permissions: AGENTS_ADMIN, idempotent: false, note: 'Builds the version\'s definition and asks Magnus to validate it for the node and bindings as the acting person, whom Magnus requires to be a linked Magnus ADMIN (403 ACTING_ADMIN_REQUIRED). Answers Magnus\'s preflight (MISSING_BINDING, SKILL_VERSION_UNAVAILABLE, EXTENSION_NOT_REVIEWED, RUNTIME_INCOMPATIBLE, CAPABILITY_MISSING, SECRET_UNBOUND). An Emberpath-alias definition needs the write-only emberpath_client_key, which Magnus checks against Emberpath; without it the preflight reports SECRET_UNBOUND (Emberpath key missing). The key is never stored or returned. A Magnus without agent definitions (before 3.3.0) answers 409 MAGNUS_UPGRADE_REQUIRED; 404 NOT_FOUND for an unknown node.' },
  { method: 'POST', path: '/templates/{templateId}/versions/{version}/deploy', requestBody: 'json', request: definitionDeployRequestSchema, response: agentOperationResponseSchema, permissions: AGENTS_ADMIN, idempotent: true, successStatus: 201, note: 'Create agent from definition: Magnus installs the version\'s definition as a new profile (a New Agent operation of kind definition) once its preflight passes, as the acting Magnus ADMIN. 409 PREFLIGHT_FAILED with error.details.problems creates nothing; 409 MAGNUS_UPGRADE_REQUIRED before Magnus 3.3.0. An Emberpath-alias definition needs the write-only emberpath_client_key (without it, or when Emberpath refuses it, 409 PREFLIGHT_FAILED with SECRET_UNBOUND; Magnus\'s EMBERPATH_* refusals keep their codes); it is never stored or returned. Progress is relayed as agent.operation.updated on project_id\'s stream.' },
  { method: 'POST', path: '/templates/import-definition', requestBody: 'json', request: importDefinitionRequestSchema, response: importDefinitionResponseSchema, permissions: TEMPLATES_WRITE, idempotent: true, successStatus: 201, note: 'Verifies a hive-agent-definition/1 (schema, both digests, credential guard: 422 DEFINITION_INVALID or DEFINITION_CONTAINS_CREDENTIAL) and stores it as a new immutable agent template version with source_definition {name, sha256}: of template_id, else of the definition\'s source_template when it exists here, else of a new template. The base is base_version, else the source_template version; a newer latest version answers 409 VERSION_CONFLICT. Fields a template cannot hold are listed in ignored.' },

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
  { method: 'POST', path: '/agents', requestBody: 'json', request: newAgentRequestSchema, response: agentOperationResponseSchema, permissions: AGENTS_ADMIN, idempotent: true, successStatus: 201, note: 'Magnus New Agent with the acting person: Magnus also requires that person to be a Magnus ADMIN (403 ACTING_ADMIN_REQUIRED). The agent always gets HiveMem. An emberpath_alias model needs the write-only emberpath_client_key: 400 EMBERPATH_KEY_REQUIRED without it, 409 EMBERPATH_NOT_EXPLICIT, 422 EMBERPATH_KEY_INVALID, EMBERPATH_KEY_FORBIDDEN or EMBERPATH_ALIAS_UNAVAILABLE; it is never stored or returned. Progress is relayed as agent.operation.updated on project_id\'s stream.' },
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
  { method: 'POST', path: '/agents/{agentRef}/apply', requestBody: 'json', request: applyRequestSchema, response: applyResponseSchema, permissions: AGENTS_ADMIN, idempotent: true, note: 'Applies parts of the calling person\'s draft through Magnus with the acting person, who must be a linked Magnus ADMIN: soul and identity with identity-save, skills with chained skill-set against the saved configuration\'s skills.enabled (the skill list reports the running profile, which a restart updates), the model with config-save of the agent\'s config.yaml changing only the model setting. Each part is checked against its base revision. Results are per part; skill and model changes report activation_required (a profile restart, which Studio cannot run). Running tasks keep their instructions.' },
  { method: 'POST', path: '/agents/{agentRef}/skills/install', requestBody: 'json', request: installSkillRequestSchema, response: installSkillResponseSchema, permissions: AGENTS_ADMIN, idempotent: true, note: 'Magnus skill-install with the acting person, who must be a linked Magnus ADMIN (403 ACTING_ADMIN_REQUIRED); the node agent needs studio 3 (409 AGENT_UPGRADE_REQUIRED). Magnus refusals keep their codes: 503 HIVESKILLS_UNCONFIGURED, 409 SKILL_VERSION_UNAVAILABLE, 409 SKILL_CONFLICT (a local skill of that name), 422 SKILL_ARCHIVE_INVALID; a Magnus without the action answers 409 MAGNUS_UPGRADE_REQUIRED.' },
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
  { method: 'GET', path: '/tasks/{taskId}/recovery', response: taskRecoveryResponseSchema, permissions: READ, idempotent: false, note: 'The task\'s Ardent recovery, read now through Magnus when the agent supports it (profile recovery >= 1, Magnus 3.3.0), else as last recorded with unavailable saying why (RECOVERY_UNSUPPORTED, MAGNUS_UNAVAILABLE, NOT_STARTED). A continuation decided elsewhere is followed by this read.' },
  { method: 'POST', path: '/tasks/{taskId}/recovery', requestBody: 'json', request: taskRecoveryRequestSchema, response: taskRecoveryDecisionResponseSchema, permissions: WRITE, idempotent: true, note: 'Sends a person\'s decision on a task Ardent holds awaiting_decision through Magnus (task-recovery). mark_applied, mark_not_applied and retry_with_new_deadline continue the work in an Ardent continuation task that the same Studio task follows (state running, ardent.attempts gains the old id); abandon ends the task as unknown. 409 RECOVERY_UNAVAILABLE when the task is not held, 409 RECOVERY_UNSUPPORTED (details capability, required_level, level, installed_version) when the agent cannot take decisions, 409 ARDENT_CONFLICT when Ardent refuses this action now, 422 INVALID_INPUT, 409 AGENT_UPGRADE_REQUIRED, 503 MAGNUS_UNAVAILABLE.' },
  { method: 'GET', path: '/tasks/{taskId}/lineage', response: taskLineageResponseSchema, permissions: READ, idempotent: false, note: 'Studio relationships of the task, the Ardent lineage of each of its Ardent attempts (profile lineage >= 1; otherwise ardent is null and ardent_unavailable says why) and the Emberpath trace filter. Attribution only.' },
  { method: 'POST', path: '/tasks/{taskId}/reassign', requestBody: 'json', request: reassignTaskRequestSchema, response: taskResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'Cancels the task when it is still active and creates the same work for another role, with reassigned_from.' },

  // Workflow runs
  { method: 'GET', path: '/projects/{projectId}/workflow-runs', query: listWorkflowRunsQuerySchema, response: listWorkflowRunsResponseSchema, permissions: READ, idempotent: false, note: 'Newest first, at most 50. active: running or blocked.' },
  { method: 'POST', path: '/projects/{projectId}/workflow-runs', requestBody: 'json', request: createWorkflowRunRequestSchema, response: workflowRunResponseSchema, permissions: WRITE, idempotent: true, successStatus: 201, note: 'Starts a workflow: an inline spec, or template_ref with the key of a workflow of that team template version. 400 VALIDATION_ERROR for a spec with more than 16 nodes, a cycle, an unknown need or other than exactly one output. Every role must be bound in the published team (409 TEAM_NOT_READY; 422 UNKNOWN_ROLE). Each node becomes an ordinary task of its role when all its needs are done, with their results and imported artifact references as context items (data). Progress arrives as workflow.run.* and workflow.node.updated.' },
  { method: 'GET', path: '/projects/{projectId}/workflow-runs/{runId}', response: workflowRunResponseSchema, permissions: READ, idempotent: false },
  { method: 'POST', path: '/projects/{projectId}/workflow-runs/{runId}/nodes/{nodeKey}/actions', requestBody: 'json', request: workflowNodeActionRequestSchema, response: workflowRunResponseSchema, permissions: WRITE, idempotent: true, note: 'retry: a failed node runs again as a new task (attempt + 1, source.workflow.retry_of). skip: a node that is not required is skipped (its task is cancelled when it runs); dependents go on without its result. cancel_run: the run is cancelled and its active node tasks with it. 409 ACTION_UNAVAILABLE when the node does not offer the action (see actions).' },

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

  // Audit
  { method: 'GET', path: '/audit/export', query: auditExportQuerySchema, response: auditExportResponseSchema, permissions: AUDIT_READ, orPermission: 'ardentstudio:agents:admin', accept: 'any', idempotent: false,
    note: 'Every audit record, oldest first, as HiveAuditRecord v1, keyset-paged on the record id. Accepts an Oathweave service token with ardentstudio:audit:read (no account link needed; native-issuer service tokens too when OATHWEAVE_NATIVE_ISSUERS lists the issuer), or a linked person with ardentstudio:audit:read or ardentstudio:agents:admin. 400 for a malformed cursor or limit. nextCursor is the last record\'s cursor whenever data is not empty, and null only when data is empty (caught up).' },

  // Stream
  {
    method: 'GET', path: '/projects/{projectId}/stream', query: streamQuerySchema, response: null, permissions: READ, idempotent: false,
    events: { '*': projectEventSchema, reset: resetEventSchema, heartbeat: heartbeatEventSchema, 'message.delta': messageDeltaEventSchema, 'project.purged': projectPurgedEventSchema },
    note: 'Persisted events carry their seq as the SSE id and replay after ?after= (or, without it, after the Last-Event-ID header a reconnecting EventSource sends). reset means the cursor is older than retained events (or ahead of them): refetch the snapshot. message.delta (live reply text) has no id; on connect each streaming message gets one replace delta with its current text. heartbeat every 15 s. The stream closes when the token expires or its session ends (reconnect with a fresh token), when the caller loses access to the project, and after project.purged (live only, no id).',
  },
];

/**
 * Path parameters that name a project record, in the order the project is taken from: the project
 * itself first, then the record whose project it is.
 */
export const PROJECT_SCOPED_PARAMS = ['projectId', 'linkId', 'fileId', 'conversationId', 'messageId', 'decisionId', 'taskId', 'deliverableId', 'revisionId', 'commentId'] as const;
export type ProjectScopedParam = typeof PROJECT_SCOPED_PARAMS[number];
const PROJECT_WRITE_PERMISSIONS: readonly ArdentStudioPermission[] = ['ardentstudio:projects:write', 'ardentstudio:review:write', 'ardentstudio:agents:admin'];

/**
 * The project record a route acts on and the project role it needs, or undefined for routes outside
 * any one project. Routes that change a project need editor, others viewer, unless projectRole says
 * otherwise. /blobs/{sha256} and /agents/operations/{operationId} check their project themselves.
 */
export function projectRoleOf(route: Pick<ArdentStudioBrowserRoute, 'path' | 'permissions' | 'projectRole'>): { param: ProjectScopedParam; role: ProjectRole } | undefined {
  const param = PROJECT_SCOPED_PARAMS.find(name => route.path.includes(`{${name}}`));
  if (!param) return undefined;
  const role = route.projectRole ?? (route.permissions.some(permission => PROJECT_WRITE_PERMISSIONS.includes(permission)) ? 'editor' : 'viewer');
  return { param, role };
}
