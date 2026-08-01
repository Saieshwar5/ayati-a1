# Product Overview

Ayati is an autonomous general AI agent intended to help with computer work,
files, communication, reminders, learning, research, automation, and other
long-running real-life goals.

The core product is a persistent local daemon. `ayati-main` can run for long
periods while clients connect through different communication surfaces. The
CLI is the current client; models, tools, plugins, clients, memory, and channels
can evolve without replacing the daemon or harness.

The harness remains:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

Ayati should feel continuous without requiring users to manage sessions,
context windows, or internal work lists. Every accepted message or system event
creates one run. Conversation and observational work can finish unbound;
durable work binds that same run to one workstream and request.

Each run starts at `ENTRY` and may navigate read-only locate/investigate modes,
a control-only `workstream.route` stage for unbound mutation, a deterministic
binding gate, bound execution, and whole-task validation. Workstream search,
read, and resource-owner lookup use the ordinary observation modes. A
successful current-run ownership observation unlocks `workstream.route`,
which exposes no executable tools and leads to resolve or back to observation
when more evidence is needed. The binding gate validates one typed proposal
without calling a model. This is a small harness-enforced capability graph
inside the existing loop, not a second planner, agent, or session-level state
machine.

Continuity lives in one slow-growing agent stream across clients and runs.
Fast-growing WorkState, steps, tool calls, and verification remain inside the
current run. Conversation-budget pressure creates a durable anchored stream
checkpoint. Whole-request pressure instead enters a run-only maintenance mode,
checkpoints the small WorkState handoff, and replaces eligible older tool
payloads with typed projections or exact journal references. Exact older
discussion and run evidence remain available through explicit history reads.

Durable work is represented by two separate concepts:

- A workstream is compact long-lived context: objective, requests, progress,
  blockers, next action, and resource relationships.
- A resource is the real thing being read or changed: a file, directory,
  document, media item, URL, dataset, database, repository, or external object.

One shared workstream repository is the context-only Git history. Each
workstream contains a distilled card, bounded request contracts, an append-only
progress ledger, and a generated resource projection. Deliverables remain in
the user-visible workspace or at the path the user selected. Ayati does not
initialize Git for ordinary output unless the user asks for it.

Filesystem work uses canonical absolute paths. The agent follows an explicit
user destination, reuses a clearly related project directory, or creates one
named directory under `<AYATI_ROOT_DIR>/workspace/`. Ordinary directory and
file creation does not require a resource record first; verified outputs are
added to the resource catalog during finalization.

Primary value:

- A local-first autonomous agent with composable capabilities.
- One durable run boundary with truthful finalization and restart recovery.
- Autonomous workstream discovery using exact identity, resource ownership,
  unfinished work, stars, recency, frequency, and semantic text relevance.
- Explicit request routing that distinguishes continuation, contract
  amendment, a new bounded outcome in the same project, and a new workstream.
- One immutable progress entry and one recoverable shared-repository commit
  for every finalized workstream-bound run.
- Safe filesystem mutation through immutable workstream ownership, an exact
  selected destination root, containment checks, and deterministic tool
  verification. Existing-resource and destructive operations retain stronger
  resource-scoped controls.
- A resource catalog that lets the agent find resources from workstreams and
  workstreams from resources.
- A simple default output location at `<AYATI_ROOT_DIR>/workspace/` when the
  user does not specify a path.
- Personal and episodic memory for user facts, preferences, and recalled
  experience without mixing them into workstream state.
- Multi-channel communication and proactive system-event handling.

Current packages:

- `ayati-main`: daemon, harness, providers, tools, memory, events, WebSocket,
  and HTTP APIs.
- `ayati-cli`: Ink/React terminal client.
- `ayati-context-engine`: local SQLite-and-Git service that owns agent streams,
  immutable messages, runs, checkpoints, history, workstream context,
  resources, mutation journals, and finalization.
