# ArdentStudio API

Base path: `/api/ardentstudio/v1`. The authoritative contract is
[`openapi-browser.json`](openapi-browser.json), generated from
[`src/shared/browser.ts`](../src/shared/browser.ts). This page explains the conventions.

## Conventions

- **Authentication.** `Authorization: Bearer <Oathweave token>` with the audience
  `ardentstudio`. The person must have an explicit identity link (see [OATHWEAVE.md](OATHWEAVE.md)).
  Missing or invalid token: `401 UNAUTHENTICATED`. Valid token without a link:
  `403 NO_ACCOUNT_LINK`. Missing permission: `403 FORBIDDEN` with `details.missing`.
- **Idempotency.** Every mutation requires `x-idempotency-key` (8-128 characters of
  `A-Z a-z 0-9 . _ : -`). Repeating a key with the same request replays the first answer and sets
  `idempotent-replayed: true`; reusing it for a different request answers
  `409 IDEMPOTENCY_KEY_REUSED`; a request still running answers `409 IDEMPOTENCY_IN_PROGRESS`.
  A failed request releases its key. Keys are scoped to the person and kept for a day.
- **Audit.** Every mutation writes an append-only audit row (who, what, which record, the key).
- **Errors.** `{ "error": { "code": "…", "message": "…", "details": … } }`. Bodies are JSON, at most
  1 MiB, except file uploads.
- **Identifiers.** Prefixed ULIDs: `prj_`, `fil_`, `tpl_`, `trv_`, `bnd_`, `req_`, `cnv_`, `msg_`,
  `dec_`, `tsk_`, `dlv_`, `drv_`, `cmt_`, `rvd_`, `exp_`. Agents are `<nodeId>~<profile>`, the Magnus
  reference.
- **Additive responses.** Later releases may add fields; clients ignore what they do not know.

## Permissions

| Permission | Grants |
|---|---|
| `ardentstudio:projects:read` | Read projects, files, blobs, teams, agents and the stream; validate a team |
| `ardentstudio:projects:write` | Create and change projects, upload and reindex files, edit and publish teams |
| `ardentstudio:templates:read` | Read templates and versions |
| `ardentstudio:templates:write` | Create templates, add versions, archive; save a project team as a template |
| `ardentstudio:review:write` | Review decisions and comments (with Deliverable Review) |
| `ardentstudio:agents:admin` | New Agent through Magnus (with Agent Studio; Magnus also requires an ADMIN person) |

## Routes

| Area | Route | Permission |
|---|---|---|
| Health | `GET /health/live`, `GET /health/ready` | none |
| Projects | `GET /projects?status=&q=` | projects:read |
| | `POST /projects` | projects:write |
| | `GET /projects/:id`, `GET /projects/:id/snapshot` | projects:read |
| | `PATCH /projects/:id`, `POST /projects/:id/archive`, `POST /projects/:id/reopen` | projects:write |
| Files | `POST /projects/:id/files?name=&purpose=` (raw body) | projects:write |
| | `GET /projects/:id/files`, `GET /blobs/:sha256` | projects:read |
| | `POST /files/:id/reindex` | projects:write |
| Templates | `GET /templates?kind=&source=&archived=&q=`, `GET /templates/:id`, `GET /templates/:id/versions/:v` | templates:read |
| | `POST /templates`, `POST /templates/:id/versions`, `POST /templates/:id/archive` | templates:write |
| Team | `GET /projects/:id/team`, `POST /projects/:id/team/validate` | projects:read |
| | `PUT /projects/:id/team/draft`, `POST …/team/publish`, `POST …/team/apply-template` | projects:write |
| | `POST …/team/save-as-template` | projects:read + templates:write |
| Agents | `GET /agents` | projects:read |
| Stream | `GET /projects/:id/stream?after=<seq>` | projects:read |

Conversations, messages, tasks, decisions, review and exports arrive in later releases; their
records already exist in the schema.

## Projects

`POST /projects` takes `name`, `brief_md`, `audience`, `constraints[]`, `tags[]` and
`deliverables[]` (`name`, `kind`, `formats` from md, txt, docx, pdf, svg, png, jpeg, webp, csv,
json, optional `stage` and `producer_role_key`). It creates the project's HiveMem workspace in the
background: `hivemem.state` is `pending`, then `ready`, or `failed` with an error and retried.

An archived project is read-only (`409 PROJECT_ARCHIVED`) except `last_area`. Archive answers
`409 TASKS_ACTIVE` with the tasks while any Studio task is still active.

`GET /projects/:id/snapshot` returns the project, its files and its team, with the `seq` they are
consistent with. Open the stream with `?after=<seq>` to continue from it.

## Files and knowledge

Upload the raw bytes with their `Content-Type` (`text/markdown`, `text/plain`, `text/csv`,
`application/json`, `application/pdf`, DOCX, PNG, JPEG, WebP, GIF, SVG), up to
`ARDENT_STUDIO_MAX_BLOB_BYTES`. Bytes are stored by SHA-256 and served only through a file that
references them, always as `application/octet-stream` attachments (the recorded type is in
`X-Blob-Mime`).

`purpose=reference` files are synced into the project's HiveMem workspace as one knowledge source
per file (`source_id` `ardentstudio:file:<file id>`, revision = the file's SHA-256), preview first,
then apply. `knowledge.state` is `pending`, `indexing`, `indexed`, `failed` (retried with backoff,
or `POST /files/:id/reindex`) or `unsupported` (images; DOCX until the canvas codec package).
Attachments and avatars are `not_indexed`.

## Templates

Agent and team templates have immutable versions. `POST /templates/:id/versions` needs the
`base_version` it edits; a newer version answers `409 VERSION_CONFLICT`. Seed templates (Research
Team, Development Team, Adventure Studio, Deliberation Panel and their agent templates) are loaded on start
when absent and are never overwritten. Bodies that look like they contain credentials answer
`422 CREDENTIAL_LIKE_VALUE`; team templates with structural errors answer `422 TEAM_INVALID`.

## Team assignment

A project has at most one draft and one current (published) revision. `PUT …/team/draft` takes the
`base_revision` it builds on; a newer published revision answers `409 TEAM_REVISION_CONFLICT`.
Roles bind agents by `agent_ref`; the server assigns a stable `binding_id`.

Validation (`POST …/team/validate`, and in every team response):

| Severity | Code |
|---|---|
| error | `coordinator_count`, `reporting_cycle`, `workflow_cycle` (hand-offs other than a `revise` loop), `deliverable_without_producer`, `duplicate_role_key`, `unknown_role`, `self_relationship`, `multiple_managers`, `coordinator_reports` |
| warning | `unbound_role`, `reviewer_is_only_producer`, `skill_not_enabled`, `agent_unavailable`, `agent_without_hivemem`, `outside_reporting_tree`, `agent_facts_unavailable` |

`can_publish` means no errors; publishing with errors answers `409 TEAM_INVALID`.
`can_start_room` also needs the coordinator bound to an available agent. Agent facts come from
Magnus; when Magnus cannot answer, `agent_facts` says `partial` or `unavailable`.

## Agents

`GET /agents` lists the Magnus-managed Ardent profiles with Studio presentation and the project
roles they hold. When Magnus is unavailable the list is empty and `magnus.state` is `unavailable`.

## Stream

`GET /projects/:id/stream?after=<seq>` is server-sent events. Read it with `fetch` (EventSource
cannot send the bearer token).

- Persisted events (`project.*`, `file.*`, `team.*`, later `message.*`, `task.*`, `review.*` …)
  carry their per-project `seq` as the SSE `id` and replay after `?after=`. Without `after` the
  stream starts at the current end.
- `reset` (`{seq, reason}`) means the cursor is older than the retained events
  (`ARDENT_STUDIO_EVENT_RETENTION_DAYS`) or ahead of them: refetch the snapshot and continue from
  `seq`.
- `heartbeat` (`{seq, at}`) every 15 seconds.
- Ephemeral events such as `message.delta` have no `id` and are never replayed.
- The stream closes when the token expires or its session ends; reconnect with a fresh token.
