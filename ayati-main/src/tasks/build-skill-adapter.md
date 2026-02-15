# Task: Build Skill Adapter

Generate a TypeScript adapter in `src/skills/external/<skill-id>/index.ts` from an ayati-store JSON skill package.

## Step 1 — Read the Skill Package

Read these files from `src/ayati-store/<skill-id>/`:

| File | Purpose |
|------|---------|
| `skill.json` | Metadata: id, version, title, description, tags |
| `tools.json` | Tool definitions: name, inputSchema, executor config |
| `credentials.json` | Credential bindings (env var injection) |
| `guardrails.json` | Safety policies and tool access plan |
| `skill.md` | Prompt block content shown to the agent |

## Step 2 — Generate the TypeScript Adapter

Create `src/skills/external/<skill-id>/index.ts` that default-exports a `SkillDefinition`.

### 2.1 Imports

```typescript
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";

const execAsync = promisify(exec);
```

### 2.2 Map Each Tool from `tools.json`

For each tool entry, create a `ToolDefinition` with a real `execute()` function.

**Executor type: `shell_command`**

The `execute()` function must:
1. Validate `action` against the `allowedActions` list from the executor config
2. Build the command string from `executor.command` (or fall back through `commandFallbacks`)
3. Process `argsTemplate` entries:
   - `{{action}}` — replace with the action input
   - `{{...args}}` — spread the args array
   - `{{#if session}}...{{/if}}` — conditional block, include inner content only if input field is present
4. Run via `execAsync` with `timeoutMs` and cap output to `maxOutputChars`
5. Return a `ToolResult` with `ok`, `output`, and optional `error`

**Copy directly from tools.json:**
- `inputSchema` — use as-is for the tool definition
- `selectionHints` — use as-is for the tool definition

### 2.3 Prompt Block

Include the full content of `skill.md` as the `promptBlock` string in the `SkillDefinition`.

### 2.4 Credential Injection

Read `credentials.json` bindings. For each binding with `injectAs: "env"`:
- Set `process.env[target]` before command execution if the credential value is available
- Skip gracefully if credential is not set and `required: false`

## Step 3 — Registration

After generating the adapter:
1. Import the generated skill in `src/skills/provider.ts`
2. Add it to the skills array alongside existing builtin skills

## Step 4 — Validation Checklist

Before finalizing, verify:
- [ ] Tool names follow `<skillId>.<toolName>` namespace convention
- [ ] `inputSchema` is valid JSON Schema (copied from tools.json)
- [ ] Executor config has at least one command or fallback
- [ ] `allowedActions` is non-empty for shell_command executors
- [ ] Generated file stays under 300 lines
- [ ] All imports use `.js` extensions (ESM requirement)
- [ ] TypeScript compiles without errors

## Reference Files

| File | What to reference |
|------|-------------------|
| `src/skills/builtins/shell/index.ts` | Shell execution patterns (exec, spawn, timeout, output capping) |
| `src/skills/types.ts` | `ToolDefinition` and `SkillDefinition` interfaces |
| `src/asl/skill-format-reference/templates/` | JSON schema templates for skill packages |
| `src/ayati-store/playwright-cli/` | Real example skill package to test against |
