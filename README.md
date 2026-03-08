# Ayati

Ayati is a modular AI agent system with two parts:

- `ayati-main`: the agent server (engine, memory, skills, provider adapters, WebSocket transport)
- `ayati-cli`: a terminal chat client built with Ink + React

## How the Agent Works

At runtime, Ayati follows this flow:

1. The CLI sends a chat message to the server over WebSocket (`ws://localhost:8080`).
2. The server bootstraps the runtime:
   - loads the LLM provider (OpenAI by default)
   - loads static context layers (`context/system_prompt.md`, `context/soul.json`, `context/user_profile.json`)
   - loads built-in skills/tools
3. `IVecEngine` builds a layered system prompt using static context + session memory.
4. The agent loop runs:
   - decides next action
   - calls tools when needed
   - verifies outcomes
   - produces the final assistant reply
5. Memory and run artifacts are persisted under `ayati-main/data/`.
6. The final reply is streamed back to the CLI.

### Runtime Architecture (high-level)

```text
User (CLI)
   -> ayati-cli (Ink UI)
      -> WebSocket message
         -> ayati-main WsServer
            -> IVecEngine
               -> Provider (OpenAI/Anthropic)
               -> Skills/Tools (shell, filesystem, calculator, notes, pulse, identity, recall)
               -> Memory (session + retrieval)
            -> assistant reply
         -> CLI render
```

## Repository Structure

```text
.
├─ ayati-main/   # agent server
│  ├─ src/
│  ├─ context/
│  ├─ tests/
│  └─ data/      # runtime artifacts (generated)
└─ ayati-cli/    # terminal client
   ├─ src/
   └─ dist/
```

## Prerequisites

- Node.js 20+
- npm

## Quick Start

### 1) Start the agent server

```bash
cd ayati-main
npm install
npm run build
npm start
```

Before starting, make sure `ayati-main/.env` contains at least:

```env
OPENAI_API_KEY=your_key_here
# optional:
# OPENAI_MODEL=gpt-4o-mini
```

### 2) Start the CLI (new terminal)

```bash
cd ayati-cli
npm install
npm run build
npm start
```

Now type messages in the CLI and chat with Ayati.

## CLI Commands

Inside the CLI input box, these commands are supported:

- `/attach <path>`: queue a local file as an attachment
- `/files`: list queued attachments
- `/clearfiles`: clear queued attachments

## Development Commands

### `ayati-main`

- `npm run dev` - watch, rebuild, restart server
- `npm run build` - compile TypeScript
- `npm start` - run compiled server
- `npm test` - run tests once

### `ayati-cli`

- `npm run dev` - compile and run CLI
- `npm run build` - compile TypeScript
- `npm start` - run compiled CLI
- `npm test` - run tests once

## Provider Configuration

The server currently uses OpenAI by default in:

- `ayati-main/src/config/provider.ts`

To switch providers, point that module to another provider adapter (for example, Anthropic) and set the corresponding API key in `.env`.

## Important Notes

- Do not commit secrets. Keep API keys only in `.env`.
- `dist/`, `data/`, and other generated artifacts should not be committed.
- For architecture direction and design decisions, see:
  - `ayati-main/AGENT.md`
  - `ayati-main/AGENTS.md`
