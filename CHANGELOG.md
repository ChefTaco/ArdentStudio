# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

Upgrading: back up the data volume first. Migration 11 runs on the first start and is additive (it adds
`files.deleted_at`, `files.deleted_by` and `blobs.used_at`); a database it has run on no longer starts under
0.5.x. No settings change. Anything that read the error text of `/health/ready` now gets a code (see below);
the detail is in the service log. Uploads whose bytes do not match their `Content-Type` are now refused.

### Added

- `DELETE /files/{fileId}` deletes a project file, audited as `file.delete` and announced as `file.deleted`. The
  file leaves the project and `/blobs` at once. An indexed reference file's HiveMem source is retired first
  (retried until HiveMem takes it), then the file is removed. It answers `409 FILE_IN_USE` while an agent
  portrait or a current or draft team role names the file.
- `POST /projects/{projectId}/reindex` queues every reference file and link of a project for HiveMem sync, for
  example after restoring a backup.
- The hourly maintenance removes stored bytes that nothing references any more (deleted files, refused or
  abandoned uploads, superseded conversions) once they are ten minutes old.
- `ardent-studio backup <dir>` makes a consistent backup of a running data directory without the `sqlite3`
  CLI: the database in one read transaction, then every blob it records, each checked against its digest.
- `npm run verify` starts with `check:installed`, which fails at once with "run `npm ci`" when `node_modules`
  does not match `package-lock.json`, instead of failing later with errors such as `"./execution" is not exported`.
- CI scans the container image for HIGH and CRITICAL vulnerabilities with a fresh Trivy database, and the
  publish workflow scans both architectures before it pushes anything.

### Changed

- Dependencies: `@hivemagnus/hivemem-sdk` 1.1.0 to 1.3.0 (Studio keeps its own retry schedule, so the SDK's new
  POST retries stay off), `@hono/node-server` 2.1.11, `hono` 4.13.22, `jose` 6.2.18.
- `@hivemagnus/magnus-contracts` moves from an exact 3.1.2 pin to `^3.3.6`. Agent definitions are now digested,
  sealed, verified and checked for credentials with that package's `agent-definition` module, and the Magnus
  3.3.0 answers (task recovery and its decision, artifact renditions, `unsupported_capability` details, definition
  operations and the definition preflight) are validated with its `ardent-service` schemas. Studio's own copies
  are gone. Studio still bounds recoveries and renditions to the sizes it stores, keeps preflight problem codes a
  later Magnus may add, and checks only the frame of the task lineage, which the contract relays unchanged. The
  browser contract keeps its zod-only copy of the definition shape for HiveXUI; a test fails when it differs
  from magnus-contracts.
- The fake Magnus in the tests checks every request Studio sends and every answer and stream event it serves
  against the published magnus-contracts routes and schemas, so a Magnus shape change now fails Studio's tests.

### Fixed

- Uploads are checked against their declared type as they stream in, before anything is stored: images, PDF and
  DOCX by their leading bytes, JSON must parse, SVG must contain an `<svg>` element, and text must not contain NUL
  bytes. A mismatch answers `422 CONTENT_MISMATCH` and leaves no stored bytes behind.
- `/health/ready` needs no token, so it no longer returns what Magnus or HiveMem said when a check fails. A
  failing check now answers `error` as a code (`<CHECK>_UNAVAILABLE` or `<CHECK>_TIMEOUT`), and the detail is
  logged as `Readiness check failed`, once per change.
- Shutdown is ordered: Studio stops accepting connections, ends open project and preview streams, waits up to
  8 seconds for requests in flight, closes what is still open, and only then stops background work and closes
  the database. Before, it closed the database while requests and streams could still be using it.
- A slow project stream subscriber no longer queues without limit. Past 1000 waiting messages Studio drops
  the waiting events and reads them from the event log instead, and replaces the waiting live deltas with one
  `replace` delta per streaming message, so the subscriber still receives every event in order.
- The project stream honours `Last-Event-ID` when `?after=` is absent, so a browser `EventSource` that
  reconnects on its own replays what it missed instead of silently skipping it.

### Documentation

- docs/OPERATIONS.md says to use `/health/live` for container health and restarts: `/health/ready` answers
  503 on a fresh suite until the first Ardent agent exists.

## [0.5.1] - 2026-11-24

Upgrading: replace the image; no migration and no settings change.

### Fixed

- A submission that Magnus refuses because another managed command is running on the same node
  (`409 RESOURCE_LEASE_CONFLICT`, "still running on this node; try again when it finishes") is now retried
  with backoff and the same frozen body, instead of failing the task. Parallel workflow branches whose agents
  share a node, and any two turns that start at once on one node, no longer fail or block a workflow on it.
  Every other conflict still fails the task at once.

## [0.5.0] - 2026-11-24

Upgrading: back up the data volume first. Migrations 7 to 10 run on the first start and are additive; a database
they have run on no longer starts under 0.4.x. `ARDENT_STUDIO_INSTANCE_ID` is optional (default `local`).
Workflows and execution references work with the Magnus the suite runs today; task recovery, Ardent lineage,
artifact transfer v2 and definition deploy need Magnus 3.3.0 and agents that report those capabilities, and fall
back as described below otherwise. `@hivemagnus/magnus-contracts` stays at 3.1.2: the Magnus 3.3.0 additions are
validated with local schemas until that release is on npm.

### Fixed

- A submission whose answer was lost no longer fails with an Ardent idempotency conflict when it is retried, also
  after a restart. The first attempt freezes the exact Magnus action body, including the mission deadline, in the
  task, and every retry re-sends it byte for byte instead of re-planning the turn with a fresh deadline and the
  room's newer messages.
- The submission backoff survives a restart: the time of the next attempt is stored, so a restart inside a backoff
  window waits for it instead of retrying at once.

### Changed

- The definition schema, canonical JSON, digests and credential guard are ported from
  `@hivemagnus/magnus-contracts` `agent-definition` (Magnus 3.3.0, unpublished) into `src/shared/browser.ts`
  and `src/templates/definition.ts`, with a parity test against fixtures from that implementation; they can
  switch to magnus-contracts once Studio depends on that release. The template credential guard now also
  checks object keys, as Magnus's does.
- The Magnus recovery, lineage, rendition and content answers are validated with local schemas in
  `src/clients/magnus.ts`; a later `@hivemagnus/magnus-contracts` release can replace them.
- Submission retries use HiveCommon `backoffDelay` (1 s base, 60 s cap, full jitter), wait at least as long as a
  Magnus `Retry-After` (up to 10 minutes) and stop at the mission deadline. Attempts are still capped at five, and
  a task that runs out of attempts still fails with a room message.
- `@hivemagnus/hive-common` ^0.6.0 (was ^0.5.0).

### Added

- Portable agent definitions (`hive-agent-definition/1`, Magnus 3.3.0) from agent templates, see
  [docs/API.md](docs/API.md#agent-definitions):
  - `POST /templates/:id/versions/:v/definition` builds a sealed definition from an agent template version
    (persona, pinned HiveSkills releases, Emberpath model alias, runtime `@hivemagnus/ardent` 3.0.0 or the
    template's later version, bindings) and lists what it cannot carry in `omitted`. The credential guard
    runs over the whole answer.
  - `POST /templates/import-definition` verifies a definition (schema, both digests, credential guard) and
    stores it as a new immutable agent template version, or a new template, with
    `source_definition: {name, sha256}`; the `base_version` rule applies, and what a template cannot hold
    is listed in `ignored`.
  - `POST /templates/:id/versions/:v/deploy-check` answers Magnus's preflight for a node and bindings, and
    `POST /templates/:id/versions/:v/deploy` creates the agent through Magnus's definition install, relayed
    like New Agent. A Magnus before 3.3.0 answers `409 MAGNUS_UPGRADE_REQUIRED`.
  - Agent template skills can pin a HiveSkills release (`version` and `sha256`), and agent template
    versions carry `source_definition`. Agent operations can be of kind `definition`. Migration 10 adds
    the column.
- Task recovery (Ardent 3.2.0 through Magnus 3.3.0, profiles reporting `recovery` >= 1): a task Ardent resumes under
  the same id stays `running` and shows its recovery; a task Ardent holds for a decision becomes `unknown` with the
  recovery and the actions Studio can send. `GET /tasks/:id/recovery` reads it, `POST /tasks/:id/recovery`
  (`{action, call_id?, result?, note?, deadline_seconds?}`) sends a person's decision through the Magnus
  `task-recovery` action, and a continuation (from the answer, a later read, the journal, or a decision made while
  Studio was down) is followed as the same Studio task: the old Ardent id joins `ardent.attempts`, the journal is read
  from the start, the task runs again and still ends with one completion message. Held workflow nodes run again
  after the decision. Without the capability no action is offered and the route answers `409 RECOVERY_UNSUPPORTED`.
  New event `task.recovery` (see [docs/CONDUCTOR.md](docs/CONDUCTOR.md#recovery)).
- `GET /tasks/:id/lineage`: the task's Studio relationships (root, parent, children, hand-offs, reassignments, team
  and deliverable revisions, workflow node), the Ardent lineage of each Ardent attempt (profiles with `lineage` >= 1)
  and the Emberpath filter `{executionRoot}`.
- Tasks carry `execution` (root, parent, self, attempt, inputs), `ardent.attempts` and `recovery` (additive).
- Artifact transfer v2 (profiles with `artifact_transfer` >= 2): imports pull `…/artifacts/:sha256/content` into
  `<data>/blobs/.partial/<import id>` and resume after a restart or a dropped connection with `Range` and `If-Range`,
  re-hashing the partial file as a stream; the whole-file digest is verified before the file enters the blob store.
  The artifact's renditions are imported with it and listed on the revision (`renditions`). Agents without
  transfer v2, and a profile that answers `409 unsupported_capability`, keep the whole download up to
  `ARDENT_STUDIO_MAX_BLOB_BYTES` as before. Imports report
  `received_bytes`, `transfer`, `resumes` and `error_code`; progress arrives as `artifact.import.progress`.
- `GET /blobs/:sha256` takes one `Range` (206, 416, `If-Range`), sends `X-Content-SHA256`, and with
  `?disposition=inline` serves raster images inline with their type for previews.
- Migration 9 adds `artifact_imports.received_bytes`, `transfer`, `resumes` and `error_code`, and the
  `deliverable_renditions` table; existing rows are unchanged.
- Workflows: a small DAG of sub-prompts (at most 16 nodes, acyclic, exactly one output) whose nodes run as ordinary
  tasks of team roles, branching and joining. A node starts when every node it needs is done, with their results
  and imported artifact references (`ardent-artifact:<sha256>`) as context items marked as data; a failed node
  blocks its dependents and the run, with `retry`, `skip` (optional nodes) and `cancel_run`. Completed nodes are
  never resubmitted after a restart. Routes `GET`/`POST /projects/:id/workflow-runs`,
  `GET /projects/:id/workflow-runs/:runId` and `POST …/nodes/:key/actions`; events `workflow.run.created`,
  `workflow.run.updated` and `workflow.node.updated`; optional `workflows[]` in team template bodies (see
  [docs/CONDUCTOR.md](docs/CONDUCTOR.md#workflows)). Migration 8 adds `workflow_runs`, `workflow_nodes` and the task
  columns `workflow_run_id`, `workflow_node_key` and `workflow_attempt` (unique together); existing rows are
  unchanged.
- Execution references (HiveCommon execution context v1, attribution only): every task records its root, parent
  and self references for requests, groups, hand-offs (with the source's Ardent task as an input), reassignments,
  discussion turns and assignment revisions (see [docs/CONDUCTOR.md](docs/CONDUCTOR.md#execution-references)).
  Migration 7 adds the task columns (`execution_json`, `root_ref`, `parent_ref`, `submit_payload_json`,
  `submit_next_at`, `ardent_attempts_json`, `recovery_json`) and an index on `root_ref`; existing rows are
  unchanged. `ardent_attempts_json` and `recovery_json` hold Ardent recovery (see above).
- `ARDENT_STUDIO_INSTANCE_ID` names this Studio in those references (default `local`).
- Every Magnus call carries `x-request-id` and `traceparent`, and a submission its task's context in
  `x-hive-execution`. The context also goes in the action request's top-level `execution` field when the node agent
  reports `capabilities.lineage` >= 1 (Magnus 3.3.0); older Magnus gets no such field.

## [0.4.3] - 2026-11-17

### Changed

- `@hivemagnus/magnus-contracts` 3.1.2 (was 3.0.3), the Magnus release the suite runs. The Ardent service contract
  Studio calls (`ardentServiceRoutes`, the action bodies and answers, `ARDENT_STUDIO_CAPABILITY`) and
  `ARDENT_CONTEXT_ITEMS_MAX_BYTES` are unchanged; between the two releases the contracts only add the read-only node
  software status schema and route, which Studio does not use. No Studio behaviour changes.

## [0.4.2] - 2026-11-15

### Changed

- `@hivemagnus/magnus-contracts` 3.0.3 (was 2.2.0), the Magnus release the suite runs. The Ardent service contract
  Studio calls (`ardentServiceRoutes`, the action bodies and answers, `ARDENT_STUDIO_CAPABILITY`) is unchanged from
  2.2.0, and so are the Magnus routes, the service-identity route allowlist and the error codes Studio handles; the
  Magnus 3.0 breaking changes concern node credentials only. No Studio behaviour changes.
- `@hivemagnus/hive-common` ^0.5.0 (was ^0.4.0). The baseline response headers (`nosniff`, `no-referrer`, frame
  `DENY`) come from its `securityHeaders()` middleware instead of a local copy; responses are unchanged, including
  `no-store` unless a route sets its own cache policy. With the 0.5.0 redaction fixes, audit export details also mask
  keys containing `jwt`, `bearer` or `signature`.

## [0.4.1] - 2026-11-14

### Fixed

- An artifact import or file upload no longer crashes the server when the transfer is aborted or the upstream
  stream fails while the blob's temp file is still opening. The blob store reads web streams directly and releases
  a source it refuses before reading.
- Publishing a team publishes only the draft body it validated: a draft saved by someone else while Magnus was asked for agent facts now answers `409 TEAM_REVISION_CONFLICT` instead of being published unchecked.
- A reference link edited or deleted while its knowledge sync was calling HiveMem is synced again (or its source retired) instead of being left `indexed` with the old text.
- A turn that ended in Ardent `input_required` is finished even when the task could not be read right after its state event; the follower reads the task after each stream that ends without a final record instead of following it forever.
- A JSON body sent without a declared length is refused with `413 PAYLOAD_TOO_LARGE` once it passes 1 MiB instead of being buffered whole first.
- The Magnus event-stream parser keeps an event whole when a chunk ends between the CR and LF of a line ending.
- Shutdown ends an artifact transfer in progress instead of waiting for it; the import stays due and runs after the restart.

## [0.4.0] - 2026-11-12

### Added

- `GET /api/ardentstudio/v1/audit/export?after=&limit=`: the append-only audit log as suite `HiveAuditRecord` v1 records (`hiveAuditRecordSchema` in the browser contract), oldest first and keyset-paged on the row id with an opaque cursor (limit 1-200, default 100). `nextCursor` is the last record's cursor whenever the page has records, and `null` only for an empty page; empty `target` and `subject` are omitted. Details are flattened to scalars, redacted and capped at 4 KB; agent targets, tasks that ran on an agent and `agent_ref` details fill `subject.agentRef` and `subject.nodeId`. It accepts an Oathweave service token with the new permission `ardentstudio:audit:read` (service tokens stay refused on every other route; native-issuer service tokens are accepted there when the new optional `OATHWEAVE_NATIVE_ISSUERS` lists the issuer), or a linked person with `ardentstudio:audit:read` or `ardentstudio:agents:admin`. The browser contract and `docs/openapi-browser.json` gain the route, the permission and the route fields `accept` and `orPermission` (`x-accept`, `x-or-permission`).

### Changed

- `@hivemagnus/hive-common` 0.4.0 (was 0.1.0), for native-issuer service tokens. Without `OATHWEAVE_NATIVE_ISSUERS` token verification is unchanged.

## [0.3.0] - 2026-11-12

### Changed

- Verify Oathweave tokens with the shared suite verifier from `@hivemagnus/hive-common` instead of a local copy. Accepted principals, audience, permissions, link rules and the zero clock tolerance are unchanged; a malformed `roles` claim, a token over 16 KiB, or a user token whose client ID equals its subject is now refused. The shared Oathweave conformance vectors run in the test suite.
- `/health/ready` runs its checks through the shared readiness helper. The response body and status codes are unchanged; a failing Magnus agent listing now reports `not_ready` instead of an internal error.
- Call HiveMem through `@hivemagnus/hivemem-sdk` 1.1.0 instead of a hand-written HTTP client. The Oathweave service token is supplied through the SDK token provider and refreshed once after a 401, redirects are still refused, and errors keep their messages and status codes. Requests made while handling a call now carry its `x-request-id` and `traceparent` to HiveMem.

### Added

- `GET /projects?agentRef=<magnusNodeId>~<profile>` keeps only the projects where that agent is bound to a role in the published or the draft team. It combines with the other list filters and never widens what the caller can list; a malformed value answers `400 VALIDATION_ERROR`. Without it the response is unchanged. The browser contract and `docs/openapi-browser.json` gain the optional query parameter.
- Request context on every response: `x-request-id` (also read from `x-hive-request-id` or `x-correlation-id`, generated when absent or unsafe) is echoed, W3C `traceparent` is continued, and log lines written during a request carry `requestId`.

## [0.2.1] - 2026-11-11

### Security

- Require patched Node.js 24.22.3 or 26.13.1 for supported runtime lines and update container and CI pins.
- Upgrade Hono to 4.13.18 to include the tiny-chunk request-body memory exhaustion fix (GHSA-39q9-qp46-w8xg).

## [0.2.0] - 2026-11-10

### Security

- Run containers on a pinned, maintained Node 26 runtime with patched system libraries.
- Replace the embedded SQLite driver with `@photostructure/sqlite` 3.3.1 (SQLite 3.54.1); retain existing databases, transaction ownership and recovery checks. Supported Linux x64 and arm64 installs include Node-API binaries and require no compiler or dependency install scripts.

### Changed

- The low-level database handle uses the new SQLite boundary. Consumers of driver-specific methods must update; HTTP contracts and database migrations are unchanged.

## [0.1.1] - 2026-11-10

### Security

- Override the development lint toolchain to minimatch 11.0.5 to prevent excessive
  glob expansion on untrusted patterns (GHSA-g3hv-75wg-m249).

### Changed

- The Magnus client takes its route, action and answer schemas from the published
  `@hivemagnus/magnus-contracts` 2.2.0 (`./ardent-service`) instead of local copies, and a test
  checks that every Magnus route and action the client calls is in that service contract.
  Agent operations are now read with Magnus's full operation shape.

### Removed

- `MagnusClient.memorySearch()`. Magnus does not allow the `memory-search` action for a service
  identity, so every call answered 403; project knowledge is read from HiveMem directly.

## [0.1.0] - 2026-11-08

### Added

- Service foundation: Hono API under `/api/ardentstudio/v1`, fail-fast configuration,
  Oathweave resource-token verification (audience `ardentstudio`) with explicit identity
  links, append-only audit and `x-idempotency-key` on every mutation.
- SQLite schema (WAL, numbered additive migrations) for every Studio record, prefixed
  ULID identifiers and a per-project event feed with seq assigned in the inserting transaction.
- Content-addressed blob store with temp-file, fsync, rename and SHA-256 verification.
- Clients for Magnus (service identity, acting subject, released Ardent routes and the
  planned Studio routes), HiveMem (project workspaces and knowledge source sync) and an
  optional ChatterMost incoming webhook.
- Routes for health, projects, files with HiveMem knowledge sync, versioned templates with
  the Research Team, Development Team, Adventure Studio and Deliberation Panel seeds, team assignment
  (draft, validate, publish, apply template, save as template), agents through Magnus, and
  the project event stream (SSE with replay, heartbeat and reset).
- Zod browser contract (`src/shared/browser.ts`) and the generated
  `docs/openapi-browser.json`, with a staleness check.
- Conversation room: team, direct and discussion conversations, the canonical transcript with a
  per-project message seq, decisions, the Studio task mirror (pause, resume, cancel, reassign) and
  room layout revisions.
- The conductor: dispatch by Team, Coordinator, role or @mention with ordering groups, Ardent
  missions through Magnus (task submission with a composed prompt on older agents), one task
  stream per active task with cursor resume and polling fallback, live `message.delta` relay,
  idempotent final messages, hand-off enforcement on team edges, clarifications that continue the
  same session, decision proposals, discussion rounds with a coordinator summary, presence
  probing and activity from journal events, and restart safety.
- Deliverable Review: an artifact importer that streams registered files from Magnus into the
  blob store, verifies their SHA-256 and records superseding deliverable revisions; deliverables,
  anchored comments (text, DOCX, PDF, image, whole file), review decisions, final revisions,
  revision requests that send anchored comments to the producer role, and export packages (zip
  with `manifest.json`). DOCX conversion routes are stored per file or revision and answer 501
  until the canvas Word codec package is available.
- Agent Studio: Studio presentation, per-person agent drafts, streaming previews through Magnus
  preview tasks, applying drafts through Magnus with per-part results, development records with
  comments (optionally relayed as operator notes), and Magnus New Agent with the acting person and
  operation progress relayed to the project stream.
- Project summaries with `open_questions`, `review_pending`, `active_tasks` and a `last_activity`
  line derived from stored records, a `needs_review` list filter, the summary in the snapshot, and
  `project.updated` with the counts whenever they change.
- Link references (http and https URLs with a title and note), synced to the project HiveMem
  workspace as text knowledge sources and retired when deleted.
- Team proposals: `POST /projects/:id/team/propose` asks the coordinator or a chosen agent for a
  validated `TeamProposal` (one retry with the validation error), stores it with a draft body and
  streams `team.proposal.updated`; nothing is applied.
- Agent Studio Apply uses the Magnus service routes for an acting ADMIN: typed identity, skill and
  configuration calls, chained configuration revisions, the model applied with `config-save` through
  a comment-preserving YAML edit limited to Magnus's allowed settings, explained refusals and
  `activation_required` with the restart left to the Magnus console.
- Agent Studio installs HiveSkills catalog skills: `POST /agents/:ref/skills/install` runs Magnus's
  `skill-install` for the acting ADMIN (optionally enabling the skill with the configuration
  revision), keeps Magnus's refusal codes, answers 409 `MAGNUS_UPGRADE_REQUIRED` for a Magnus
  without the action, and records the install in the audit.
- Agent activity is derived in one place from the probe, tasks, stored journal progress,
  clarifications, hand-offs and delivered revisions, with the `blocked` state and a documented
  precedence when an agent has several tasks. Working needs `model_started` or `tool_attempt`;
  Delivering is transient.
- Container image (non-root, no package managers at runtime, `/data` volume), CI and a
  publish workflow for npm trusted publishing and GHCR.

### Fixed

- Agent Apply compares a skills draft with the saved configuration (`skills.enabled`) instead of
  the running profile's skill list, so a skill enabled since the last restart is neither switched
  off nor reported as unchanged by mistake.
