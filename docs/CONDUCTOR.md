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
seconds; the follower reconnects with `after=<last handled sequence>`. When a stream fails, the
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
| `artifact_registered` | Reserved for the artifact importer (Deliverable Review). |

## Discussions

A discussion runs round-robin rounds: each participant's turn is one task in the round's ordering
group, with the discussion so far in its context. After the last round, the coordinator writes a
summary in the desired output (`decision`, `short_doc` or `options`) and the discussion is `done`.
Without a bound coordinator it ends with a note instead. Stopping cancels unstarted turns and
cancels the running one through Magnus.

## Activity

Agent activity (`presence.updated`) comes from real records only:

| State | Source |
|---|---|
| `offline`, `available` | The status probe every 30 seconds (Magnus profile running and reachable). The probe sets nothing else. |
| `queued`, `working`, `reviewing`, `paused` | Studio task state and journal events (`model_started`, `tool_attempt` adds the tool name) |
| `asking` | `team_ask_user`, or a task waiting for an answer |
| `waiting` | A task behind another in its ordering group |
| `unknown` | Not probed yet |

"Speaking" is not stored: it is the live `message.delta` stream itself, which the browser shows.
