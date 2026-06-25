# Ayati

Ayati is a modular AI agent platform built as a small monorepo. It combines a
provider-agnostic agent runtime, layered prompt context, memory systems,
composable tools, file/document handling, generated artifacts, and a terminal
chat interface.

The core idea is simple: keep the agent "chassis" stable while allowing models,
skills, tools, plugins, clients, and memory behavior to evolve independently.

This repository includes:

- `ayati-main`: the backend agent runtime, WebSocket server, HTTP API, memory, tools, plugins, and event processing
- `ayati-cli`: a terminal chat client built with Ink and React

## What Ayati Is

Ayati is designed as an autonomous agent harness rather than a single prompt
wrapper. The backend coordinates user messages, runtime context, tools, memory,
external events, files, and model providers through the `IVecEngine`
Intelligence Variable Execution Core.

At a high level, Ayati provides:

- A runtime-selectable LLM provider layer for OpenRouter, OpenAI, Anthropic, and Fireworks
- Stable decision rules plus a structured state view containing bounded timeline context, continuity, same-session work, optional task-thread context, attachments, memory snapshots, progress, observations, and system activity
- A native-tool decision loop that chooses a control tool or one selected executable tool, then verifies tool work deterministically
- Built-in skills for shell, filesystem, calculator, SQLite database work, Python execution, documents, datasets, files, memory, recall, identity, and Pulse scheduling
- Focus cards, attention shelf, personal memory, and episodic recall for continuity and personalization
- Episodic recall for searching past sessions and run history
- Managed file registration, upload processing, document extraction, structured data profiling, and artifact serving
- Run-scoped tool working sets for built-in skills
- Pulse scheduling and system-event processing
- A terminal client that talks to the backend runtime

## Repository Layout

```text
.
|- README.md
|- project-docs/ # product and engineering docs for humans and AI agents
|- ayati-main/   # backend runtime, WebSocket server, upload/artifact server, tools, memory, plugins
`- ayati-cli/    # Ink-based terminal client
```

## Agent Runtime

The backend runtime is centered on `ayati-main/src/app/main.ts` and
`ayati-main/src/ivec/index.ts`.

Ayati runs work through the current harness loop:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

Before each decision, the runner may deterministically preload likely tools into
a bounded working set. The decision model then chooses one next outcome by
calling exactly one native provider tool:

- `decision_reply`: answer or finish without tool work.
- `decision_ask_user`: request missing information before safe progress.
- `decision_load_tools`: request hidden tools by exact group, exact tool name, or search query.
- one selected executable tool, such as `read_file`, `write_files`, `edit_file`, or `shell`.

Tool work is validated, executed, checked through tool contracts/assertions, and
reduced into task progress before the next decision. System events such as
reminders enter the same harness with event-policy constraints.

## How Ayati Works In Practice

1. A user sends a message from the CLI or another runtime input.
2. `ayati-main` receives the message through WebSocket, HTTP, or a plugin event adapter.
3. The backend loads static decision rules, session state, continuity summaries, memory snapshots, the hidden tool catalog, and the configured LLM provider.
4. `IVecEngine` builds a bounded context pack and enters the agent runner.
5. The decision model calls one native provider tool: `decision_reply`, `decision_ask_user`, `decision_load_tools`, or one selected executable tool.
6. If more tools are needed, Ayati loads a run-scoped working set from strict selectors and reports the load result into the next decision state.
7. If an executable tool is called, Ayati adapts that native call into an internal action record, validates it, executes it through the tool executor, verifies results with contracts/assertions, and updates progress from verified facts.
8. Files, documents, datasets, Python outputs, and other generated files are stored as managed runtime data or run artifacts.
9. Session history, focus cards, personal memory candidates, episodic memory indexes, system activity, and task state are persisted under `ayati-main/data/`.
10. The final reply and any artifact metadata are returned to the active client.

## Runtime Capabilities

### Models and Providers

Ayati can switch model providers at runtime without changing the core agent
loop. Provider adapters live under `ayati-main/src/providers/`.

Supported providers:

- OpenRouter
- OpenAI
- Anthropic
- Fireworks

The active provider is stored in:

- `ayati-main/data/runtime/llm-config.json`

The same file also stores the active embedding provider/model and image
generation provider/model. Chat, embeddings, and image generation are separate
runtime categories so memory, document retrieval, and image tools can use the
right API without coupling to the chat provider.

Provider API keys are read from the backend `.env` file.

### Prompt Context

Ayati separates stable operating rules from dynamic runtime context.

Stable system context can include:

- Base system prompt
- Soul and identity context
- Skill prompt blocks
- Available tool definitions

Dynamic context is sent to the decision model as structured JSON in the context
pack and sparse state view:

- Bounded `context.timeline` events, ending with the current input
- Durable `context.continuity` for selected activity or project state
- Same-session `context.taskThreadContext` and `context.sessionWork`
- Optional `context.personalMemorySnapshot`
- Current `progress`, `workingFeedback`, `toolLoad`, `observations`, `trace`, `attachments`, and `systemEvent` sections when present

This keeps memory and continuation visible without hiding important facts inside
a large truncatable prompt string.

### Memory and Continuity

Ayati has several memory paths:

- Session memory stores active conversation state and handoff summaries.
- Focus cards track meaningful ongoing work such as projects, documents, automations, investigations, and debugging.
- The attention shelf injects compact high-relevance focus summaries into each decision.
- Personal memory stores canonical facts in sections such as `user_facts`, `time_based`, and `evolving_memory`.
- Episodic memory indexes closed sessions for later semantic recall when embeddings are available.
- The built-in recall tools can search past work by query, date range, or episode type.

Personal memory is managed through explicit tools such as `memory_search`,
`memory_remember`, `memory_forget`, `memory_explain`, and `memory_feedback`.

### Files, Documents, and Data

Ayati can ingest uploaded or local files, register generated artifacts, extract
text, query document sections, and profile structured datasets.

Common supported formats include:

- PDF
- DOCX
- PPTX
- XLSX
- CSV
- TXT
- Markdown
- JSON
- HTML

Structured attachments can be inspected, queried with SQL, or promoted into a
durable SQLite table. Text documents can be read by section or queried through
retrieval when vector indexing is enabled.

### Built-In Skills and Tools

The backend registers a hidden catalog of built-in skills and tools:

- Shell and filesystem tools for local workspace work
- Calculator tools for deterministic arithmetic
- SQLite database tools for schema inspection, table creation, row operations, and SQL execution
- Python execution with managed run directories and captured artifacts
- Document and dataset tools for prepared attachments
- Managed file tools for upload registration, URL fetches, text reads, table profiling, and file queries
- Memory and recall tools for personal facts and episodic history
- Identity tools for updating agent identity context
- Pulse tools for reminders, notifications, scheduled tasks, previews, snoozing, and health checks

The decision prompt receives a compact routing map with loadable groups and
representative tool names. Full executable schemas are exposed only through a
capped run-scoped working set as prompt context. The provider-native tools for
the decision call are meta-tools only: `decision_reply`, `decision_ask_user`,
`decision_load_tools`, and `decision_act`. `decision_load_tools` must request
tools with at least one real selector: `groups`, `toolNames`, or `query`.
Executable tools still run only through Ayati's local validation and
deterministic verification path.

### Events and Plugins

Ayati includes a plugin lifecycle and an internal system-event ingress queue.
Plugins can register adapters, publish normalized events, and let the engine
analyze or act on those events according to `context/system-event-policy.json`.

Current event sources include:

- Pulse reminders and scheduled work

## Package Overview

### `ayati-main`

The backend service. It is responsible for:

- Bootstrapping the `IVecEngine`
- Loading provider configuration
- Loading static prompt context and skill blocks
- Managing active sessions, personal memory, and episodic recall
- Accepting chat messages over WebSocket
- Accepting uploaded files over HTTP
- Serving generated run artifacts
- Registering and executing built-in tools
- Dynamically activating built-in skills
- Starting plugins and system-event workers

Default runtime ports:

- WebSocket chat server: `ws://localhost:8080`
- Upload/artifact server: `http://localhost:8081`

### `ayati-cli`

A terminal client for chatting with Ayati over WebSocket.

Features include:

- Terminal-first chat workflow
- Local attachment queue
- Lightweight status and reply rendering

Supported input commands:

- `/attach <local-file-path>`
- `/attach <local-file-path> -- <message>`
- `/files`
- `/clearfiles`

## Prerequisites

- Node.js 20+
- pnpm

Some optional capabilities need extra local dependencies or credentials:

- OpenAI API key for document and episodic memory embeddings
- Python interpreter for the managed Python tool, configurable with `AYATI_PYTHON_INTERPRETER`

## Quick Start

Install dependencies once from the repository root:

```bash
pnpm install
```

### 1. Start the backend

```bash
pnpm --filter ayati-main build
pnpm --filter ayati-main start
```

The backend expects an `.env` file in `ayati-main/`.

At minimum, provide the API key for the provider you plan to use.

Example:

```env
OPENAI_API_KEY=your_openai_key
OPENROUTER_API_KEY=your_openrouter_key
ANTHROPIC_API_KEY=your_anthropic_key
FIREWORKS_API_KEY=your_fireworks_key
```

You do not need all of them at once. You only need the key for the active
provider.

### 2. Run the CLI

In a new terminal:

```bash
pnpm --filter ayati-cli build
pnpm --filter ayati-cli start
```

## Environment Configuration

### Backend HTTP Server

The upload and artifact API defaults to `127.0.0.1:8081`. Useful overrides:

```env
AYATI_HTTP_HOST=127.0.0.1
AYATI_HTTP_PORT=8081
AYATI_HTTP_ALLOW_ORIGIN=*
AYATI_UPLOAD_MAX_BYTES=26214400
AYATI_HTTP_API_TOKEN=local_optional_token
```

## Development Commands

### `ayati-main`

```bash
pnpm --filter ayati-main build
pnpm --filter ayati-main start
pnpm --filter ayati-main dev
pnpm --filter ayati-main test
pnpm --filter ayati-main test:watch
```

### `ayati-cli`

```bash
pnpm --filter ayati-cli build
pnpm --filter ayati-cli start
pnpm --filter ayati-cli dev
pnpm --filter ayati-cli test
pnpm --filter ayati-cli test:watch
```

## Runtime Data

Backend runtime output is stored under `ayati-main/data/`, including:

- Session data
- Personal memory and episodic memory indexes
- Document and file-library data
- Runtime provider config
- Generated run artifacts
- System-event queues and plugin state

These files are runtime state, not source code.

## Security Notes

- Never commit secrets or API keys.
- Keep credentials in local env files only.
- Do not document real keys in README examples.
- Review tool access, filesystem access, plugin webhooks, and runtime event policies before exposing the backend beyond local development.
- Treat shell, filesystem, Python, database, and external HTTP-backed tools as powerful local capabilities that should be enabled only in trusted environments.

## Important Internal References

If you want to go deeper into the architecture, start with:

- `ayati-main/AGENTS.md`
- `project-docs/README.md`
- `project-docs/engineering/architecture/agent-harness.md`
- `project-docs/engineering/architecture/context-and-memory.md`
- `project-docs/engineering/architecture/tool-contracts.md`
- `ayati-main/src/app/main.ts`
- `ayati-main/src/ivec/index.ts`
- `ayati-main/src/ivec/agent-runner/runner.ts`
- `ayati-main/context/system_prompt.md`

## Current Status

Ayati is structured as a modular agent system with separate backend and CLI
packages. The backend supports runtime provider selection, the
decision-action-reducer harness, built-in skills,
focus/session/personal/episodic memory,
document/data workflows, generated artifacts, scheduled Pulse work, and
optional event-driven integrations.
