# Ayati

Ayati is a local-first autonomous AI agent platform. It combines a persistent
daemon, provider-independent agent harness, durable work continuity, resources,
memory, composable tools, events, and a terminal client.

The core design goal is to keep the agent chassis stable while models, skills,
tools, plugins, clients, and memory behavior evolve independently.

## Packages

- `ayati-main`: daemon, harness, providers, tools, memory, WebSocket/HTTP
  servers, plugins, Pulse, and system events.
- `ayati-context-engine`: in-process SQLite-and-Git engine for streams, runs,
  workstreams, requests, resources, checkpoints, history, finalization, and
  recovery.
- `ayati-cli`: Ink/React terminal client.
- `project-docs`: stable product and engineering context.

## Harness

Ayati uses one execution model:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

Every accepted user message or system event creates one atomic run. A run may
finish unbound for conversation or observation, or bind immutably to one
workstream/request for durable work. The run id never changes after binding.

Every run starts at `ENTRY`. The model can reply directly only for genuinely
tool-free requests, or navigate a small run-scoped graph through read-only
observation, deterministic workstream binding, bound execution, and whole-task
validation. Workstream routing observation stays in the same model loop;
`resolve` is a zero-model-call gate over one typed proposal. The model selects
capability groups, the harness mounts eligible concrete tools, and each
transition replaces the working set. Tool results advance progress only after
deterministic verification, and accepted validation carries the final response
without another model call.

## Durable Work

Ayati separates continuity from real output:

```text
workstream = compact long-lived context
request    = bounded intention inside a workstream
resource   = real file, directory, URL, dataset, database, repository, or external object
run        = one compute/audit/recovery boundary
```

Workstream `W-*` directories are context-only Git repositories. They contain a
workstream card, request files, and a portable resource ledger—never project
files or deliverables.

The resource catalog stores stable identities, real locators, versions,
descriptions, aliases, availability, and workstream relationships. It supports
both `workstream -> resources` and `resource -> workstreams` discovery.

When the user gives no output path, Ayati uses the visible default workspace.
When the user names a path, the resource remains there. Ordinary output does
not cause automatic Git initialization.

## Managed Filesystem Layout

Set one root with `AYATI_ROOT_DIR`:

```text
<AYATI_ROOT_DIR>/
  workspace/       default user-visible output
  workstreams/     context-only Git repositories
  .ayati/
    context.db
    resources/     immutable admitted attachment bytes
```

The default is `ayati-main/ayati`.

## Workstream Discovery and Safety

The agent can autonomously find, read, create, and activate workstreams using
explained signals: exact identity, resource ownership, unfinished request,
text relevance, explicit star, recency, and frequency. Recency and stars help
sorting but never grant mutation authority.

An unbound run may converse, list, read, search, inspect, and route. Mutation
requires all of:

- an immutable workstream/request binding;
- a bound resource with mutation access;
- exact admitted targets;
- before/after resource observations;
- deterministic verification.

After routing, Ayati refreshes context and asks the model for a fresh decision.
Mutation calls are not deferred or replayed.

## Finalization

One finalization operation closes the run, appends its immutable assistant
message, records verified resource effects, reduces workstream context when
useful, and creates at most one context-only commit. Deliverables are never
staged into workstream Git.

Final text may stream, but the terminal envelope is sent only after durable
finalization acknowledgement. Failure or uncertain recovery state cannot be
reported as a successful commit.

## Other Capabilities

- OpenRouter, OpenAI, Anthropic, and Fireworks providers.
- Filesystem inspection/read/write/patch/search, focused process execution,
  Python, SQLite, documents, datasets, managed files, and artifacts.
- Personal memory and episodic recall.
- Upload admission and immutable attachment resources.
- Pulse reminders, scheduled events, plugins, and system-event handling.
- Passive, opt-in live-daemon evaluation with exact evidence, deterministic
  diagnostics, and per-turn/session reports.
- WebSocket terminal chat and HTTP upload/artifact/Pulse APIs.

## Quick Start

Requirements: Node.js 20+ and pnpm.

```bash
pnpm install
pnpm build
pnpm start:main
```

In another terminal:

```bash
pnpm start:cli
```

Provide the API key for the configured provider in a local env file:

```env
OPENAI_API_KEY=
OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=
FIREWORKS_API_KEY=
AYATI_ROOT_DIR=
```

Default endpoints:

- WebSocket: `ws://localhost:8080`
- HTTP: `http://127.0.0.1:8081`

## Development

```bash
pnpm build
pnpm test

pnpm --filter ayati-context-engine build
pnpm --filter ayati-context-engine test
pnpm --filter ayati-main build
pnpm --filter ayati-main test
pnpm --filter ayati-cli build
pnpm --filter ayati-cli test
```

Live daemon evaluation:

```bash
pnpm eval:agent -- live --name <name> [--watch] [--capture full|safe]
pnpm eval:agent -- inspect --evaluation <id> --latest
pnpm eval:agent -- report --evaluation <id>
```

The older `dev:main:feedback`, `start:main:feedback`, and
`feedback:context-engine` commands are compatibility aliases for this same
evaluation/report path.

Safe context-state operations are preview-first:

```bash
pnpm context:archive-reset
pnpm context:archive-reset -- --confirm
pnpm context:catalog-rebuild
pnpm context:catalog-rebuild -- --confirm
```

## Security

Ayati tools can access local files, processes, Python, databases, and external
systems. Keep credentials in local env files, review enabled capabilities, and
do not expose the daemon beyond trusted environments without stronger access
controls. Live-evaluation evidence may contain sensitive content even though
recognized credentials are redacted; use `--capture safe` when exact local
text is inappropriate.

## Architecture References

- `project-docs/product/overview.md`
- `project-docs/engineering/architecture/overview.md`
- `project-docs/engineering/architecture/workstreams-and-resources.md`
- `project-docs/engineering/architecture/agent-harness.md`
- `project-docs/engineering/architecture/context-and-memory.md`
- `project-docs/engineering/testing.md`
