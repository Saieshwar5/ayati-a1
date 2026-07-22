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
a deterministic binding gate, bound execution, and whole-task validation.
Workstream discovery is read-only observation in the same primary model loop;
the binding gate validates one typed proposal without calling a model. This is
a small harness-enforced capability graph inside the existing loop, not a
second planner, agent, or session-level state machine.

Continuity lives in one slow-growing agent stream across clients and runs.
Fast-growing WorkState, steps, tool calls, and verification remain inside the
current run. Under measured pressure Ayati creates a durable anchored
checkpoint, while exact older discussion and evidence remain available through
explicit history search/read tools.

Durable work is represented by two separate concepts:

- A workstream is compact long-lived context: objective, requests, progress,
  blockers, next action, and resource relationships.
- A resource is the real thing being read or changed: a file, directory,
  document, media item, URL, dataset, database, repository, or external object.

Workstream repositories are context-only Git histories. Deliverables remain in
the user-visible workspace or at the path the user selected. Ayati does not
initialize Git for ordinary output unless the user asks for it.

Primary value:

- A local-first autonomous agent with composable capabilities.
- One durable run boundary with truthful finalization and restart recovery.
- Autonomous workstream discovery using exact identity, resource ownership,
  unfinished work, stars, recency, frequency, and semantic text relevance.
- Safe mutation through immutable workstream binding plus exact resource
  scopes and deterministic before/after verification.
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
  immutable messages, runs, checkpoints, history, reusable observations,
  workstream context, resources, mutation journals, and finalization.
