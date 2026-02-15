# Skill: playwright-cli

## Purpose

Use this skill for browser automation tasks such as opening pages, interacting with elements, taking snapshots, and closing sessions.

## When To Use

1. User asks for browser testing, scraping, screenshots, or form automation.
2. Requested operation is covered by `playwright-cli` subcommands.
3. Command stays within allowed subcommand and guardrail policy.

## Execution Guidelines

1. Prefer simple command flows: `open -> goto -> interact -> snapshot -> close`.
2. Use snapshots to inspect page state before risky actions.
3. Close sessions after task completion.

## Safety Guidelines

1. Never execute arbitrary shell text outside allowed actions.
2. Block dangerous shell operators and denied command patterns.
3. Ask for confirmation for destructive or cleanup operations when policy requires it.

## Development Notes

1. Use `prerequisites.json` to confirm runtime dependencies and fallback availability.
2. Use `tests.json` for smoke and policy validation scenarios during development.
