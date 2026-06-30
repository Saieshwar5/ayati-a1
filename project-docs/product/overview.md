# Product Overview

Ayati is an autonomous general AI agent project. Its purpose is to use intelligence to help people in real life: computer work, files, communication, reminders, planning, research, automation, and other useful tasks.

The core product is a persistent agent daemon. `ayati-main` is expected to run in the background for long periods, eventually 24/7. Users communicate with this daemon through clients. Today the active client is the CLI, but the architecture should support many communication surfaces later.

The project goal is to keep the agent daemon stable while allowing models, skills, tools, plugins, clients, memory behavior, and communication channels to evolve independently.

The current agent harness is designed around a simple loop:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

The product intent is that Ayati should feel continuous and alive without
requiring the user to manage sessions manually. Daily git context is default
and keeps recent work vivid through task branches, pending-turn ownership,
task files, assets, evidence, and run commits, while personal facts and
preferences remain in personal memory.

Current packages:

- `ayati-main`: long-running agent daemon, backend runtime, WebSocket server, HTTP upload/artifact API, memory, tools, plugins, providers, and event processing.
- `ayati-cli`: Ink/React terminal client that connects to the daemon over WebSocket.

Primary value:

- A local-first autonomous agent daemon with composable capabilities.
- A stable backend loop that can use different model providers.
- Default daily git context for task/work continuity, including conversation,
  active task refs, work branches, task state, assets, actions, evidence, and
  commit metadata.
- Turn-aware task routing: obvious same-task follow-ups are bound
  automatically, while the agent can search/read tasks and route ambiguous
  turns through activate, create, or clarify tools.
- Personal and episodic memory for personalization and recall.
- Structured context packs that keep recent conversation, selected git
  task context, task assets, hot evidence, and personal memory available to the
  decision model.
- Broad computer-access tools for local workspace work, files, documents, datasets, Python, SQLite, reminders, and recall.
- Multi-channel user communication, with CLI current and other clients intended.
- Proactive and event-driven assistance through Pulse, plugins, and system events.
- Pulse reminders and scheduled system events.
