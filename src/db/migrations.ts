// Numbered, additive migrations. A released migration is never edited: its checksum is
// recorded when it runs and verified on every start. Add a new numbered entry instead.
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'foundation',
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brief_md TEXT NOT NULL DEFAULT '',
  audience TEXT,
  constraints_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_by TEXT NOT NULL,
  hivemem_workspace_id TEXT NOT NULL,
  hivemem_state TEXT NOT NULL DEFAULT 'pending' CHECK (hivemem_state IN ('pending', 'ready', 'failed')),
  hivemem_error TEXT,
  chattermost_channel_id TEXT,
  last_area TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX projects_status ON projects (status, updated_at);

CREATE TABLE requested_deliverables (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  formats_json TEXT NOT NULL,
  stage TEXT,
  producer_role_key TEXT,
  UNIQUE (project_id, name)
);

CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  size INTEGER NOT NULL CHECK (size >= 0),
  mime TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL REFERENCES blobs (sha256),
  purpose TEXT NOT NULL CHECK (purpose IN ('reference', 'attachment', 'avatar')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  knowledge_state TEXT NOT NULL CHECK (knowledge_state IN ('not_indexed', 'pending', 'indexing', 'indexed', 'failed', 'unsupported')),
  knowledge_source_id TEXT,
  knowledge_revision TEXT,
  knowledge_chunks INTEGER,
  knowledge_error TEXT,
  knowledge_attempts INTEGER NOT NULL DEFAULT 0,
  knowledge_next_attempt_at TEXT,
  knowledge_updated_at TEXT
);
CREATE INDEX files_project ON files (project_id, created_at);
CREATE INDEX files_knowledge ON files (knowledge_state, knowledge_next_attempt_at);
CREATE INDEX files_sha ON files (sha256);

CREATE TABLE agent_templates (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('seed', 'user')),
  archived INTEGER NOT NULL DEFAULT 0,
  latest_version INTEGER NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  purpose TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE agent_template_versions (
  template_id TEXT NOT NULL REFERENCES agent_templates (id),
  version INTEGER NOT NULL CHECK (version >= 1),
  body_json TEXT NOT NULL,
  changelog TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (template_id, version)
);
CREATE TABLE team_templates (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('seed', 'user')),
  archived INTEGER NOT NULL DEFAULT 0,
  latest_version INTEGER NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  purpose TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE team_template_versions (
  template_id TEXT NOT NULL REFERENCES team_templates (id),
  version INTEGER NOT NULL CHECK (version >= 1),
  body_json TEXT NOT NULL,
  changelog TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (template_id, version)
);
-- Template versions are immutable.
CREATE TRIGGER agent_template_versions_immutable BEFORE UPDATE ON agent_template_versions
BEGIN SELECT RAISE(ABORT, 'template versions are immutable'); END;
CREATE TRIGGER agent_template_versions_no_delete BEFORE DELETE ON agent_template_versions
BEGIN SELECT RAISE(ABORT, 'template versions are immutable'); END;
CREATE TRIGGER team_template_versions_immutable BEFORE UPDATE ON team_template_versions
BEGIN SELECT RAISE(ABORT, 'template versions are immutable'); END;
CREATE TRIGGER team_template_versions_no_delete BEFORE DELETE ON team_template_versions
BEGIN SELECT RAISE(ABORT, 'template versions are immutable'); END;

CREATE TABLE agent_bindings (
  id TEXT PRIMARY KEY,
  agent_ref TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE agent_presentation (
  agent_ref TEXT PRIMARY KEY,
  portrait_json TEXT,
  avatar_file_id TEXT REFERENCES files (id),
  display_name TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE team_assignments (
  project_id TEXT PRIMARY KEY REFERENCES projects (id),
  current_revision INTEGER,
  draft_revision INTEGER,
  updated_at TEXT NOT NULL
);
CREATE TABLE team_assignment_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'superseded')),
  source_template_id TEXT,
  source_template_version INTEGER,
  body_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_by TEXT,
  published_at TEXT,
  UNIQUE (project_id, revision)
);
-- A published revision's content never changes; only its status moves to superseded.
CREATE TRIGGER team_revisions_published_immutable BEFORE UPDATE OF body_json, source_template_id, source_template_version ON team_assignment_revisions
WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'published team revisions are immutable'); END;

CREATE TABLE room_layouts (
  project_id TEXT NOT NULL REFERENCES projects (id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  seats_json TEXT NOT NULL,
  placements_json TEXT NOT NULL,
  zone_labels_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, revision)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  kind TEXT NOT NULL CHECK (kind IN ('team', 'direct', 'discussion')),
  parent_id TEXT REFERENCES conversations (id),
  title TEXT NOT NULL,
  discussion_json TEXT,
  last_message_seq INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_at TEXT
);
CREATE INDEX conversations_project ON conversations (project_id, created_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  seq INTEGER NOT NULL,
  author_json TEXT NOT NULL,
  addressees_json TEXT NOT NULL DEFAULT '[]',
  reply_to TEXT REFERENCES messages (id),
  thread_root TEXT REFERENCES messages (id),
  kind TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  attachments_json TEXT NOT NULL DEFAULT '[]',
  links_json TEXT NOT NULL DEFAULT '{}',
  ardent_task_id TEXT,
  ardent_session_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('streaming', 'complete', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE UNIQUE INDEX messages_ardent_task ON messages (ardent_task_id) WHERE ardent_task_id IS NOT NULL;

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  title TEXT NOT NULL,
  statement_md TEXT NOT NULL,
  rationale_md TEXT NOT NULL DEFAULT '',
  source_json TEXT NOT NULL DEFAULT '[]',
  decided_by TEXT NOT NULL,
  superseded_by TEXT REFERENCES decisions (id),
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  title TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('turn', 'assignment', 'discussion_turn', 'revision', 'review', 'team_proposal')),
  role_key TEXT,
  binding_id TEXT REFERENCES agent_bindings (id),
  assignment_revision INTEGER,
  source_json TEXT NOT NULL DEFAULT '{}',
  mission_json TEXT,
  ardent_agent_ref TEXT,
  ardent_task_id TEXT,
  ardent_session_id TEXT,
  ardent_event_cursor INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'input_required', 'pausing', 'paused', 'completed', 'partial', 'failed', 'cancelled', 'unknown')),
  outcome_json TEXT,
  reassigned_from TEXT REFERENCES tasks (id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_project_state ON tasks (project_id, state);
CREATE UNIQUE INDEX tasks_ardent_task ON tasks (ardent_agent_ref, ardent_task_id) WHERE ardent_task_id IS NOT NULL;

CREATE TABLE activity (
  project_id TEXT NOT NULL REFERENCES projects (id),
  binding_id TEXT NOT NULL REFERENCES agent_bindings (id),
  state TEXT NOT NULL,
  label TEXT NOT NULL,
  source_json TEXT NOT NULL DEFAULT '{}',
  since TEXT NOT NULL,
  PRIMARY KEY (project_id, binding_id)
);

CREATE TABLE deliverables (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  requested_deliverable_id TEXT REFERENCES requested_deliverables (id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  producer_role TEXT,
  final_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE deliverable_revisions (
  id TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverables (id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  blob_sha256 TEXT NOT NULL REFERENCES blobs (sha256),
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  producer_binding_id TEXT REFERENCES agent_bindings (id),
  source_task_id TEXT REFERENCES tasks (id),
  source_message_id TEXT REFERENCES messages (id),
  ardent_json TEXT,
  supersedes_revision_id TEXT REFERENCES deliverable_revisions (id),
  received_at TEXT NOT NULL,
  review_status TEXT NOT NULL CHECK (review_status IN ('unreviewed', 'changes_requested', 'accepted', 'rejected', 'superseded')),
  UNIQUE (deliverable_id, revision)
);

CREATE TABLE review_comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  revision_id TEXT NOT NULL REFERENCES deliverable_revisions (id),
  anchor_json TEXT NOT NULL,
  body_md TEXT NOT NULL,
  author TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
  revision_task_id TEXT REFERENCES tasks (id),
  addressed_in_revision_id TEXT REFERENCES deliverable_revisions (id),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE review_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  revision_id TEXT NOT NULL REFERENCES deliverable_revisions (id),
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'changes_requested', 'rejected')),
  note_md TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  revision_ids_json TEXT NOT NULL,
  blob_sha256 TEXT NOT NULL REFERENCES blobs (sha256),
  manifest_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_drafts (
  id TEXT PRIMARY KEY,
  agent_ref TEXT NOT NULL,
  user_id TEXT NOT NULL,
  base_json TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent_ref, user_id)
);
CREATE TABLE development_comments (
  id TEXT PRIMARY KEY,
  agent_ref TEXT NOT NULL,
  record_ref TEXT NOT NULL,
  body_md TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Project event feed. seq is per project and assigned inside the inserting transaction.
CREATE TABLE project_event_cursors (
  project_id TEXT PRIMARY KEY REFERENCES projects (id),
  last_seq INTEGER NOT NULL DEFAULT 0,
  -- Events up to and including this seq were compacted away; older cursors get a reset.
  compacted_through INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE events (
  project_id TEXT NOT NULL REFERENCES projects (id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (project_id, seq)
);
CREATE INDEX events_at ON events (at);
CREATE TRIGGER events_append_only BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

-- Append-only audit of every mutation.
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_subject TEXT,
  actor_issuer TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  idempotency_key TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

CREATE TABLE idempotency_keys (
  actor_user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'complete')),
  status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_user_id, key)
);
CREATE INDEX idempotency_created ON idempotency_keys (created_at);
`,
  },
  {
    id: 2,
    name: 'conductor',
    sql: `
-- Message seq is per project, so a transcript across conversations has one order.
CREATE TABLE message_cursors (
  project_id TEXT PRIMARY KEY REFERENCES projects (id),
  last_seq INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX messages_project_seq ON messages (project_id, seq);
-- A direct conversation talks to one role.
ALTER TABLE conversations ADD COLUMN role_key TEXT;

-- Where a task's reply goes and the ordering group it waits in.
ALTER TABLE tasks ADD COLUMN conversation_id TEXT REFERENCES conversations (id);
ALTER TABLE tasks ADD COLUMN trigger_message_id TEXT REFERENCES messages (id);
ALTER TABLE tasks ADD COLUMN instructions_md TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN group_id TEXT;
ALTER TABLE tasks ADD COLUMN group_position INTEGER NOT NULL DEFAULT 0;
-- How the task reached Ardent: mission (TeamMission) or turn (task-submit with a composed prompt).
ALTER TABLE tasks ADD COLUMN dispatch TEXT CHECK (dispatch IN ('mission', 'turn'));
ALTER TABLE tasks ADD COLUMN submit_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN finished_at TEXT;
CREATE INDEX tasks_group ON tasks (group_id, group_position);
CREATE INDEX tasks_dispatch ON tasks (state, ardent_task_id);

-- One Ardent session per conversation, role, agent and Ardent session context.
CREATE TABLE agent_sessions (
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  role_key TEXT NOT NULL,
  agent_ref TEXT NOT NULL,
  context TEXT NOT NULL CHECK (context IN ('direct', 'mission')),
  project_id TEXT NOT NULL REFERENCES projects (id),
  session_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  -- The newest project message seq the agent has been shown in this session.
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, role_key, agent_ref, context)
);
`,
  },
  {
    id: 3,
    name: 'review',
    sql: `
-- One revision per Ardent artifact registration.
ALTER TABLE deliverable_revisions ADD COLUMN ardent_artifact_id TEXT;
CREATE UNIQUE INDEX deliverable_revisions_artifact ON deliverable_revisions (ardent_artifact_id) WHERE ardent_artifact_id IS NOT NULL;
CREATE INDEX deliverable_revisions_blob ON deliverable_revisions (blob_sha256);
CREATE INDEX exports_blob ON exports (blob_sha256);
ALTER TABLE review_comments ADD COLUMN updated_at TEXT;

-- Artifacts an agent registered, waiting to be streamed in from Magnus and verified.
CREATE TABLE artifact_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects (id),
  task_id TEXT NOT NULL REFERENCES tasks (id),
  agent_ref TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  ardent_event_seq INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'imported', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  error TEXT,
  revision_id TEXT REFERENCES deliverable_revisions (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent_ref, artifact_id)
);
CREATE INDEX artifact_imports_due ON artifact_imports (state, next_attempt_at);

-- A DOCX converted to the neutral Word exchange document. The codec gives paragraphs new ids on
-- every import, so the conversion is stored once per file or revision and anchors use its ids.
CREATE TABLE docx_documents (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('file', 'revision')),
  source_id TEXT NOT NULL,
  blob_sha256 TEXT NOT NULL REFERENCES blobs (sha256),
  codec TEXT NOT NULL,
  codec_version TEXT NOT NULL,
  -- The exchange document and canvas value, stored as a blob.
  document_sha256 TEXT NOT NULL REFERENCES blobs (sha256),
  -- [{id, text}] for every paragraph, to check anchors and quote them to agents.
  paragraphs_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_kind, source_id)
);
`,
  },
  {
    id: 4,
    name: 'agent_operations',
    sql: `
-- Magnus New Agent operations started from Studio, so their progress can be relayed to the
-- project stream and resumed after a restart. Magnus owns the operation; this is a mirror.
CREATE TABLE agent_operations (
  id TEXT PRIMARY KEY,
  agent_ref TEXT NOT NULL,
  project_id TEXT REFERENCES projects (id),
  role_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  operation_json TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX agent_operations_status ON agent_operations (status);
`,
  },
  {
    id: 5,
    name: 'links_counts_proposals',
    sql: `
-- Link references. The link record (title, URL, note) is synced to HiveMem as a knowledge source;
-- the linked page is never fetched. A deleted link keeps its row until its source is retired.
CREATE TABLE reference_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  note_md TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  knowledge_state TEXT NOT NULL CHECK (knowledge_state IN ('not_indexed', 'pending', 'indexing', 'indexed', 'failed', 'unsupported')),
  knowledge_source_id TEXT NOT NULL,
  knowledge_revision TEXT,
  knowledge_chunks INTEGER,
  knowledge_error TEXT,
  knowledge_attempts INTEGER NOT NULL DEFAULT 0,
  knowledge_next_attempt_at TEXT,
  knowledge_updated_at TEXT
);
CREATE INDEX reference_links_project ON reference_links (project_id, created_at);
CREATE INDEX reference_links_knowledge ON reference_links (knowledge_state, knowledge_next_attempt_at);

-- The project counts last announced with project.updated, so a change is announced once.
ALTER TABLE projects ADD COLUMN counts_json TEXT;

-- Team proposals asked of an agent. The proposal is stored, never applied.
CREATE TABLE team_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  agent_ref TEXT NOT NULL,
  role_key TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'failed', 'cancelled')),
  progress TEXT,
  task_id TEXT REFERENCES tasks (id),
  attempts_json TEXT NOT NULL DEFAULT '[]',
  basis_json TEXT NOT NULL,
  -- What the agent was given (brief, deliverables, templates, agents), so a retry asks the same.
  request_json TEXT NOT NULL,
  proposal_json TEXT,
  draft_body_json TEXT,
  error TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX team_proposals_project ON team_proposals (project_id, created_at);
`,
  },
  {
    id: 6,
    name: 'task_progress',
    sql: `
-- What the Ardent journal showed of a task's progress (the model started, the last tool tried),
-- so an agent's activity is derived from stored records after a restart.
ALTER TABLE tasks ADD COLUMN progress_json TEXT;
`,
  },
];
