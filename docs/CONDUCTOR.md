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
the same key, so a conversation keeps its context per role.

### Submitting and retrying

The first attempt plans the turn (session, composed request, mission) and **freezes** the exact
Magnus action body in the task (`tasks.submit_payload_json`) before sending it: the mission and its
deadline (computed once), the objective and context items, the labels and the Ardent idempotency key,
which is derived from the Studio task id. Every retry, also after a Studio restart, re-sends that
body byte for byte and never re-plans it. Ardent hashes the task content into its idempotency check,
so a submission that reached Ardent but whose answer was lost (a timeout, a restart between Ardent
accepting the task and Studio recording it) is answered with the same Ardent task instead of an
"Idempotency key reused with different task content" conflict, even when the room has moved on.

Magnus failures that may be temporary (a network error, 408, 429, 5xx, a service-token failure) are
retried with exponential backoff and full jitter (HiveCommon `backoffDelay`: 1 s base, 60 s cap),
waiting at least as long as a `Retry-After` from Magnus (up to 10 minutes; a longer one fails the
task), and never past the mission deadline. The time of the next attempt is stored
(`tasks.submit_next_at`), so a restart inside a backoff window waits for it instead of retrying at
once. After five failed attempts (`maxSubmitAttempts`), or on a permanent refusal, the task fails
with a system message in the room that quotes Magnus's reason.

### Execution references

Every task carries an execution context (HiveCommon execution context v1) that places it in the
suite-wide causal tree, stored in `tasks.execution_json` with its `root_ref` and `parent_ref`. It is
**attribution only**: Studio, Magnus and Ardent never read it to choose tools, memory, missions or
artifacts, or to grant anything, and it never enters the objective, the prompt or the mission
(`parent_task` stays `null`). It is recorded when the task is created; a task created before this
existed gets it on its first submission. `<inst>` is `ARDENT_STUDIO_INSTANCE_ID` (default `local`).

| Studio unit | Reference |
|---|---|
| Request (the trigger message) | Root `hx1:studio:<inst>:request:<message id>`; the turn's parent is the root |
| Group without a trigger message (discussion, team proposal, ordering group) | Root `hx1:studio:<inst>:request:<discussion, proposal or group id>` |
| Task | Self `hx1:studio:<inst>:task:<task id>`; a task with neither is its own root |
| Hand-off | Parent = the source task; `inputs` = the source's Ardent task `hx1:ardent:<node>.<profile>:task:<ardent task id>` when known |
| Reassign | Parent = the reassigned-from task |
| Discussion turn | Parent = the previous turn (the summary follows the last turn of the last round) |
| Assignment revision | `attempt` = the team revision the task runs under (a team proposal: its attempt) |

A caused task (hand-off, reassign, discussion turn) keeps its cause's root and request ID, but not
its deadline. A task started from a person's request records that HTTP request's `x-request-id` as
`request_id`. On submission the context gains `deadline_ms`, the mission deadline.

Every Magnus call carries `x-request-id` and `traceparent` (the current request's, or new ones for
background work) and, for a submission, the task's context in `x-hive-execution`; Magnus ignores
headers it does not know. The context also goes in the action request as a top-level `execution`
field, next to `action` and `body`, only when the node agent reports `capabilities.lineage` >= 1
(Magnus 3.3.0): older Magnus validates action requests strictly and would refuse it. Whether it is
included is decided when the submission is frozen.

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

## Workflows

A workflow (`src/conductor/workflows.ts`) is a small directed acyclic graph of sub-prompts: for
example two independent research nodes that feed one synthesis node. A person starts one with an
inline spec or a team template's workflow (`POST /projects/:id/workflow-runs`, see
[API.md](API.md#workflows)). The run and its nodes are stored in `workflow_runs` and
`workflow_nodes` (migration 8) with the validated spec, so everything below is re-derived from the
database.

- **Nodes are ordinary tasks.** A node becomes a task when every node it needs is `done` (or
  `skipped`): an `assignment` for the node's role in the current published team, posted in the team
  conversation, with the node prompt as its instructions and
  `source.workflow = {run_id, node_key, attempt}`. The role's agent, mission tools, hand-off edges
  and grants apply as for any assignment; a workflow adds no permission of its own, and starting
  one needs the same permission as creating a task. Each node attempt has at most one task
  (`tasks.workflow_run_id`, `workflow_node_key`, `workflow_attempt` are unique together), so
  re-evaluating a run never creates a second one.
- **Inputs are data.** The node task's context items are the run's `inputs` (when given) and, per
  needed node, a JSON item `Workflow result: <key> (data)` with that node's role, qualified task
  reference, state, final reply (the TeamResult summary of a mission) and the artifacts Studio
  imported from its task as `ardent-artifact:<sha256>` references. Each item says it is material,
  not instructions. A node waits (`ready`) until the artifact imports of the tasks it needs have
  settled, so it only ever names files Studio verified. A skipped need appears with `result: null`.
- **Execution references.** The run is `hx1:studio:<inst>:workflow:<run id>`, the root of its tree
  (with the starting request's `x-request-id`). A node task's parent is the run, its `inputs` are
  the tasks of the nodes it needed, and its `attempt` is the node attempt.
- **Completion.** A node is `done` when its task ends `completed` or `partial`; the result is kept
  in `workflow_nodes.result_json`. A clarification does not end a node: the answer's task
  continues it and its result completes the node. The run is `completed` when its output node is
  done.
- **Failure.** A node whose task ends `failed`, `unknown` or `cancelled` is `failed`, as is a node
  whose role has no bound agent when it should start. Every node that needs a failed, blocked or
  cancelled node is `blocked`, and the run is `blocked` with the actions a person can take:
  `retry` (attempt n+1, a new task with `retry_of`), `skip` (only nodes with `required: false`;
  dependents go on without the result) and `cancel_run` (cancels active node tasks through the
  usual cancel path). Agents cannot act on a run. A node task cannot be reassigned.
- **Restart.** On start the conductor resumes following every accepted task (node tasks included)
  and then re-evaluates every running or blocked run: `done` nodes keep their results and are never
  resubmitted, `running` nodes are followed through their Studio task, and nodes whose needs
  finished meanwhile start. An agent-level interruption inside a node is handled by the task's own
  recovery, like any task.
- **Events.** `workflow.run.created`, `workflow.run.updated` (state changes) and
  `workflow.node.updated` (`{run_id, run_state, node}`) on the project stream, next to the node
  tasks' `task.*` events.

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
