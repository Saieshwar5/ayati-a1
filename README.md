# Ayati

Ayati is a modular AI agent platform built as a small monorepo. It combines a
provider-agnostic agent runtime, layered prompt context, memory systems,
composable tools, file/document handling, generated artifacts, and multiple user
interfaces.

The core idea is simple: keep the agent "chassis" stable while allowing models,
skills, tools, plugins, clients, and memory behavior to evolve independently.

This repository includes:

- `ayati-main`: the backend agent runtime, WebSocket server, upload/artifact API, memory, tools, plugins, and event processing
- `ayati-cli`: a terminal chat client built with Ink and React
- `ayati-web`: a Next.js browser chat interface

## What Ayati Is

Ayati is designed as a staged autonomous agent runtime rather than a single
prompt wrapper. The backend coordinates user messages, runtime context, tools,
memory, external events, files, and model providers through the `IVecEngine`
Intelligence Variable Execution Core.

At a high level, Ayati provides:

- A runtime-selectable LLM provider layer for OpenRouter, OpenAI, Anthropic, and Fireworks
- Layered prompt context from the base system prompt, controller prompts, soul, memory, session state, skills, tools, and runtime activity
- A staged agent loop for understanding requests, selecting the next action, executing tools, and re-evaluating when needed
- Built-in skills for shell, filesystem, calculator, SQLite database work, Python execution, documents, datasets, files, memory, recall, identity, and Pulse scheduling
- Personal memory for stable user facts, time-based memory, and evolving preferences
- Episodic recall for searching past sessions and run history
- Managed file registration, upload processing, document extraction, structured data profiling, and artifact serving
- External skill activation from project skill manifests under runtime data
- Optional system-event integrations such as Telegram, AgentMail, and Nylas Mail
- Terminal and browser clients that talk to the same backend runtime

## Repository Layout

```text
.
|- README.md
|- ayati-main/   # backend runtime, WebSocket server, upload/artifact server, tools, memory, plugins
|- ayati-cli/    # Ink-based terminal client
`- ayati-web/    # Next.js web client
```

## Agent Runtime

The backend runtime is centered on `ayati-main/src/app/main.ts` and
`ayati-main/src/ivec/index.ts`.

Ayati runs work through named stages:

- `understand`: identify the real user goal and decide whether the request can be answered directly or needs action
- `direct`: choose the single next useful action, including tool calls or external skill activation
- `reeval`: change course when evidence shows the current path is failing or incomplete
- `system_event`: handle internal and external events such as reminders or inbound mail with the configured event policy

This separation keeps the agent from mixing planning, execution, and
verification. Each cycle is grounded in the current conversation, static
context, memory, available tools, run state, and provider capabilities.

## How Ayati Works In Practice

1. A user sends a message from the CLI, web app, Telegram, or another runtime input.
2. `ayati-main` receives the message through WebSocket, HTTP, polling, or a plugin event adapter.
3. The backend loads static context, current session state, memory snapshots, available tools, active skills, and the configured LLM provider.
4. The `IVecEngine` asks the model to understand the request and choose the next responsible step.
5. If tools are needed, Ayati validates the tool request, executes it through the tool executor, and feeds the result back into the loop.
6. Files, documents, datasets, Python outputs, and other generated files are stored as managed runtime data or run artifacts.
7. Session history, personal memory candidates, episodic memory indexes, system activity, and task state are persisted under `ayati-main/data/`.
8. The final reply and any artifact metadata are returned to the active client.

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

Provider API keys are read from the backend `.env` file.

### Prompt Context

Ayati assembles a deterministic runtime prompt from multiple layers:

- Base system prompt
- Controller prompts
- Soul and identity context
- Personal memory snapshot
- Previous conversation and current session context
- Recent tasks and recent system activity
- Skill prompt blocks
- Available tool definitions
- Session status

This makes behavior easier to inspect and update because stable operating rules,
personality, memory, and capability descriptions are kept separate.

### Memory and Continuity

Ayati has several memory paths:

- Session memory stores active conversation state and handoff summaries.
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

The backend starts with a broad built-in tool set:

- Shell and filesystem tools for local workspace work
- Calculator tools for deterministic arithmetic
- SQLite database tools for schema inspection, table creation, row operations, and SQL execution
- Python execution with managed run directories and captured artifacts
- Document and dataset tools for prepared attachments
- Managed file tools for upload registration, URL fetches, text reads, table profiling, and file queries
- Memory and recall tools for personal facts and episodic history
- Identity tools for updating agent identity context
- Pulse tools for reminders, notifications, scheduled tasks, previews, snoozing, and health checks

External skills can also be discovered from runtime skill manifests and mounted
for the current run through the skill broker.

### Events and Plugins

Ayati includes a plugin lifecycle and an internal system-event ingress queue.
Plugins can register adapters, publish normalized events, and let the engine
analyze or act on those events according to `context/system-event-policy.json`.

Current plugin paths include:

- AgentMail inbound mail events
- Nylas Mail inbound mail events
- Optional Telegram chat transport
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
- Discovering and activating external skills
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

### `ayati-web`

A browser-based chat interface built with Next.js.

Features include:

- Live chat over WebSocket
- File uploads to the backend upload API
- Markdown rendering for assistant replies
- Connection state feedback
- Artifact preview and download support

## Prerequisites

- Node.js 20+
- npm

Some optional capabilities need extra local dependencies or credentials:

- OpenAI API key for document and episodic memory embeddings
- Python interpreter for the managed Python tool, configurable with `AYATI_PYTHON_INTERPRETER`
- Telegram, AgentMail, or Nylas credentials when those integrations are enabled

## Quick Start

Install dependencies separately in each package you want to run.

### 1. Start the backend

```bash
cd ayati-main
npm install
npm run build
npm start
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
cd ayati-cli
npm install
npm run build
npm start
```

### 3. Run the web app

In another terminal:

```bash
cd ayati-web
npm install
npm run dev
```

Then open the local Next.js URL shown in the terminal.

## Environment Configuration

### Web Client

`ayati-web` can run with defaults, but you can override backend endpoints with
`.env.local`.

Example:

```env
NEXT_PUBLIC_AYATI_WS_URL=ws://localhost:8080
NEXT_PUBLIC_AYATI_UPLOAD_URL=http://localhost:8081/api/uploads
NEXT_PUBLIC_AYATI_ARTIFACT_BASE_URL=http://localhost:8081
```

### Backend HTTP Server

The upload and artifact API defaults to `127.0.0.1:8081`. Useful overrides:

```env
AYATI_HTTP_HOST=127.0.0.1
AYATI_HTTP_PORT=8081
AYATI_HTTP_ALLOW_ORIGIN=*
AYATI_UPLOAD_MAX_BYTES=26214400
AYATI_HTTP_API_TOKEN=local_optional_token
```

### Optional Integrations

Telegram is enabled when configured with:

```env
AYATI_TELEGRAM_ENABLED=true
AYATI_TELEGRAM_BOT_TOKEN=your_bot_token
AYATI_TELEGRAM_ALLOWED_CHAT_ID=your_chat_id
```

AgentMail and Nylas Mail are optional plugin integrations. Their plugin modules
read environment variables such as:

```env
AGENTMAIL_PLUGIN_ENABLED=true
AGENTMAIL_API_KEY=your_agentmail_key
AGENTMAIL_INBOX_ID=your_inbox_id
AGENTMAIL_WEBHOOK_PUBLIC_URL=https://your-public-url.example/webhook

NYLAS_MAIL_PLUGIN_ENABLED=true
NYLAS_API_KEY=your_nylas_key
NYLAS_GRANT_ID=your_grant_id
NYLAS_WEBHOOK_PUBLIC_URL=https://your-public-url.example/webhook
```

## Development Commands

### `ayati-main`

```bash
npm run build
npm start
npm run dev
npm test
npm run test:watch
```

### `ayati-cli`

```bash
npm run build
npm start
npm run dev
npm test
npm run test:watch
```

### `ayati-web`

```bash
npm run dev
npm run build
npm run start
npm run lint
```

## Runtime Data

Backend runtime output is stored under `ayati-main/data/`, including:

- Session data
- Personal memory and episodic memory indexes
- Document and file-library data
- Runtime provider config
- External skill catalog/cache data
- Generated run artifacts
- System-event queues and plugin state

These files are runtime state, not source code.

## Security Notes

- Never commit secrets or API keys.
- Keep credentials in local env files only.
- Do not document real keys in README examples.
- Review tool access, filesystem access, external skill policy, plugin webhooks, and runtime event policies before exposing the backend beyond local development.
- Treat shell, filesystem, Python, database, and external HTTP-backed tools as powerful local capabilities that should be enabled only in trusted environments.

## Important Internal References

If you want to go deeper into the architecture, start with:

- `ayati-main/AGENT.md`
- `ayati-main/AGENTS.md`
- `ayati-main/src/app/main.ts`
- `ayati-main/src/ivec/index.ts`
- `ayati-main/context/system_prompt.md`

## Current Status

Ayati is structured as a modular agent system with separate backend, CLI, and web
surfaces. The backend supports runtime provider selection, staged agent control,
built-in and external skills, personal and episodic memory, document/data
workflows, generated artifacts, scheduled Pulse work, and optional event-driven
integrations.
