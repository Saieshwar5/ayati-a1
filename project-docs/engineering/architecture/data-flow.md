# Data Flow

## Ingress and Run Preparation

1. A client sends a user message or an integration emits a normalized system
   event.
2. The daemon submits one stable preparation request to Git Context.
3. One transaction ensures the daily session, creates the conversation
   segment, appends the message, creates one run and initial WorkState, binds
   the conversation to the run, and stores the idempotency receipt.
4. The response returns the same message, conversation, and run on replay.
   Another active run causes the whole competing transaction to roll back.

## Decision and Steps

The daemon enters the stable harness:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

An unbound run may reply, list, read, search, inspect resources, or route. The
model can create or activate a workstream; that control binds the existing run
and returns refreshed context. After binding, the model makes a fresh decision.

Each executor step persists one structured ordered record containing decision,
action, tool calls, verification, and resulting WorkState. The same transaction
updates run step count. The persistence response carries rebuilt reusable read
context, avoiding a second full active-context fetch.

## Workstream and Resource Flow

Workstream candidates come from deterministic catalog discovery. Exact
resource ownership and explicit continuation outrank text, unfinished, star,
recency, and frequency signals.

A selected workstream supplies context and resource bindings. Real operations
run against resource locators, never the context repository. Before mutation,
the service admits exact targets and records their versions; after execution,
it observes the same targets and verifies the effect.

If the user supplied no destination, new output is placed under
`<AYATI_ROOT_DIR>/workspace/` and cataloged as a resource. User-specified paths
remain canonical in place.

## Finalization

The daemon sends one finalization request and waits for acknowledgement. Git
Context loads binding from the run, closes the conversation/run, records
verified resource effects, reduces workstream context when needed, and creates
at most one context commit. Deliverables are not staged in workstream Git.

Only then does the daemon send the terminal response envelope. A failed or
uncertain finalization produces a failure envelope and retains its recovery
journal.

## Attachments

Uploads and referenced inputs are admitted as resources before routing.
Uploaded bytes use immutable managed storage under `.ayati/resources/`;
referenced resources remain at their source path. Session and workstream
bindings point to the same resource identity.

## Memory

SQLite owns authoritative operational records: sessions, messages, runs,
steps, WorkState, resources, bindings, and journals. Context-only Git provides
portable workstream continuity. Personal memory stores stable user facts and
preferences; episodic memory supports semantic recall. These stores are
complementary and do not mirror all data into each other.

## System Events

Plugins and Pulse normalize events through `SystemIngressService` and
`SystemEventWorker`. System events use the same preparation, action, step, and
finalization lifecycle as chat turns; only delivery policy differs.
