# Project Docs

This directory is the stable AI-agent context layer for Ayati. Keep it small,
current, and useful for future engineering work.

Top-level docs are intentionally limited to two areas:

- `product/`: product vision, users, features, non-goals, and future-facing product decisions.
- `engineering/`: implementation guidance, architecture, workflows, commands, testing, security, and project history.

Do not add new top-level documentation categories. If a doc is about how the
product behaves for users, put it under `product/`. If it is about how the
system is built, operated, tested, or changed, put it under `engineering/`.

Core mental model:

```text
Ayati = persistent agent daemon + communication clients + memory + tools + events
```

The current agent harness model:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

Read these first before major code changes:

1. `product/overview.md`
2. `engineering/README.md`
3. `engineering/architecture/overview.md`
4. `engineering/architecture/agent-harness.md`
5. `engineering/architecture/context-and-memory.md`
6. `engineering/testing.md`

For user ideas, plans, decisions, and next-action notes that should guide what
an agent works on next, use `../agent-notes/` instead of `project-docs/`.

For external projects that may help with inspiration or comparison, use
`../reference-projects/` instead of `project-docs/`.

Use this directory for stable project context. Do not place secrets, API keys,
generated runtime data, large build outputs, or scratch notes here.
