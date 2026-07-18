# Data Flow

## Daemon Communication

1. A client or integration sends a user message or normalized system event to
   `ayati-main`.
2. The CLI sends `{ type: "chat", content, attachments? }` over WebSocket.
   HTTP handles uploads, artifact access, and Pulse endpoints.
3. The chat runtime serializes turns for the same client/session.
4. The daemon records the message through the typed Git Context client. The
   independent local server owns context SQLite and all Git writes.
5. The daemon starts a session run and requests a bounded context projection.
   Read-only reasoning does not require selecting a task.
6. `IVecEngine` builds the context pack and runs the stable harness:

   ```text
   context pack -> decision -> action executor -> deterministic verification -> progress reducer
   ```

7. The model either replies directly, loads a bounded tool group, selects or
   creates a task, asks for necessary feedback, or calls one executable tool.
8. The action executor validates the selected tool and input, executes it, and
   converts its result into verified facts and evidence.
9. The progress reducer updates sparse run state. The daemon sends the final
   reply through the originating transport.
10. The Git Context service finalizes lifecycle records. For V1 task work, it
    commits verified changes and the request outcome in the selected
    repository. Raw run evidence remains in SQLite/session journals.

Clients remain communication surfaces. They do not own agent intelligence,
memory policy, task selection, provider choice, or long-running state.

## Task Selection and Mutation

Every provider-handled turn begins as a session run. The prompt projection can
show task candidates, but a candidate is not implicit permission to mutate it.

For durable work the model uses these public tools:

- `git_context_create_task`: create and select a new `T-*` repository.
- `git_context_activate_task`: select an existing repository. The call
  the call must explicitly pass `requestDecision.kind="continue"` or
  `requestDecision.kind="create"`.

Successful responses return the selected task/run identity, stable working
directory, and refreshed harness context containing the request.

Once selected, task-scoped tools receive the stable task working directory.
The runtime—not the model—updates `.ayati/`, finalizes the request, and creates
the task commit. A mutation must never be inferred from a previously active
task in another session or turn.

## Session and Context Flow

1. A daily session is a normal Git repository.
2. Session metadata lives at `session/meta.json`; conversation records live
   under `conversations/`.
3. Session commits checkpoint conversation continuity independently of task
   repositories.
4. Git Context builds a bounded projection containing conversation tail,
   pending-turn state, task candidates or selection, current request, compact
   task state, recent activity, and useful evidence pointers.
5. Personal memory adds stable preferences and facts. Episodic memory can add
   semantic recall when embeddings are available.
6. The prompt receives summaries and pointers, not every repository, full Git
   history, or raw tool output.

SQLite is the operational index and run journal. Git repositories are the
portable durable record for session conversation and task state. These stores
have different responsibilities and should not mirror all data into each
other.

## Attachment and Reference Flow

1. Clients attach paths or uploaded bytes to a message.
2. The daemon normalizes them into the managed file/directory libraries under
   `ayati-main/data/`.
3. Run state carries compact attachment summaries. Tools inspect or query the
   managed copy.
4. When an attachment becomes useful durable task context, Git Context copies
   or records it under `.ayati/inbox/` or `.ayati/references/` according to the
   task contract.
5. `.ayati/inbox/` is ignored staging. Curated references are tracked only when
   they are safe, useful, and reasonably sized.

The original managed attachment store remains separate from task Git. This
prevents large or sensitive user inputs from being committed accidentally.

## External Action Flow

Shell, filesystem, browser, desktop, database, and external HTTP tools are
high-privilege capabilities. The action executor enforces tool contracts and
verification before their results affect progress.

For task-scoped external work, the task repository should retain a compact
outcome or evidence pointer, not an uncontrolled transcript or secret-bearing
payload. A standardized external computer-use outcome format is still deferred;
until it exists, final summaries must distinguish verified task changes from
external side effects.

## Workspace Orchestration

The CLI can provide terminal-window context. `WorkspaceOrchestrator` treats the
terminal as the protected anchor, reads Hyprland state, persists compact UI
state under `data/ui/workspace-orchestrator.json`, and applies bounded role-based
window operations. This UI state is runtime data, not task-repository state.

## System Events

1. Plugins and Pulse normalize events.
2. `SystemIngressService` queues them in the inbound queue.
3. `SystemEventWorker` sends them through `IVecEngine.handleSystemEvent`.
4. `context/system-event-policy.json` controls handling behavior.
5. The daemon may reply, notify, request approval, schedule follow-up work, or
   use tools according to policy.
