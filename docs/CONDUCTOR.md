# The conductor

The conductor is one worker inside ArdentStudio (`src/conductor/`). It starts agent turns through
Magnus, follows them, relays live reply text, writes the final messages and enforces team rules on
what agents ask for. It never runs model work. Everything it records comes from a person's request
or from a real Ardent record relayed by Magnus; when Magnus or an agent cannot answer, it records
that instead of filling the gap.

## Starting work

A message in the room becomes Studio tasks (`POST /conversations/:id/messages`):

| Message | Tasks |
|---|---|
| To **Team** or **Coordinator** (no mentions) | One `turn` for the coordinator |
| To roles, or with `@role_key` mentions | One `turn` per addressee, in an **ordering group** |
| In a **direct** conversation | One `turn` for that conversation's role |
| In a **discussion** | None: it is a note the next turns see |

Tasks in an ordering group start one after another: the next addressee's turn is submitted when
the previous one has finished, so it sees that reply. Waiting tasks show the activity
`Waiting for <role>`. Hand-offs, assignments (`POST /projects/:id/tasks`), follow-ups and
clarification answers create tasks the same way.

Every task is pinned to the published team revision it was created under (`assignment_revision`).
Its role's bound agent at that revision runs it.

## Reaching the agent

The conductor asks Magnus for the node agent's Studio level (`capabilities.studio` of the
installation) and the agent's Ardent version:

| Agent | How a turn is sent |
|---|---|
| studio >= 2 and Ardent >= 2.2.0 | `mission-submit`: a TeamMission in a session opened with context `mission` |
| studio 1 | `task-submit` with one composed prompt, in a `direct` session |
| older | `task-submit` with one composed prompt and no session |

The session key is `studio:<project>:<conversation>:<role>`; Ardent answers the same session for
the same key, so a conversation keeps its context per role. The Ardent idempotency key is derived
from the Studio task id, so a retried submission (a timeout, a restart between Ardent accepting
the task and Studio recording it) is the same Ardent task. Magnus failures that may be temporary
are retried up to five times with backoff; then the task fails with a system message in the room
that quotes Magnus's reason.

The mission (`src/conductor/prompting.ts`):

- `id` is the Studio task id, `revision` the team revision.
- `constraints`: project name, role, project constraints.
- `allowed_actions`: observe, analyze, create_artifact, create_draft.
- `resources`: `tool:team_ask_user`, `tool:team_propose_decision`, `tool:artifact_write`,
  `tool:document_render`, `tool:development_note`, `tool:team_handoff` when the role has a
  `delegates_to` or `hands_off_to` edge, and `project:<hivemem project id>` for project memory.
- `acceptance_criteria`: from the request; `expected_artifacts`: the role's requested
  deliverables for assignments and revisions.
- `labels`: `studio.project`, `studio.task`, `studio.conversation`, `studio.role`.

## What the agent is told

- The role's name, responsibilities and project instructions, every turn.
- The project brief, audience, constraints, requested deliverables and team roster on the
  **first turn of a session** only; later turns rely on the Ardent session.
- The room messages of that conversation the agent has not been shown yet (the session remembers
  the newest seq it was shown), without its own replies, which are already in its session.
- The request: the message, the assignment, the clarification answer or the discussion round.

Large material goes into mission `context_items` (64 KiB in all): a long brief, a long room
excerpt, the text of attached project files. A plain prompt (`task-submit`, at most 16000
characters) keeps the start of the brief and the newest messages and marks what it left out.

## Following a task

One Server-Sent Events subscription per accepted task through Magnus
(`GET …/tasks/:taskId/stream`): journal events (`task.event`, resumable by sequence), live reply
text (`task.text`, `task.delta`) and the final record (`task.done`). Ardent ends a stream after 60
seconds; the follower reads the task (a turn that ended `input_required` has no `task.done`) and,
when it has not finished, reconnects with `after=<last handled sequence>`. When a stream fails, the
follower polls `…/tasks/:id/events?after=` and the task every 1 to 5 seconds for a while, then tries
the stream again.

Each journal event is handled and the task's cursor advanced in **one transaction**, so a replay
after a reconnect or a restart never applies an event twice.

On start, the conductor resumes following every accepted, unfinished task from its stored cursor,
submits queued tasks, and moves on discussions whose round finished while it was down.

## Live text and final messages

- The first visible reply text creates the reply message (`state: streaming`) and a
  `message.created` event.
- Live text is relayed on the project stream as `message.delta` (`append` or `replace` per step),
  without an id. It is never stored. A project stream that connects mid-reply gets one `replace`
  delta with the current text.
- When the task finishes, the conductor reads any journal events the stream did not deliver, then
  writes the final text (a mission's TeamResult `summary`, or the task result) into the message and
  emits `message.updated`. The stored message is authoritative. Completion is idempotent on the
  Ardent task id: the message table holds at most one message per Ardent task.
- A failed or cancelled task without text gets a failed message that says so.

## Agent requests

Agents request; Studio rules and people decide.

| Journal event | What the conductor does |
|---|---|
| `team_handoff` | Starts an `assignment` task for the named role only if the task's team revision has a `delegates_to` or `hands_off_to` edge from the requesting role to it, and that role is bound. Otherwise posts a `system` message that explains why nothing was started. |
| `team_ask_user` | Posts a `clarification` message. The turn ends as `input_required`; `POST /messages/:id/answer` continues the same session. |
| `team_propose_decision` | Posts a `decision_proposal` card. Only a person pins it (`POST /projects/:id/decisions`). |
| `pause_requested`, `paused`, `resumed` | Task state `pausing`, `paused`, `running`. |
| `artifact_registered` | Queues the file for the artifact importer in the same transaction; the importer streams and verifies it and records a deliverable revision (see [API.md](API.md#deliverable-review)). Activity: `Delivered <name> r<n>`. |

## Team proposals

A `team_proposal` task is handled by the team proposer instead of the room. It goes to the agent
the proposal names, with no team revision, role or Ardent session: a mission (`allowed_actions`
`observe` and `analyze`, the project's HiveMem `project:<id>` resource, a one-hour deadline, no
mission tools) where the node is at studio level 2 with Ardent 2.2.0, else a task-submit prompt.
The brief, the available agents and the template catalog travel as context items for a mission
and are shortened into the prompt otherwise. Live text is not relayed and no room message is
written; when the task ends, the proposer validates the reply, asks once more with the validation
error when it is invalid, and records the outcome (see [API.md](API.md#team-proposals)). Journal
events move the proposal to `running`; the agent's activity shows the task like any other.

## Revision tasks

A revision request creates a `revision` task. Its turn carries the review comments as context
items, each with where it points (quote and offsets, paragraph, page or image region), the current
file for small text formats, and the digest to pass as `revises_sha256`. The mission expects the
deliverable as its artifact.

## Discussions

A discussion runs round-robin rounds: each participant's turn is one task in the round's ordering
group, with the discussion so far in its context. After the last round, the coordinator writes a
summary in the desired output (`decision`, `short_doc` or `options`) and the discussion is `done`.
Without a bound coordinator it ends with a note instead. Stopping cancels unstarted turns and
cancels the running one through Magnus.

## Activity

Agent activity (`presence.updated`, and `activity` in the snapshot) is the ArdentStudio service's
single source of truth for what an agent in a project is doing. It is derived
(`src/conductor/activity.ts`) from real records only, every time one of them changes: the status
probe, the agent's Studio tasks, what the Ardent journal showed of them (stored as task progress,
so a restart derives the same state), clarifications, hand-offs and verified deliverable
revisions. Nothing is inferred from timers; the one timer re-derives the activity when a
Delivering window ends.

| State | Derived from | Label |
|---|---|---|
| `offline` | The status probe every 30 seconds: the Magnus profile is not running or not reachable, or Magnus did not answer | `Offline`, `Offline: Magnus is unreachable` |
| `available` | The probe found the profile running and reachable, and nothing below applies | `Available` |
| `queued` | A task waiting to start, or accepted by Ardent before the journal shows the model starting | `Queued: <task>`, `Starting: <task>` |
| `working` | A task whose journal showed `model_started` or a `tool_attempt` (which adds the tool name) | `Working: <task>`, `Working: <task> · <tool>` |
| `asking` | A task that asked a question (`team_ask_user`) nobody has answered yet, or that ended `input_required` | `Asking: <question>` |
| `waiting` | A task behind an unfinished turn in its ordering group, or a role the agent handed work to (`team_handoff`) that has not finished | `Waiting for <role>` |
| `reviewing` | A running `review` task | `Reviewing: <task>` |
| `delivering` | A verified deliverable revision from the agent's task (`artifact_registered`), for 20 seconds | `Delivered <name> r<n>` |
| `paused` | A task paused or with a pause requested | `Paused: <task>`, `Pause requested: <task>` |
| `blocked` | The agent's newest task in the project failed, ended in an Ardent `unknown` state, or its TeamResult outcome was `blocked`; new work for the agent clears it | `Blocked: <reason>` |
| `unknown` | Not probed yet, and nothing above applies | `Status not checked yet` |

When several apply (an agent with several active tasks), the first in this order wins:

**offline > paused > blocked > asking > reviewing > working > queued > waiting > delivering > available > unknown**

Among tasks in the same state, the oldest task's label is shown.

"Speaking" is not stored: it is the live `message.delta` stream itself, which the browser shows on
top of the stored activity.
