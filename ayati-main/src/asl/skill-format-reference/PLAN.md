# ASL External Skill Format Plan (JSON First)

## Goal

Create a deterministic, machine-readable skill package format so Ayati can:

1. Load external skill metadata and prompt blocks.
2. Build executable tools from declared tool definitions.
3. Apply skill-specific guardrails safely.
4. Patch `context/tool-access.json` idempotently.
5. Describe prerequisites and tests in a standard format.

This folder is a reference package for building new skills, not runtime code.

## Required Files Per Skill

1. `skill.md` - human-readable description, usage notes, and examples.
2. `skill.json` - machine-readable metadata for the loader.
3. `tools.json` - tool definitions (function shape, schema, executor adapter config).
4. `guardrails.json` - safety policy and tool-access update plan.
5. `credentials.json` - required secrets/tokens and how tools consume them.
6. `prerequisites.json` - declarative runtime requirements and setup checks.
7. `tests.json` - declarative manual/command test scenarios.

## Minimum Agent Requirements

1. JSON schema validation for all files before loading.
2. Tool name namespacing (`<skillId>.<toolName>`) to avoid collisions.
3. Adapter-based execution (`shell_command`, `http_request`, etc.).
4. Idempotent `tool-access` patch engine using `guardrails.json.toolAccessPlan`.
5. Restrictive guardrail merge policy (external skill cannot weaken base policy).
6. Credential resolution and injection based on `credentials.json.bindings`.
7. Parse and surface prerequisites from `prerequisites.json` (development mode: metadata only).
8. Parse and surface scenarios from `tests.json` (development mode: metadata only).
9. Failure isolation (one broken external skill does not crash all skills).
10. Skill load report with warnings/errors for each file.

## Recommended Rollout

1. Phase 1 - Startup-only load:
   - Parse and validate skills at boot.
   - Build tool definitions.
   - Apply `guardrails.json.toolAccessPlan`.
   - Load `prerequisites.json` and `tests.json` as declarative metadata only.

2. Phase 2 - Runtime refresh:
   - File watchers for skill directories.
   - Atomic swap of validated skill snapshot.
   - Reject bad updates and keep last known good snapshot.

3. Phase 3 - Trust and publishing:
   - Signed skill package metadata.
   - Source trust policy (`local`, `registry`, `git`).
   - Optional review gate for high-risk skills.

## Non-Negotiable Validation Rules

1. Reject unknown `schemaVersion`.
2. Reject duplicate skill IDs.
3. Reject duplicate tool names globally.
4. Reject tools without valid JSON schema.
5. Reject `toolAccessPlan` operations that try to remove core protections.
6. Reject credential specs with missing key fields.
7. Reject credential bindings that reference unknown tools.
8. Reject prerequisite entries with missing check/fix fields.
9. Reject test scenarios without stable `id` and `expected` assertions.

## What To Copy For A New Skill

1. Copy `templates/` into a new skill folder.
2. Rename placeholder values.
3. Fill real tool schemas, guardrails/access plan, credential requirements, prerequisites, and tests.
4. Validate before enabling.
