# Ayati

Ayati is a local-first autonomous AI agent platform. It combines a persistent
daemon, provider-independent agent harness, durable work continuity, resources,
memory, composable tools, events, and a terminal client.

The core design goal is to keep the agent chassis stable while models, skills,
tools, plugins, clients, and memory behavior evolve independently.

## Packages

- `ayati-main`: daemon, harness, providers, tools, memory, WebSocket/HTTP
  servers, plugins, Pulse, and system events.
- `ayati-git-context`: independent local SQLite-and-Git service for sessions,
  runs, workstreams, requests, resources, discovery, steps, finalization, and
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

The model can reply directly, load a bounded tool working set, call one
selected executable tool, ask for focused feedback during bound work, or submit
`workstream_completion`. Tool results advance progress only after deterministic
verification.

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
    git-context.sock
    sessions/
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

One finalization operation closes the run and conversation, records verified
resource effects, reduces workstream context when useful, and creates at most
one context-only commit. Deliverables are never staged into workstream Git.

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
- Optional JSONL feedback traces, compact triage, and a workstream lifecycle
  report.
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

pnpm --filter ayati-git-context build
pnpm --filter ayati-git-context test
pnpm --filter ayati-main build
pnpm --filter ayati-main test
pnpm --filter ayati-cli build
pnpm --filter ayati-cli test
```

Feedback-enabled daemon:

```bash
pnpm dev:main:feedback
pnpm feedback:git-context
```

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
controls. Feedback/full-prompt traces may contain sensitive content.

## Architecture References

- `project-docs/product/overview.md`
- `project-docs/engineering/architecture/overview.md`
- `project-docs/engineering/architecture/workstreams-and-resources.md`
- `project-docs/engineering/architecture/agent-harness.md`
- `project-docs/engineering/architecture/context-and-memory.md`
- `project-docs/engineering/testing.md`
