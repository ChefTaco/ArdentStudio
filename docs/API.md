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
| `ardentstudio:projects:read` | Read projects, files, blobs, teams, agents, conversations, tasks, decisions and the stream; validate a team |
| `ardentstudio:projects:write` | Create and change projects, upload and reindex files, edit and publish teams, post messages, pin decisions, create and control tasks |
| `ardentstudio:templates:read` | Read templates and versions |
| `ardentstudio:templates:write` | Create templates, add versions, archive; save a project team as a template |
| `ardentstudio:review:write` | Comment on, accept, reject and finalize deliverables; request revisions (with projects:write); export |
| `ardentstudio:agents:admin` | New Agent and applying drafts through Magnus (Magnus also checks the acting person) |

## Routes

| Area | Route | Permission |
|---|---|---|
| Health | `GET /health/live`, `GET /health/ready` | none |
| Projects | `GET /projects?status=&q=&needs_review=` | projects:read |
| | `POST /projects` | projects:write |
| | `GET /projects/:id`, `GET /projects/:id/snapshot` | projects:read |
| | `PATCH /projects/:id`, `POST /projects/:id/archive`, `POST /projects/:id/reopen` | projects:write |
| Files | `POST /projects/:id/files?name=&purpose=` (raw body) | projects:write |
| | `GET /projects/:id/files`, `GET /blobs/:sha256` | projects:read |
| | `POST /files/:id/reindex` | projects:write |
| Links | `GET /projects/:id/links` | projects:read |
| | `POST /projects/:id/links`, `PATCH /links/:id`, `DELETE /links/:id`, `POST /links/:id/reindex` | projects:write |
| Templates | `GET /templates?kind=&source=&archived=&q=`, `GET /templates/:id`, `GET /templates/:id/versions/:v` | templates:read |
| | `POST /templates`, `POST /templates/:id/versions`, `POST /templates/:id/archive` | templates:write |
| Team | `GET /projects/:id/team`, `POST /projects/:id/team/validate`, `GET …/team/proposals`, `GET …/team/proposals/:proposalId` | projects:read |
| | `PUT /projects/:id/team/draft`, `POST …/team/publish`, `POST …/team/apply-template`, `POST …/team/propose` | projects:write |
| | `POST …/team/save-as-template` | projects:read + templates:write |
| Agents | `GET /agents`, `GET /agents/:ref/presentation`, `GET /agents/:ref/draft`, `GET /agents/:ref/development`, `GET /agents/operations/:id` | projects:read |
| | `PUT /agents/:ref/presentation`, `PUT`/`DELETE /agents/:ref/draft`, `POST /agents/:ref/preview`, `POST /agents/:ref/development/:recordId/comments` | projects:write |
| | `POST /agents` (New Agent), `POST /agents/:ref/apply` | agents:admin |
| Room | `GET /projects/:id/layout`, `GET /projects/:id/conversations`, `GET /conversations/:id/messages?after=&limit=` | projects:read |
| | `PUT /projects/:id/layout`, `POST /projects/:id/conversations`, `POST /conversations/:id/stop`, `POST /conversations/:id/messages`, `POST /messages/:id/answer`, `POST /messages/:id/follow-up` | projects:write |
| Decisions | `GET /projects/:id/decisions` | projects:read |
| | `POST /projects/:id/decisions`, `POST /decisions/:id/supersede` | projects:write |
| Tasks | `GET /projects/:id/tasks?state=&conversation_id=` | projects:read |
| | `POST /projects/:id/tasks`, `POST /tasks/:id/pause`, `…/resume`, `…/cancel`, `…/reassign` | projects:write |
| Review | `GET /projects/:id/deliverables`, `GET /deliverables/:id`, `GET /revisions/:id`, `GET /revisions/:id/comments`, `GET /projects/:id/exports`, `GET /files/:id/docx`, `GET /revisions/:id/docx` | projects:read |
| | `POST /revisions/:id/comments`, `POST /comments/:id/resolve`, `POST /revisions/:id/decisions`, `POST /deliverables/:id/final`, `POST /projects/:id/exports` | review:write |
| | `POST /projects/:id/revision-requests` | review:write + projects:write |
| Stream | `GET /projects/:id/stream?after=<seq>` | projects:read |

## Projects

`POST /projects` takes `name`, `brief_md`, `audience`, `constraints[]`, `tags[]` and
`deliverables[]` (`name`, `kind`, `formats` from md, txt, docx, pdf, svg, png, jpeg, webp, csv,
json, optional `stage` and `producer_role_key`). It creates the project's HiveMem workspace in the
background: `hivemem.state` is `pending`, then `ready`, or `failed` with an error and retried.

An archived project is read-only (`409 PROJECT_ARCHIVED`) except `last_area`. Archive answers
`409 TASKS_ACTIVE` with the tasks while any Studio task is still active.

`GET /projects/:id/snapshot` returns the project and its list summary, its files and links, its
team, conversations, active tasks, decisions, agent activity, room layout and open team proposals,
with the `seq` they are consistent with. Open the stream with `?after=<seq>` to continue from it.

### Summaries

`GET /projects` and the snapshot's `summary` carry counts derived from stored records only:

| Field | Meaning |
|---|---|
| `open_questions` | Agent clarifications nobody has answered |
| `review_pending` | Deliverable revisions that are `unreviewed`, or `changes_requested` with no newer revision yet |
| `active_tasks` | Studio tasks that are `queued`, `running`, `input_required`, `pausing` or `paused` |
| `last_activity` | `{type, at, text}` for the newest room message, pinned decision, received or reviewed revision, added reference or link, published team, export, or the project's creation or archiving. `text` is built from that record alone, for example `Story Lead asked: Which tone?`. Presence, sync progress and other bookkeeping never count. |

`?needs_review=true` keeps projects with `review_pending > 0` (`false` the others). When a change
alters a project's counts, the same transaction emits `project.updated` with
`{fields: ["counts"], counts}`, once per change. `last_activity` is not announced on its own: it
moves with the events that create its records (`message.created`, `decision.created`,
`deliverable.revision.created`, `review.decision.created`, `file.created`, `link.created`,
`team.revision.published`, `export.created`), so a client refetches the list or snapshot on those.

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
  so `restart.available` is `false` and the restart is done from the Magnus console. `active_tasks`
  counts Studio tasks still running on the agent; they keep the instructions they started with.
- **Development** (`GET /agents/:ref/development?after=&limit=&kind=`) lists the agent's Ardent
  development records (`author`, `epistemic` such as `agent_reported`, sources) with Studio comments.
  A runtime that does not publish them answers `supported: false` with the reason. A comment with
  `relay_to_agent` is also recorded in the agent's history as an operator note.
- **New Agent** (`POST /agents`) asks Magnus to deploy a new Ardent profile as the acting person
  (Magnus requires a Magnus ADMIN: `403 ACTING_ADMIN_REQUIRED`), always with HiveMem. An agent
  template version fills the soul, identity, local skills and Studio portrait. Progress is relayed
  as `agent.operation.updated` on the `project_id` stream; `GET /agents/operations/:id` reads it.

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
`reassigned_from`.

## Deliverable review

- **Receiving files.** When an agent's task journals `artifact_registered`, ArdentStudio streams the
  bytes from Magnus into its blob store and checks them against the registered SHA-256. Only a
  verified file becomes a **deliverable revision**; a mismatch, an oversized file or a refused
  transfer is retried, then recorded as a failed import (`imports` in `GET
  /projects/:id/deliverables`) with a room note. The task's state, the file's receipt and the
  review status are separate records.
- **Deliverables.** A registration that revises an earlier file (`supersedes_sha256`), comes from a
  revision task, has the same name, or matches the role's single requested deliverable joins that
  deliverable as revision n+1, which `supersedes` revision n (an unreviewed n becomes `superseded`).
  Otherwise it starts a new deliverable. Bytes download through `GET /blobs/:sha256`.
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

- Persisted events (`project.*`, `file.*`, `link.*`, `team.*`, `conversation.*`, `message.*`, `task.*`, `decision.*` …)
  carry their per-project `seq` as the SSE `id` and replay after `?after=`. Without `after` the
  stream starts at the current end.
- `reset` (`{seq, reason}`) means the cursor is older than the retained events
  (`ARDENT_STUDIO_EVENT_RETENTION_DAYS`) or ahead of them: refetch the snapshot and continue from
  `seq`.
- `heartbeat` (`{seq, at}`) every 15 seconds.
- `presence.updated` carries an agent's activity: `offline` and `available` from the 30-second
  status probe, and `queued`, `working`, `reviewing`, `asking`, `waiting`, `paused` from tasks and
  Ardent journal events. Nothing is inferred from timers.
- `message.delta` (`{message_id, text, mode, step}`) is live reply text: `append` adds to the
  current step, `replace` sets it. It has no `id` and is never replayed; when a stream connects,
  each message still streaming gets one `replace` with its current text. The stored message
  (`message.updated`) replaces the live text when the turn ends.
- The stream closes when the token expires or its session ends; reconnect with a fresh token.
