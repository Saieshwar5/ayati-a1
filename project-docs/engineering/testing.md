# Testing Strategy

Framework:

- Vitest.

General rules:

- Add or update tests in the matching package and domain.
- Prefer deterministic unit tests over networked tests.
- Avoid real provider calls in tests unless explicitly isolated.
- Mock filesystem, provider, plugin, and transport boundaries when practical.
- Test safety checks and validation behavior for tools.

Daemon-specific priorities:

- Test daemon-owned behavior in `ayati-main`, even if the current trigger is from CLI.
- Cover memory continuity when changes affect personalization or session lifecycle.
- Cover git-memory task routing when changes affect pending turns, active-task
  binding, turn-aware activate/create/clarify tools, task assets, context
  refresh, or finalization.
- Cover harness repair behavior by stable repair code. Tests should assert the
  code in repair prompts, failure history or working feedback when model-facing,
  feedback event data when operator-facing, and feedback-ledger triage when the
  repair should appear in summaries.
- For task-run lifecycle changes, include both lower-level git-memory runtime
  tests and app/engine-level tests proving the live flow commits exactly once.
- Cover system-event behavior when changes affect background or proactive workflows.
- Cover transport contracts when adding or changing client channels.
- Cover tool safety when changing computer-access capabilities.

Backend:

- Tests live in `ayati-main/tests`.
- Domain folders mirror runtime areas such as `ivec`, `skills`, `memory`, `documents`, `server`, `providers`, `plugins`, and `core`.

CLI:

- Tests live near CLI code under `ayati-cli/src/app`.
- CLI tests should focus on terminal UI, input, local command parsing, and client message rendering.

Useful commands:

```bash
pnpm --filter ayati-main test
pnpm --filter ayati-cli test
pnpm test
```
