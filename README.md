# Ayati

Ayati is a modular AI agent platform built as a small monorepo.

It includes:

- `ayati-main`: the backend agent runtime and transport servers
- `ayati-cli`: a terminal chat client built with Ink + React
- `ayati-web`: a Next.js web chat interface

Ayati is designed around a provider-agnostic runtime, composable skills/tools, layered prompt context, session memory, document handling, and artifact generation.

## What Ayati Includes

- WebSocket-based chat runtime
- Terminal and web chat clients
- File upload support
- Document ingestion and retrieval
- Session memory and recall
- Tool execution through built-in skills
- Runtime-selectable LLM providers
- Plugin lifecycle support
- Artifact serving for generated outputs such as images and run files

## Repository Layout

```text
.
|- README.md
|- ayati-main/   # backend runtime, WebSocket server, upload/artifact server
|- ayati-cli/    # Ink-based terminal client
`- ayati-web/    # Next.js web client
```

## Package Overview

### `ayati-main`

The backend service. It is responsible for:

- bootstrapping the `IVecEngine`
- loading static context and skills
- managing session memory and retrieval
- accepting chat messages over WebSocket
- accepting uploaded files over HTTP
- serving generated artifacts
- loading runtime provider configuration
- starting plugins and system event flows

Default runtime ports:

- WebSocket chat server: `ws://localhost:8080`
- Upload/artifact server: `http://localhost:8081`

### `ayati-cli`

A terminal client for chatting with Ayati over WebSocket.

Features include:

- terminal-first chat workflow
- local attachment queue
- lightweight status and reply rendering

Supported input commands:

- `/attach <local-file-path>`
- `/attach <local-file-path> -- <message>`
- `/files`
- `/clearfiles`

### `ayati-web`

A browser-based chat interface built with Next.js.

Features include:

- live chat over WebSocket
- file uploads to the backend upload API
- Markdown rendering for assistant replies
- connection state feedback
- artifact preview and download support

## Architecture Summary

At runtime, Ayati works like this:

1. A user sends a message from the CLI or web app.
2. The client sends the message to `ayati-main` over WebSocket.
3. The backend loads context, tools, memory, and the active provider.
4. The `IVecEngine` runs the agent loop and executes tools when needed.
5. Uploaded files and generated artifacts are managed by the backend HTTP server.
6. Replies and artifact metadata are returned to the client.
7. Runtime data is persisted under `ayati-main/data/`.

## Prerequisites

- Node.js 20+
- npm

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

You do not need all of them at once. You only need the key for the active provider.

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

## Web Client Environment

`ayati-web` can run with defaults, but you can override backend endpoints with `.env.local`.

Example:

```env
NEXT_PUBLIC_AYATI_WS_URL=ws://localhost:8080
NEXT_PUBLIC_AYATI_UPLOAD_URL=http://localhost:8081/api/uploads
NEXT_PUBLIC_AYATI_ARTIFACT_BASE_URL=http://localhost:8081
```

## LLM Provider Configuration

Ayati supports these providers at runtime:

- OpenRouter
- OpenAI
- Anthropic
- Fireworks

The active provider is managed through the backend runtime config in:

- `ayati-main/data/runtime/llm-config.json`

That means provider choice is runtime-configurable rather than locked to one provider implementation.

## Documents and Attachments

Ayati can ingest uploaded files and use them in chat workflows.

The backend includes document handling for common formats such as:

- PDF
- DOCX
- PPTX
- XLSX
- CSV
- TXT
- Markdown
- JSON
- HTML

Uploads are accepted through the backend HTTP API and stored under backend-managed data directories.

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

Backend runtime output is stored under `ayati-main/data/`, including things like:

- session data
- memory indexes
- document data
- runtime config
- generated run artifacts

These files are runtime state, not source code.

## Security Notes

- Never commit secrets or API keys.
- Keep credentials in local env files only.
- Do not document real keys in README examples.
- Review tool access and runtime policies before exposing the backend beyond local development.

## Important Internal References

If you want to go deeper into the architecture, start with:

- `ayati-main/AGENT.md`
- `ayati-main/AGENTS.md`
- `ayati-main/src/app/main.ts`

## Current Status

Ayati is structured as a modular agent system with separate backend, CLI, and web surfaces. The backend already supports runtime provider selection, built-in tools/skills, memory, document workflows, and artifact delivery, while the clients provide terminal and browser-based access to the same core runtime.
