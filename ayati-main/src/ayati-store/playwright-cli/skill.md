# Skill: playwright-cli

## Purpose

Use this external browser-use skill to automate browser interactions through playwright-cli.

## When To Use

1. User asks for browser automation, testing, snapshots, or form interaction.
2. The request can be satisfied using allowed `playwright-cli` actions.
3. Guardrails permit the requested operation.

## Execution Guidelines

1. Use simple flows: `open -> goto -> interact -> snapshot -> close`.
2. Prefer explicit actions from `allowedActions` in `tools.json`.
3. Use named sessions only when needed for multi-step workflows.

## Safety Guidelines

1. Never run arbitrary shell text beyond declared tool actions.
2. Respect blocked operators and denied command prefixes.
3. Follow confirmation requirements for destructive actions.

## Development Notes

1. `prerequisites.json` declares runtime dependencies and fallback checks.
2. `tests.json` declares smoke and policy scenarios for post-build validation.
