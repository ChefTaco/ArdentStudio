# ArdentStudio API

Base path: `/api/ardentstudio/v1`. The authoritative contract is
[`openapi-browser.json`](openapi-browser.json), generated from
[`src/shared/browser.ts`](../src/shared/browser.ts). This page explains the conventions.

## Conventions

- **Authentication.** `Authorization: Bearer <Oathweave token>` with the audience
  `ardentstudio`. The person must have an explicit identity link (see [OATHWEAVE.md](OATHWEAVE.md)).
  Missing or invalid token: `401 UNAUTHENTICATED`. Valid token without a link:
  `403 NO_ACCOUNT_LINK`. Missing permission: `403 FORBIDDEN` with `details.missing`.
- **Project access.** Routes that act on a project, or on one of its records, also need a project
  role ([Project membership](#project-membership)). Without access to that project they answer
  `404 NOT_FOUND`, as for a record that does not exist; with too low a role,
  `403 PROJECT_ROLE_REQUIRED` with `details.required` and `details.role`. The contract publishes each
  route's role as `x-project-role` (`projectRoleOf()` in `browser.ts`).
- **Idempotency.** Every mutation requires `x-idempotency-key` (8-128 characters of
  `A-Z a-z 0-9 . _ : -`). Repeating a key with the same request replays the first answer and sets
  `idempotent-replayed: true`; reusing it for a different request answers
  `409 IDEMPOTENCY_KEY_REUSED`; a request still running answers `409 IDEMPOTENCY_IN_PROGRESS`.
  A failed request releases its key. Keys are scoped to the person and kept for a day.
- **Audit.** Every mutation writes an append-only audit row (who, what, which record, the key).
- **Request IDs.** Every response carries `x-request-id`: the caller's own (from `x-request-id`,
  `x-hive-request-id` or `x-correlation-id`) when it is 1-128 of `A-Z a-z 0-9 . _ : @ / + = -`,
  otherwise a generated UUID. W3C `traceparent` is continued. Log lines carry it as `requestId`.
- **Errors.** `{ "error": { "code": "…", "message": "…", "details": … } }`. Bodies are JSON, at most
  1 MiB, except file uploads.
- **Identifiers.** Prefixed ULIDs: `prj_`, `fil_`, `tpl_`, `trv_`, `bnd_`, `req_`, `cnv_`, `msg_`,
  `dec_`, `tsk_`, `dlv_`, `drv_`, `cmt_`, `rvd_`, `exp_`. Agents are `<nodeId>~<profile>`, the Magnus
  reference.
- **Additive responses.** Later releases may add fields; clients ignore what they do not know.

## Permissions

| Permission | Grants |
|---|---|
| `ardentstudio:projects:read` | Read projects, files, blobs, teams, agents, conversations, tasks, decisions and the stream; validate a team |
| `ardentstudio:projects:write` | Create and change projects, upload and reindex files, edit and publish teams, post messages, pin decisions, create and control tasks |
| `ardentstudio:templates:read` | Read templates and versions |
| `ardentstudio:templates:write` | Create templates, add versions, archive; save a project team as a template |
| `ardentstudio:review:write` | Comment on, accept, reject and finalize deliverables; request revisions (with projects:write); export |
| `ardentstudio:agents:admin` | New Agent, applying drafts and installing catalog skills through Magnus (Magnus also checks the acting person); read the audit export; owner of every project; purge archived projects |
| `ardentstudio:audit:read` | Read the audit export. The only permission an Oathweave service token can use, and only on that route |

## Routes

| Area | Route | Permission |
|---|---|---|
| Health | `GET /health/live`, `GET /health/ready` | none |
| Projects | `GET /projects?status=&q=&needs_review=&agentRef=` | projects:read |
| | `POST /projects` | projects:write |
| | `GET /projects/:id`, `GET /projects/:id/snapshot` | projects:read |
| | `PATCH /projects/:id`, `POST /projects/:id/archive`, `POST /projects/:id/reopen` | projects:write |
| | `POST /projects/:id/purge` | agents:admin |
| Members | `GET /projects/:id/members`, `GET /people?q=` | projects:read (`/people`: project owners and agents:admin) |
| | `PUT /projects/:id/members` | projects:read + project owner |
| Files | `POST /projects/:id/files?name=&purpose=` (raw body) | projects:write |
| | `GET /projects/:id/files`, `GET /blobs/:sha256` | projects:read |
| | `POST /files/:id/reindex`, `DELETE /files/:id`, `POST /projects/:id/reindex` | projects:write |
| Links | `GET /projects/:id/links` | projects:read |
| | `POST /projects/:id/links`, `PATCH /links/:id`, `DELETE /links/:id`, `POST /links/:id/reindex` | projects:write |
| Templates | `GET /templates?kind=&source=&archived=&q=`, `GET /templates/:id`, `GET /templates/:id/versions/:v` | templates:read |
| | `POST /templates`, `POST /templates/:id/versions`, `POST /templates/:id/archive` | templates:write |
| | `POST /templates/:id/versions/:v/definition` | templates:read |
| | `POST /templates/import-definition` | templates:write |
| | `POST /templates/:id/versions/:v/deploy-check`, `POST /templates/:id/versions/:v/deploy` | agents:admin |
| Team | `GET /projects/:id/team`, `POST /projects/:id/team/validate`, `GET …/team/proposals`, `GET …/team/proposals/:proposalId` | projects:read |
| | `PUT /projects/:id/team/draft`, `POST …/team/publish`, `POST …/team/apply-template`, `POST …/team/propose` | projects:write |
| | `POST …/team/save-as-template` | projects:read + templates:write |
| Agents | `GET /agents`, `GET /agents/:ref/presentation`, `GET /agents/:ref/draft`, `GET /agents/:ref/development`, `GET /agents/operations/:id` | projects:read |
| | `PUT /agents/:ref/presentation`, `PUT`/`DELETE /agents/:ref/draft`, `POST /agents/:ref/preview`, `POST /agents/:ref/development/:recordId/comments` | projects:write |
| | `POST /agents` (New Agent), `POST /agents/:ref/apply`, `POST /agents/:ref/skills/install` | agents:admin |
| Room | `GET /projects/:id/layout`, `GET /projects/:id/conversations`, `GET /conversations/:id/messages?after=&limit=` | projects:read |
| | `PUT /projects/:id/layout`, `POST /projects/:id/conversations`, `POST /conversations/:id/stop`, `POST /conversations/:id/messages`, `POST /messages/:id/answer`, `POST /messages/:id/follow-up` | projects:write |
| Decisions | `GET /projects/:id/decisions` | projects:read |
| | `POST /projects/:id/decisions`, `POST /decisions/:id/supersede` | projects:write |
| Tasks | `GET /projects/:id/tasks?state=&conversation_id=` | projects:read |
| | `POST /projects/:id/tasks`, `POST /tasks/:id/pause`, `…/resume`, `…/cancel`, `…/reassign` | projects:write |
| Workflows | `GET /projects/:id/workflow-runs?state=`, `GET /projects/:id/workflow-runs/:runId` | projects:read |
| | `POST /projects/:id/workflow-runs`, `POST /projects/:id/workflow-runs/:runId/nodes/:key/actions` | projects:write |
| Review | `GET /projects/:id/deliverables`, `GET /deliverables/:id`, `GET /revisions/:id`, `GET /revisions/:id/comments`, `GET /projects/:id/exports`, `GET /files/:id/docx`, `GET /revisions/:id/docx` | projects:read |
| | `POST /revisions/:id/comments`, `POST /comments/:id/resolve`, `POST /revisions/:id/decisions`, `POST /deliverables/:id/final`, `POST /projects/:id/exports` | review:write |
| | `POST /projects/:id/revision-requests` | review:write + projects:write |
| Stream | `GET /projects/:id/stream?after=<seq>` (or `Last-Event-ID`) | projects:read |
| Audit | `GET /audit/export?after=&limit=` | audit:read (people or services) or agents:admin (people) |

## Projects

`POST /projects` takes `name`, `brief_md`, `audience`, `constraints[]`, `tags[]` and
`deliverables[]` (`name`, `kind`, `formats` from md, txt, docx, pdf, svg, png, jpeg, webp, csv,
json, optional `stage` and `producer_role_key`). It creates the project's HiveMem workspace in the
background: `hivemem.state` is `pending`, then `ready`, or `failed` with an error and retried.

An archived project is read-only (`409 PROJECT_ARCHIVED`) except `last_area`. Archive answers
`409 TASKS_ACTIVE` with the tasks while any Studio task is still active.

### Project membership

A project starts open to everyone linked (`mode: "everyone"`, as every project from before
membership is): its creator (`created_by`) is its owner and every other linked person an editor. An owner, or a
person holding `ardentstudio:agents:admin`, can limit it to listed members with
`PUT /projects/:id/members`:

```json
{"base_revision": 0, "mode": "members", "members": [
  {"kind": "subject", "subject": "example-subject", "issuer": null, "role": "owner"},
  {"kind": "oathweave_role", "name": "studio-reviewers", "role": "viewer"}
]}
```

- `subject` entries match an Oathweave subject (from any accepted issuer when `issuer` is null);
  `oathweave_role` entries match everyone whose token carries that Oathweave role, directly or
  through an Oathweave group. A person gets the highest role that matches; nobody else has access.
- Roles: `viewer` reads (routes needing only read permissions, including team validation and the
  stream), `editor` also changes the project and its records (routes needing projects:write,
  review:write or agents:admin), `owner` also edits the membership. A role only narrows: the route's
  permissions are still required. A Studio admin is the owner of every project.
- `mode: "members"` needs an owner (`422 OWNER_REQUIRED`); `mode: "everyone"` lists nobody
  (`422 MEMBERS_NOT_ALLOWED`) and opens the project to everyone linked again. A caller who is not an
  admin must still be an owner afterwards (`422 SELF_LOCKOUT`). A stale `base_revision` answers
  `409 VERSION_CONFLICT` with the current `revision`.
- Every change is audited as `project.members` (the full list) and announced as
  `project.members.updated` (`{mode, revision}`). Open streams of people it removes close at once.
- `GET /projects` lists only the projects the caller can see, and every summary carries
  `access: {mode, role}`, the caller's own. `GET /projects/:id/members` returns the mode, revision,
  members (subjects with the linked `user_id` and `display_name` when an account link names them) and
  the caller's access.
- `GET /people` lists the account links (`user_id`, `subject`, `issuer`, `display_name`) to choose
  members from. It names every linked person, so it answers only people who can edit a members list:
  holders of `ardentstudio:agents:admin` and the owner of at least one project (one they created that
  is still open to everyone linked, or one whose members list them, or an Oathweave role they hold, as
  `owner`; archived projects count). Anyone else gets `403 PROJECT_ROLE_REQUIRED` with
  `details.required: "owner"`. `?q=` (up to 200 characters) keeps people whose user id, subject, display
  name or a word of the display name starts with it, case-insensitively, and returns at most 50 of
  them; `truncated` is `true` when more matched. Without `q` (or with an empty one) every linked person is returned and
  `truncated` is `false`.
- Records of a restricted project stay out of reach elsewhere too: `/blobs/:sha256` serves bytes only
  to people who can see a project that references them (or when an agent portrait uses them), agent
  role lists and `?agentRef=` show only visible projects, `GET /agents/operations/:id` of a project
  operation needs its project, and `project_id` on `POST /agents` and template deploys needs editor.
- Studio has no route that queries HiveMem knowledge for people. A project's workspace is owned by
  Studio's HiveMem service identity, and HiveMem limits it to its own members; Studio does not add people
  to it.

### Purge

`POST /projects/:id/purge` with `{"confirm_name": "<the exact project name>"}` deletes an archived
project for good (`ardentstudio:agents:admin` only). It removes the project's events, files, links,
team, room, conversations and messages, tasks, workflow runs, deliverables, revisions, reviews and
exports in one transaction, and answers `{project_id, name, purged_at, removed: {<kind>: <rows>},
knowledge: {sources_retiring}}`. Afterwards:

- bytes nothing else references are removed (at once when older than ten minutes, else by the hourly
  sweep);
- the HiveMem sources of its references and links are retired with empty syncs, retried with backoff
  until HiveMem takes them; the project's HiveMem workspace is kept;
- audit records are kept and the purge is audited as `project.purge` (name and row counts);
- open streams of the project get `project.purged` (`{project_id, at}`, live only) and close.

It answers `409 PROJECT_NOT_ARCHIVED`, `422 CONFIRMATION_MISMATCH` (compared exactly, with case and
spaces), `409 TASKS_ACTIVE` and `409 FILE_IN_USE` (`details.agents`: an agent portrait uses one of its
files; portraits are shown in every project). Repeating the request with its idempotency key replays
the answer; otherwise the project is gone (`404`).

`GET /projects/:id/snapshot` returns the project and its list summary, its files and links, its
team, conversations, active tasks, decisions, agent activity, room layout and open team proposals,
with the `seq` they are consistent with. Open the stream with `?after=<seq>` to continue from it.
Without `?after`, the stream continues after the `Last-Event-ID` header, which a browser `EventSource`
sends on its own when it reconnects; with neither it starts at the current cursor. A subscriber that
reads slowly never makes Studio queue without limit: past 1000 waiting messages, the waiting events are
read again from the event log and the waiting live deltas become one `replace` delta per streaming
message, so nothing is lost. On shutdown the stream ends; reconnect with the last `seq`.

### Summaries

`GET /projects` and the snapshot's `summary` carry counts derived from stored records only:

| Field | Meaning |
|---|---|
| `open_questions` | Agent clarifications nobody has answered |
| `review_pending` | Deliverable revisions that are `unreviewed`, or `changes_requested` with no newer revision yet |
| `active_tasks` | Studio tasks that are `queued`, `running`, `input_required`, `pausing` or `paused` |
| `last_activity` | `{type, at, text}` for the newest room message, pinned decision, received or reviewed revision, added reference or link, published team, export, or the project's creation or archiving. `text` is built from that record alone, for example `Story Lead asked: Which tone?`. Presence, sync progress and other bookkeeping never count. |

`?needs_review=true` keeps projects with `review_pending > 0` (`false` the others).
`?agentRef=<magnusNodeId>~<profile>` keeps projects where that agent is bound to a role in the
published or the draft team (an agent with no roles gets `[]`); it combines with the other filters,
only narrows what the caller can already list, and a malformed value is a `400 VALIDATION_ERROR`.

When a change alters a project's counts, the same transaction emits `project.updated` with
`{fields: ["counts"], counts}`, once per change. `last_activity` is not announced on its own: it
moves with the events that create its records (`message.created`, `decision.created`,
`deliverable.revision.created`, `review.decision.created`, `file.created`, `link.created`,
`team.revision.published`, `export.created`), so a client refetches the list or snapshot on those.

## Files and knowledge

Upload the raw bytes with their `Content-Type` (`text/markdown`, `text/plain`, `text/csv`,
`application/json`, `application/pdf`, DOCX, PNG, JPEG, WebP, GIF, SVG), up to
`ARDENT_STUDIO_MAX_BLOB_BYTES`. The bytes must be what the type says, checked as they arrive and before
anything is stored: PNG, JPEG, GIF, WebP, PDF and DOCX by their leading bytes, JSON must parse (up to
8 MiB; larger JSON must be UTF-8), SVG must contain an `<svg>` element, and plain text, Markdown and CSV
must not contain NUL bytes (any encoding is accepted). A mismatch answers `422 CONTENT_MISMATCH`. Bytes are
stored by SHA-256 and served only through a file that references them, always as
`application/octet-stream` attachments (the recorded type is in `X-Blob-Mime`).

`DELETE /files/:id` deletes a file. It leaves the file list, the snapshot and `/blobs` at once and is
announced as `file.deleted`. A reference file answers `knowledge: retiring` unless it never syncs
(`not_indexed` or `unsupported`, with no synced revision): its HiveMem source is retired with an empty sync
(harmless when HiveMem holds nothing for it), retried until HiveMem takes it, and the file is removed after
that; any other file answers `knowledge: none` and is removed at once. The
bytes are removed by the hourly sweep once no file, revision, rendition, export or conversion references
them. `409 FILE_IN_USE` (with `details.agents` and `details.roles`) while an agent portrait or a role of
the current or draft team names the file. Message attachments that named it stay in the transcript.
`POST /projects/:id/reindex` queues every reference file and link of the project for HiveMem sync again.

`purpose=reference` files are synced into the project's HiveMem workspace as one knowledge source
per file (`source_id` `ardentstudio:file:<file id>`, revision = the file's SHA-256), preview first,
then apply. `knowledge.state` is `pending`, `indexing`, `indexed`, `failed` (retried with backoff,
or `POST /files/:id/reindex`) or `unsupported` (images, and DOCX, whose text extraction is not available yet).
Attachments and avatars are `not_indexed`.

### Links

`POST /projects/:id/links` takes `url` (http or https, up to 2048 characters, no user name or
password), `title` and an optional `note_md`. The URL is stored in its normalized form; a project
holds each URL once (`409 LINK_EXISTS`). Studio never fetches the page. HiveMem's knowledge source
API takes text, so each link is synced as one source (`source_id` `ardentstudio:link:<link id>`,
`source_uri` the URL, revision the SHA-256 of the text) holding one chunk with the title, URL and
note; `knowledge.state` moves like a file's. Editing a link resyncs it; `DELETE /links/:id` marks
it deleted and retires its source with an empty sync (`knowledge.state` then `not_indexed`).
Events: `link.created`, `link.updated` (also on every sync state change) and `link.deleted`, each
with `{link}`.

## Templates

Agent and team templates have immutable versions. `POST /templates/:id/versions` needs the
`base_version` it edits; a newer version answers `409 VERSION_CONFLICT`. Seed templates (Research
Team, Development Team, Adventure Studio, Deliberation Panel and their agent templates) are loaded on start
when absent and are never overwritten. Bodies that look like they contain credentials answer
`422 CREDENTIAL_LIKE_VALUE`; team templates with structural errors answer `422 TEAM_INVALID`. A team template may also define
workflows ([Workflows](#workflows)).

An agent template skill may pin a HiveSkills release: `{kind: "hiveskills", ref, version, sha256}`
(both or neither; only on `hiveskills` skills). Agent template versions carry `source_definition`
(`{name, sha256}`, or `null`): the agent definition the version was imported from.

### Agent definitions

A `hive-agent-definition/1` is one portable, complete agent definition as Magnus 3.3.0 validates and
installs it: persona, runtime, reviewed extensions and HiveSkills releases by reference, the portable
configuration and the bindings and secrets a target must supply. It never carries a credential and
always excludes history, memory, sessions and artifacts. `sha256` is the SHA-256 of its canonical JSON
(sorted keys, no whitespace) without `sha256`; `persona.sha256` that of `{soul_md, identity_md}`.
Studio checks, seals and digests definitions with `@hivemagnus/magnus-contracts` itself (`agent-definition`,
Magnus 3.3.0 and later); the browser contract repeats only the shape, and a test keeps the two equal.

- **Build** (`POST /templates/:id/versions/:v/definition`, empty body) answers `{definition, omitted}`
  for an agent template version. Nothing is stored; `created_at` is the version's, so one version always
  has one digest.
  - `persona`: the template's `soul_md` and `identity_md` (`422 DEFINITION_INCOMPLETE` when one is empty).
  - `skills`: the pinned HiveSkills skills (`slug`, `version`, `sha256`). Local skills, unpinned
    HiveSkills skills and refs that are not catalog slugs go to `omitted` (`{kind: "skill", name, reason}`).
  - `config.model.emberpath_alias`: the `model_hint` when it is an Emberpath alias; otherwise `omitted`
    has `{kind: "model", name: "model_hint"}` and the target binds `model`.
  - `runtime`: `@hivemagnus/ardent` at the template's `runtime_req.ardent` version when it is a later
    3.x or newer, else `3.0.0`. Studio's features need Ardent 2.2.0 and fall back when newer
    capabilities are missing, so `required_capabilities` is empty; Magnus accepts only the same major
    version at or above the defined one, so the floor is the first release of the current major line.
  - `config.execution.backend`: the template's backend; `any` becomes `llamacpp`, the backend Magnus
    New Agent provisions.
  - `requirements.bindings`: `hivemem` (required), `model` (`emberpath_alias`, required unless the
    definition names an alias) and, with skills, `hiveskills` (required). No secrets; no extensions.
  - `source_template`: `{template_id, version}`.

  The credential guard runs over the whole answer (`422 DEFINITION_CONTAINS_CREDENTIAL`).
- **Import** (`POST /templates/import-definition`, `{definition, template_id?, base_version?,
  changelog?}`) checks the definition (credential guard over the whole request, then the schema and both
  digests: `422 DEFINITION_CONTAINS_CREDENTIAL` or `422 DEFINITION_INVALID`) and stores it as a new
  immutable agent template version with `source_definition: {name, sha256}`:
  - of `template_id` (with `base_version`, else `400`),
  - else of the definition's `source_template` when that agent template exists here, based on
    `base_version` or the `source_template` version,
  - else of a new user template (`created: true`).

  A newer latest version answers `409 VERSION_CONFLICT` with `latest_version`; an archived template
  `409 TEMPLATE_ARCHIVED`. The persona, pinned skills, model alias, runtime version and backend map onto
  the body; an existing template keeps its category, examples, outputs, portrait, integrations and local
  skills. What a template cannot hold (extensions, runtime capabilities, execution and artifact limits,
  secrets, channel and peer bindings) is listed in `ignored` (`{path, reason}`). The answer is `{template,
  version, created, source_definition, ignored}`.
- **Deploy check** (`POST /templates/:id/versions/:v/deploy-check`, `{node_id, bindings?,
  emberpath_client_key?}`) builds the
  version's definition and asks Magnus (`POST /ardent/agent-definitions/validate`) as the acting
  person, whom Magnus requires to be a linked Magnus ADMIN. The answer is `{definition: {name, sha256},
  omitted, preflight: {ok, problems: [{code, detail}]}}` with Magnus's codes (`MISSING_BINDING`,
  `SKILL_VERSION_UNAVAILABLE`, `EXTENSION_NOT_REVIEWED`, `RUNTIME_INCOMPATIBLE`, `CAPABILITY_MISSING`,
  `SECRET_UNBOUND`). Bindings are `{key: target}`: `hivemem` to `default` or the workspace, `model` to an
  Emberpath alias, `hiveskills` to `default`. A Magnus without agent definitions (before 3.3.0) answers
  `409 MAGNUS_UPGRADE_REQUIRED`; an unknown node `404`.
- **Emberpath client key.** A definition whose model is an Emberpath alias (backend `llamacpp`) needs the
  client key the operator created in Emberpath, as `emberpath_client_key` (16 to 512 characters without
  whitespace) on the deploy check and the deploy. Studio relays it to Magnus, which checks it with
  Emberpath and delivers it to the new profile. Without it the preflight reports `SECRET_UNBOUND`
  (`Emberpath key missing`); a key Emberpath refuses is reported as `SECRET_UNBOUND` too (`MISSING_BINDING`
  when the key may not use the alias), and the deploy answers `409 PREFLIGHT_FAILED`. The key is
  write-only: Studio never stores, logs, audits or returns it, and the idempotency fingerprint leaves it
  out (the same deploy with another key replays). Magnus's own `EMBERPATH_*` refusals keep their status
  and code. It needs Magnus 3.5.0 or later; an older Magnus refuses the field.
- **Create agent from definition** (`POST /templates/:id/versions/:v/deploy`, `{node_id, profile,
  bindings, emberpath_client_key?, api_port?, project_id?, role_key?}`) has Magnus install the definition as a new profile
  (`POST /ardent/agent-definitions/install`), a New Agent operation of kind `definition` that starts only
  when the preflight passes: otherwise `409 PREFLIGHT_FAILED` with `error.details.problems` and nothing is
  created. The answer and the `agent.operation.updated` events are those of New Agent.

## Team assignment

A project has at most one draft and one current (published) revision. `PUT …/team/draft` takes the
`base_revision` it builds on; a newer published revision answers `409 TEAM_REVISION_CONFLICT`.
`POST …/team/publish` answers the same code when the draft was saved again while it was being validated.
Roles bind agents by `agent_ref`; the server assigns a stable `binding_id`.

Validation (`POST …/team/validate`, and in every team response):

| Severity | Code |
|---|---|
| error | `coordinator_count`, `reporting_cycle`, `workflow_cycle` (hand-offs other than a `revise` loop), `deliverable_without_producer`, `duplicate_role_key`, `unknown_role`, `self_relationship`, `multiple_managers`, `coordinator_reports` |
| warning | `unbound_role`, `reviewer_is_only_producer`, `skill_not_enabled`, `agent_unavailable`, `agent_without_hivemem`, `outside_reporting_tree`, `agent_facts_unavailable` |

### Team proposals

`POST /projects/:id/team/propose` (`{agent_ref?}`) asks one agent for a team: the chosen agent, or
the bound coordinator of the draft team (else the current one). It must be a Magnus-managed agent
that is available (`422 UNKNOWN_AGENT`, `409 AGENT_UNAVAILABLE`, `409 NO_COORDINATOR`,
`503 MAGNUS_UNAVAILABLE`), and one proposal runs at a time per project (`409 PROPOSAL_IN_PROGRESS`).
Studio queues a `team_proposal` task (see [CONDUCTOR.md](CONDUCTOR.md#team-proposals)) with the
brief, requested deliverables, the current team, the team and agent template catalog and the
available agents, and answers `201` with the proposal record in state `queued`.

The reply must be one `TeamProposal` JSON object (`teamProposalSchema`): `rationale`,
`source_template`, `roles[]` (role fields plus `rationale`), `relationships[]`, `stages[]` and
`bindings[]` (`{role_key, agent_ref, reason}`). Besides the schema, Studio checks that role keys are
unique, exactly one role coordinates, relationships and bindings name proposed roles, bindings name
listed agents, templates exist, the team rules hold (reporting tree, hand-off cycles) and every
requested deliverable has a producer. An invalid reply is asked again once with the validation
error; a second invalid reply, or a task that fails, ends the proposal `failed` with `error`.

| Record field | Meaning |
|---|---|
| `state` | `queued` (also between attempts), `running`, `ready`, `failed`, `cancelled` |
| `progress` | One line from real records: waiting, preparing, correcting, the outcome |
| `attempts[]` | `{attempt, task_id, outcome, error}`, at most two; `outcome` is `pending`, `valid`, `invalid`, `failed` or `cancelled` |
| `basis` | The current and draft revisions and template the proposal was asked against |
| `proposal` | The validated proposal (`ready` only) |
| `draft_body` | The proposal as a `PUT …/team/draft` body: suggested bindings filled in, knowledge kept for role keys of the basis team |

Progress arrives as `team.proposal.updated` (`{proposal}`) on the project stream, plus the usual
`task.*` events for its task. Nothing is applied: the browser shows the difference and sends the
parts a person accepts with `PUT …/team/draft`. Cancel a proposal by cancelling its `task_id`.

`can_publish` means no errors; publishing with errors answers `409 TEAM_INVALID`.
`can_start_room` also needs the coordinator bound to an available agent. Agent facts come from
Magnus; when Magnus cannot answer, `agent_facts` says `partial` or `unavailable`.

## Agents

`GET /agents` lists the Magnus-managed Ardent profiles with Studio presentation and the project
roles they hold. When Magnus is unavailable the list is empty and `magnus.state` is `unavailable`.

Agent Studio (`:ref` is `<nodeId>~<profile>`):

- **Presentation** is Studio-only: display name, portrait preset or an `avatar` file.
- **Drafts.** Each person has one draft per agent: `soul`, `identity`, `skills_enabled` (the complete
  enabled set) and `model`, with the `base` revisions it was made from. Omitted soul and identity
  revisions are read from the agent through Magnus when the draft is saved, and the configuration
  revision too when the draft changes skills or the model (Magnus lets only an ADMIN read it).
- **Preview** (`POST /agents/:ref/preview`, `prompt`, `use_draft`, `new_session`) streams an Ardent
  preview task as server-sent events: `preview.accepted` (`task_id`, `session_id`),
  `preview.text`/`preview.delta` (live reply text), `preview.event` (journal `sequence` and `kind`
  only), then `preview.done` (`state`, `result`, `error`) or `preview.error`. A preview writes no
  memory, development records, identity or configuration, uses no mission tools, and its files
  expire. It needs the agent's Magnus node agent at Studio level 2 with Ardent 2.2.0; otherwise
  `409 PREVIEW_UNAVAILABLE`. Sending the same `x-idempotency-key` again streams the same task.
- **Apply** (`POST /agents/:ref/apply`, `parts`) writes parts of the draft through Magnus as the
  acting person, whom Magnus requires to be a linked Magnus ADMIN, in the order soul, identity,
  skills, model:
  - `soul` and `identity`: `identity-save` against the base revision.
  - `skills`: one `skill-set` per skill that changes, each against the configuration revision the
    previous change answered (the first against `base.config_revision`).
  - `model`: reads `config.yaml` through Magnus, refuses when its revision is not the draft's base,
    sets only `providers.llamacpp.model` (or `providers.codex.model` when `execution.backend` is
    `codex`) with a YAML edit that keeps the rest of the document, checks that nothing outside
    Magnus's allowed settings changed, and sends it with `config-save`.

  Results are per part: `applied`, `unchanged` or `failed` with a code: `ACTING_ADMIN_REQUIRED`,
  `ACTING_SUBJECT_UNLINKED`, `CONFIG_PATH_FORBIDDEN`, `CONFLICT` (the agent changed since the draft
  was saved), `INVALID_INPUT` (Magnus or Ardent rejected the value), `CONFIG_REVISION_REQUIRED`,
  `BASE_REVISION_MISSING`, `UNKNOWN_SKILL`, or Magnus's own code. Applied parts leave the draft; a
  draft that still changes configuration is rebased on the newest configuration revision.
  Skill and model changes take effect after the profile restarts: their results and the response
  carry `activation_required`. Magnus does not let Studio's service identity run `service-restart`,
  so `restart.available` is `false` and the restart is done in Magnus (the UI's Magnus Ardent installations page). `active_tasks`
  counts Studio tasks still running on the agent; they keep the instructions they started with.
- **Install a catalog skill** (`POST /agents/:ref/skills/install`, `{source: "hiveskills", name,
  version, channel?, enable?, revision?}`) runs Magnus's `skill-install` as the acting person, whom
  Magnus requires to be a linked Magnus ADMIN. Magnus fetches that HiveSkills release from its
  configured registry, checks it against the catalog digest and installs it; with `enable` and the
  configuration revision it also enables it. The answer is Magnus's (`changed`, `enabled`,
  `revision`, `enable_error`, `activation_required`, …) with a `note` and `restart` as for Apply; a
  failed enable leaves the skill installed. Magnus's refusals keep their codes:
  `HIVESKILLS_UNCONFIGURED` (503), `SKILL_VERSION_UNAVAILABLE` and `SKILL_CONFLICT` (409),
  `SKILL_ARCHIVE_INVALID` (422), `AGENT_UPGRADE_REQUIRED` (409, the node agent is below Studio level 3),
  `ACTING_ADMIN_REQUIRED` (403); a Magnus without the action answers 409 `MAGNUS_UPGRADE_REQUIRED`.
  The audit records the skill, version, digest and outcome.
- **Development** (`GET /agents/:ref/development?after=&limit=&kind=`) lists the agent's Ardent
  development records (`author`, `epistemic` such as `agent_reported`, sources) with Studio comments.
  A runtime that does not publish them answers `supported: false` with the reason. A comment with
  `relay_to_agent` is also recorded in the agent's history as an operator note.
- **New Agent** (`POST /agents`) asks Magnus to deploy a new Ardent profile as the acting person
  (Magnus requires a Magnus ADMIN: `403 ACTING_ADMIN_REQUIRED`), always with HiveMem. An agent
  template version fills the soul, identity, local skills and Studio portrait. An `emberpath_alias`
  model needs the write-only `emberpath_client_key` (see the Emberpath client key above): Magnus
  answers `400 EMBERPATH_KEY_REQUIRED` without it, `409 EMBERPATH_NOT_EXPLICIT`, or `422
  EMBERPATH_KEY_INVALID`, `EMBERPATH_KEY_FORBIDDEN` or `EMBERPATH_ALIAS_UNAVAILABLE`, which Studio passes
  on. Progress is relayed as `agent.operation.updated` on the `project_id` stream;
  `GET /agents/operations/:id` reads it.

## Room

The conductor that starts and follows agent turns is described in [CONDUCTOR.md](CONDUCTOR.md).

- **Conversations.** One `team` conversation per project (creating it again answers the existing
  one), `direct` conversations with one role, and `discussion` conversations. A discussion takes
  `question`, `desired_output` (`decision`, `short_doc`, `options`), `participants` (role keys) and
  `max_rounds` (1-4); it posts the question and runs the rounds at once. `POST
  /conversations/:id/stop` stops it: unstarted turns are cancelled, started ones are cancelled
  through Magnus.
- **Messages.** The transcript is canonical. `seq` is per project, so all conversations share one
  order. `POST /conversations/:id/messages` takes `body_md`, `to` (`{kind: "team"}`,
  `{kind: "coordinator"}` or `{kind: "roles", roles: [...]}`), optional `reply_to`, `thread_root`
  and `attachments` (project file ids). Team and Coordinator start a coordinator turn; roles and
  `@role_key` mentions start one turn per addressee, in order, each after the previous one
  finishes. It answers the stored message and the queued tasks; replies arrive on the stream.
  Without a published team, or with an unbound addressee, it answers `409 TEAM_NOT_READY`.
- **Message kinds.** `message` (a person), `reply` (an agent's turn; `state` `streaming` while live
  text arrives, then `complete` or `failed`), `summary` (a discussion summary), `clarification`
  (an agent's question with `links.question`, `links.options` and `links.answer_message_id`),
  `answer`, `decision_proposal` (`links.proposal`, `links.decision_id` once a person pins it),
  `handoff` (`links.handoff`), `discussion_question` and `system` (Studio notes such as a refused
  hand-off or a turn that could not start). `links.task_id` names the Studio task.
- **Clarifications.** `POST /messages/:id/answer` (`body_md`, optional `option`) posts the answer
  and starts a turn for the same role in the same conversation, so it continues the same Ardent
  session. A second answer is `409 ALREADY_ANSWERED`.
- **Layout.** `PUT /projects/:id/layout` saves a new revision of seats, placements and zone
  labels; `base_revision` must be the latest (`409 LAYOUT_CONFLICT`).

## Decisions and tasks

Decisions are pinned by people (`source_message_id` links a proposal card); `supersede` creates the
new decision and marks the old one. Tasks mirror Ardent states plus `pausing`; `input_required`
waits for a person's answer. `POST /projects/:id/tasks` creates an `assignment` or `review` task
for a role. Pause takes effect at Ardent's next step boundary (`pausing`, then `paused`); an agent
whose Magnus node agent predates pausing answers `409 AGENT_UPGRADE_REQUIRED`. An unstarted task is
held instead. `reassign` cancels an active task and creates the same work for another role with
`reassigned_from` (a workflow node's task answers `409 NOT_REASSIGNABLE`: retry or skip the node).

Every task carries `execution` (`{root, parent, self, attempt, inputs}`, qualified `hx1:` references,
or null), `ardent.attempts` (earlier Ardent task ids, oldest first) and `recovery` (the last Ardent
recovery Studio observed, or null).

- **Recovery** ([CONDUCTOR.md](CONDUCTOR.md#recovery)). `recovery` is Ardent's C3 object
  (`status`, `reason {code, message}`, `attempt`, `checkpoint {step, completed_calls,
  pending_calls[{call_id, tool, effect, dispatched_at, reconcilable}]}`, `actions`,
  `continuation_task_id`, `decided {action, by, at, note}`) plus `supported` and `observed_at`.
  `actions` are only those Studio can send now: empty when `supported` is false. A `running` task
  with a `ready`, `reconciling` or `resumed` recovery is recovering; an `unknown` task with
  `awaiting_decision` waits for a decision.
  - `GET /tasks/:id/recovery` → `{task, recovery, supported, source: live|stored, unavailable:
    {code, message}|null}`. It reads the recovery through Magnus when the agent supports it, else
    answers the stored one with `unavailable.code` `RECOVERY_UNSUPPORTED`, `MAGNUS_UNAVAILABLE` or
    `NOT_STARTED`. A continuation decided elsewhere is followed by this read.
  - `POST /tasks/:id/recovery` (`x-idempotency-key`) with `{action, call_id?, result?, note?,
    deadline_seconds?}`; `action` is `mark_applied`, `mark_not_applied`,
    `retry_with_new_deadline` or `abandon`, `result` (JSON, at most 64 KiB) goes with `mark_applied`
    and `deadline_seconds` with `retry_with_new_deadline`. It answers `{task, recovery}`: after a
    continuing action the task is `running` again under `recovery.continuation_task_id` with the old
    Ardent id in `ardent.attempts`; after `abandon` it stays `unknown` with its final message.
    `409 RECOVERY_UNAVAILABLE` (not held), `409 RECOVERY_UNSUPPORTED` (`details`: `capability`,
    `required_level`, `level`, `installed_version`, or the profile's own `capability`,
    `required_version`, `installed_version`), `409 ARDENT_CONFLICT` (Ardent refuses that action now),
    `422 INVALID_INPUT`, `409 AGENT_UPGRADE_REQUIRED`, `503 MAGNUS_UNAVAILABLE`.
  - `task.recovery` events: `{task_id, change, recovery, ardent_task_id, previous_ardent_task_id?}`
    with `change` `recovering`, `held`, `continued`, `resolved` or `unsupported`, next to the usual
    `task.updated`.
- **Lineage** ([CONDUCTOR.md](CONDUCTOR.md#lineage)). `GET /tasks/:id/lineage` →
  `{task_id, studio: {self, root, parent, execution, children, reassigned_from, reassigned_to,
  handoffs, assignment_revision, revisions, workflow}, ardent: {agent_ref, attempts[{ardent_task_id,
  ref, current, lineage, error}]}|null, ardent_unavailable: {code, message}|null, emberpath: {filter:
  {executionRoot}}}`. Tasks in `children`, `reassigned_*` and `handoffs` are `{task_id, ref,
  role_key, state, mode}` (hand-offs add `direction: from|to` and `relationship`); `revisions` are
  the deliverable revisions the task produced. `lineage` is the profile's Ardent lineage relayed
  as-is (`task_id`, `execution`, `parent`, `children`, `continuations`, `model_attempts`, `tools`,
  `artifacts`). `ardent_unavailable.code` is `LINEAGE_UNSUPPORTED`, `MAGNUS_UNAVAILABLE` or
  `NOT_STARTED`.

## Workflows

A workflow is a small DAG of sub-prompts whose nodes run as ordinary tasks of team roles
([CONDUCTOR.md](CONDUCTOR.md#workflows)). `POST /projects/:id/workflow-runs` takes either an inline
`spec` or `template_ref` (`{template_id, version}`) with `workflow`, the key of a workflow in that
team template version's `workflows`, plus optional `inputs` (up to 16 string values every node
receives as data):

```json
{ "spec": { "name": "Valley research", "output": "synthesis", "nodes": [
    { "key": "research_a", "role": "writer", "prompt": "Research the drowned valley villages." },
    { "key": "research_b", "role": "mapper", "prompt": "Map the flooded roads.", "required": false },
    { "key": "synthesis", "role": "lead", "prompt": "Write the outline from both notes.", "needs": ["research_a", "research_b"] } ] },
  "inputs": { "tone": "grim" } }
```

- **Spec.** At most 16 nodes. A node has `key`, `role` (a role of the published team), `prompt` (up
  to 20 000 characters), optional `title`, `needs` (node keys), `required` (default `true`) and
  `join` (`all`). The graph must be acyclic, every need must exist, and there is exactly one output:
  `output` names a required node that no node needs and that every other node leads to. Anything
  else is `400 VALIDATION_ERROR` with the issues in `details`. A role the team does not have is
  `422 UNKNOWN_ROLE`; an unbound role or no published team is `409 TEAM_NOT_READY`.
- **Run.** `GET …/workflow-runs/:runId` returns the run (`state`: `running`, `blocked`,
  `completed`, `failed` (reserved), `cancelled`) with its spec, `spec_sha256`, `root_ref` and one
  entry per node: `state` (`waiting`, `ready`, `running`, `done`, `failed`, `blocked`, `skipped`,
  `cancelled`), `attempt`, `task_id`, `attempts`, `result` (`{task_id, state, summary, artifacts}`
  with `ardent-artifact:<sha256>` references), `error`, `blocked_by` and `actions`. The list route
  answers the newest 50 (`state=active|finished|all`).
- **Actions.** `POST …/nodes/:key/actions` with `{action}`: `retry` (a `failed` node runs again as
  attempt n+1 in a new task with `source.workflow.retry_of`), `skip` (a node that is not required,
  before or while it runs, or after it failed; its task is cancelled) and `cancel_run` (any node
  key; the run and its active node tasks are cancelled). An action the node does not offer answers
  `409 ACTION_UNAVAILABLE` with `details.actions`.
- **Events.** `workflow.run.created` and `workflow.run.updated` (`{run}`, on state changes) and
  `workflow.node.updated` (`{run_id, run_state, node}`); node tasks emit the usual `task.*` events.
- **Templates.** Team template bodies may carry `workflows: [{key, name, purpose, spec}]` (at most
  8); their roles must be the template's (`422 WORKFLOW_INVALID`). Template versions stay
  immutable, so a run names the version it came from (`source_template`). Saving a project team as
  a new version keeps the base version's workflows whose roles still exist.

## Deliverable review

- **Receiving files.** When an agent's task journals `artifact_registered`, ArdentStudio streams the
  bytes from Magnus into its blob store and checks them against the registered SHA-256. Only a
  verified file becomes a **deliverable revision**; a mismatch, an oversized file or a refused
  transfer is retried, then recorded as a failed import (`imports` in `GET
  /projects/:id/deliverables`) with a room note. The task's state, the file's receipt and the
  review status are separate records. From agents with artifact transfer v2 the transfer resumes
  after a restart with `Range`, and the revision's `renditions` (the original first, then previews
  and model inputs: `{role, sha256, mime, size, purpose, width, height, has_alpha}`) are imported
  with it; older agents keep the whole download up to `ARDENT_STUDIO_MAX_BLOB_BYTES`
  ([CONDUCTOR.md](CONDUCTOR.md#artifact-imports)). An import
  reports `received_bytes`, `transfer` (`range` or `whole`), `resumes` and `error_code`; progress
  arrives as `artifact.import.progress`, state changes as `artifact.import.updated`.
- **Deliverables.** A registration that revises an earlier file (`supersedes_sha256`), comes from a
  revision task, has the same name, or matches the role's single requested deliverable joins that
  deliverable as revision n+1, which `supersedes` revision n (an unreviewed n becomes `superseded`).
  Otherwise it starts a new deliverable. Bytes download through `GET /blobs/:sha256`, which takes
  one `Range: bytes=` range (206 with `Content-Range`, 416 past the end, `If-Range` with another
  ETag answers the whole blob), sends `X-Content-SHA256` and `ETag: "<sha256>"`, and with
  `?disposition=inline` answers `Content-Disposition: inline` and, for PNG, JPEG, WebP and GIF, their
  real `Content-Type` for previews (everything else stays `application/octet-stream`).
- **Comments.** Anchors: `text` (`start`, `end` as UTF-16 offsets into the file decoded as UTF-8,
  `quote`, `source_sha256`; for Markdown, text, CSV, JSON and SVG source), `docx` (`paragraph_id`,
  `start`, `end`, `quote`, from the stored conversion), `pdf` (`page`, optional `rect` and
  `quote`), `image` (normalized `x`, `y`, `w`, `h`, optional SVG `viewbox`) and `file`. A text
  quote must match the revision (`422 ANCHOR_MISMATCH`) and its digest (`409 ANCHOR_STALE`); an
  anchor that does not fit the file type is `422 ANCHOR_KIND`. Resolving is always a person's act.
- **Decisions.** `accepted`, `changes_requested` (needs a note or an open comment) or `rejected` on a
  revision. `POST /deliverables/:id/final` picks one final revision per deliverable.
- **Revision requests.** `POST /projects/:id/revision-requests` takes `comment_ids` (one
  deliverable), an optional `role_key` (default: the producer role) and `instructions_md`. It posts
  a `revision_request` message, starts a `revision` task whose context items quote each anchored
  comment (and, for small text files, the current revision), and links the comments
  (`revision_task_id`). The revised file arrives as the next revision; its comments get
  `addressed_in_revision_id`.
- **Exports.** `POST /projects/:id/exports` zips each deliverable's final revision with
  `manifest.json`: per file the path, SHA-256, size, revision, producer, the Ardent manifest,
  `acceptance_status` (`approved`, `partial`, `rejected`, `unreviewed`) and the review record, plus
  the excluded deliverables and the project's current decisions. The zip is stored and listed, and
  downloads through `GET /blobs/:sha256`.
- **DOCX.** `GET /files/:id/docx` and `GET /revisions/:id/docx` return the neutral Word exchange
  document and paragraph index from the canvas Word codec. The codec assigns new paragraph ids on
  every conversion, so each file or revision is converted once and stored; anchors use those ids.
  Until the codec package is published these routes answer `501 DOCX_CONVERTER_UNAVAILABLE`, and
  DOCX revisions take whole-file comments.

## Stream

`GET /projects/:id/stream?after=<seq>` is server-sent events. Read it with `fetch` (EventSource
cannot send the bearer token).

- Persisted events (`project.*`, `file.*`, `link.*`, `team.*`, `conversation.*`, `message.*`, `task.*`, `decision.*`, `workflow.*` …)
  carry their per-project `seq` as the SSE `id` and replay after `?after=`. Without `after` the
  stream starts at the current end.
- `reset` (`{seq, reason}`) means the cursor is older than the retained events
  (`ARDENT_STUDIO_EVENT_RETENTION_DAYS`) or ahead of them: refetch the snapshot and continue from
  `seq`.
- `heartbeat` (`{seq, at}`) every 15 seconds.
- `presence.updated` carries an agent's activity: `offline` and `available` from the 30-second
  status probe, and `queued`, `working`, `reviewing`, `asking`, `waiting`, `paused`, `blocked` and
  `delivering` from tasks, Ardent journal events and verified deliverable revisions, with one
  state per agent chosen by precedence ([CONDUCTOR.md](CONDUCTOR.md#activity)). Nothing is
  inferred from timers.
- `message.delta` (`{message_id, text, mode, step}`) is live reply text: `append` adds to the
  current step, `replace` sets it. It has no `id` and is never replayed; when a stream connects,
  each message still streaming gets one `replace` with its current text. The stored message
  (`message.updated`) replaces the live text when the turn ends.
- `project.members.updated` (`{mode, revision}`) follows a membership change; refetch
  `GET /projects/:id/members` for the list.
- `project.purged` (`{project_id, at}`) has no `id` and is never replayed: the project was purged and
  the stream closes.
- The stream closes when the token expires or its session ends (reconnect with a fresh token), and
  when the caller loses access to the project (it is re-checked every 5 seconds and on every
  membership change).

## Audit export

`GET /audit/export?after=<cursor>&limit=<n>` returns `{"data": [HiveAuditRecord...], "nextCursor": string|null}`:
every audit row Studio stores, oldest first, keyset-paged on the row's monotonic id. `after` is the
opaque `nextCursor` of the previous page (omit it for the start); `limit` is 1 to 200 (default
100, larger values are clamped). A page holds records strictly after the cursor. Whenever a page
has records, `nextCursor` is the last record's cursor, even on the last page, so a collector can
store it and poll again later; it is `null` only when `data` is empty, meaning caught up. A malformed cursor or limit answers `400 VALIDATION_ERROR`.

Each record (`hiveAuditRecordSchema` in `src/shared/browser.ts`, the suite-wide v1 shape):

| Field | Value |
|---|---|
| `id` | `ardentstudio:audit:<row id>`, stable |
| `product` | `ardentstudio` |
| `occurredAt` | RFC 3339 UTC |
| `action` | The recorded action, for example `project.create`, `team.publish`, `agent.apply`, `review.export` |
| `outcome` | `success` (Studio audits completed mutations only) |
| `actor` | `user` (Oathweave subject and issuer, `displayName` the Studio user), `system`, or `service` |
| `target` | The audited object's type and id (`project`, `task`, `agent`, `link`, `file`, …); omitted when empty |
| `subject` | Omitted unless the record is about an agent: `agentRef` and `nodeId` when the record is about an agent: an `agent` target, a `task` that ran on an agent, or an `agent_ref` in the details |
| `details` | Flat scalars, redacted with the suite log redaction, at most 4 KB. Lists of values are joined with commas, other lists become `<key>_count`, nested objects are dropped |

Permissions: see [Oathweave](OATHWEAVE.md#audit-export).
