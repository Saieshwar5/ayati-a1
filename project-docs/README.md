# Project Docs

This directory is the AI-agent context layer for Ayati. It should help future agents understand the product vision, daemon-first architecture, code conventions, workflows, and external references before making changes.

Core mental model:

```text
Ayati = persistent agent daemon + communication clients + memory + tools + events
```

`ayati-main` is the long-running agent daemon. It owns intelligence, memory, tools, providers, event processing, and runtime state. `ayati-cli` is currently the main user interface, but it is only one client surface. Future clients can include web, mobile, Telegram, email, voice, or other channels that communicate with the daemon.

Top-level directories:

- `product/`: product vision, users, features, and non-goals.
- `architecture/`: daemon architecture, data flow, modules, clients, APIs, runtime data, integrations, and trust boundaries.
- `engineering/`: coding conventions, commands, testing, workflows, troubleshooting, and AI-agent operating rules.
- `history/`: decisions, progress records, and external references.

Before editing code, read these first:

1. `product/overview.md`
2. `architecture/overview.md`
3. `engineering/conventions.md`
4. `engineering/ai-agent-instructions.md`
5. `engineering/testing.md`

Use this directory for stable project context. Do not place secrets, API keys, generated runtime data, or large build outputs here.

`history/progress/` is reserved for commit-by-commit history and project state records.
