# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

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
