# AGENT.md

This file defines Ayati's architecture blueprint and implementation direction.

## Vision

Ayati is a scalable agent system designed like a modular car:

- Engine (`LlmProvider`): the model backend (OpenAI, Anthropic, future models).
- Chassis (`AgentEngine`): stable coordinator that routes input/output and orchestrates behavior.
- Accessories (`plugins`): optional lifecycle modules that can be attached/removed.
- Fuel (`system prompt context`): layered instructions and memory-fed context that powers model behavior.

Goal: swap engines, add/remove capabilities, and evolve behavior without rewriting the chassis.

## Core Principle

Ayati should be:

- Provider-agnostic: model engine can change by config.
- Capability-modular: skills/tools can be added or removed independently.
- Prompt-layered: final system prompt is deterministic and composable.
- Safety-first: tool execution is constrained, auditable, and configurable.

## Current Runtime (as implemented)

- Entrypoint: `src/index.ts`
- Bootstrap: `src/app/main.ts`
- Engine coordinator: `src/engine/index.ts`
- Provider loading: `src/config/provider.ts`, `src/core/runtime/provider-loader.ts`
- Plugin lifecycle: `src/config/plugins.ts`, `src/core/runtime/plugin-registry.ts`
- Prompt input loading: `src/context/load-system-prompt-input.ts`
- Prompt assembly: `src/prompt/builder.ts`

Startup flow:

1. Load provider.
2. Load prompt input layers.
3. Build final `systemPrompt`.
4. Start engine, server, plugins.

## Prompt Blueprint

The base blueprint lives in `context/system_prompt.md`.

This file must explain:

- How Ayati works.
- Which capabilities are available.
- How to interpret layered context sections.
- Priority rules when layers conflict.
- How to behave with uncertainty and constraints.

Final prompt is assembled in fixed order:

1. Base System Prompt (`system_prompt.md`)
2. Soul (`context/soul.json`)
3. User Profile (`context/user_profile.json`)
4. Previous Conversation (future memory provider)
5. Skills (enabled skill blocks)

## Skills vs Tools

They are different:

- Tool: a callable executable function (example: run shell command).
- Skill: behavioral package that can include:
  - Prompt instructions (when/how to behave)
  - One or more tools
  - Validation/safety policies
  - Optional selection metadata

Simple rule:

- Tool = action primitive.
- Skill = capability module that may use tools.

## Planned Scalable Skill Architecture

### Scope

- Build scalable skill system.
- Implement first built-in skill: `shell`.
- Memory system remains out of scope for now (only interfaces/placeholders).

### Phase 1: Contracts and Registry

Add strong contracts:

- `SkillDefinition`
  - `id`, `version`, `description`
  - `promptBlock` (text injected into `# Skills` section)
  - `tools: ToolDefinition[]`
- `ToolDefinition`
  - `name`, `description`, `inputSchema`
  - `execute(input, context): Promise<ToolResult>`
- `ToolResult`
  - `ok`, `output`, `error`, `meta`

Add registries:

- `SkillRegistry`: register/unregister/get skills.
- `ToolRegistry`: flattened lookup of tools exposed by enabled skills.

### Phase 2: Skill Loading and Access Control

- All built-in skills are always loaded — no whitelist filtering.
- `context/tool-access.json` is the single source of truth for enabling/disabling any tool.
- Per-tool `enabled` flag in `tool-access.json` is enforced by `canUseTool()` in `access-policy.ts`.

### Phase 3: Prompt Integration

- Keep current prompt builder structure.
- `# Skills` section should include `promptBlock` for each enabled skill in deterministic order.
- Include only enabled skills.

### Phase 4: Tool Invocation Path (Agent Loop Extension)

Extend engine message handling to support tool execution loop:

1. User message arrives.
2. LLM responds either with normal text or tool call request.
3. If tool call:
   - Validate against registered tool schema.
   - Execute tool with runtime policies.
   - Return tool output to model for final response.
4. Send final assistant response to client.

Model-agnostic adapter layer is required because providers differ in tool-call APIs.

### Phase 5: First Skill - `shell`

Implement `shell` skill with one tool: `shell`.

#### `shell` behavior

Input:

- `cmd: string`
- `cwd?: string`
- `timeoutMs?: number` (bounded)
- `maxOutputChars?: number` (bounded)

Execution constraints (mandatory):

- Allowed command policy:
  - Default mode can be full access for internal/local usage.
  - Must remain runtime configurable (`off`, `allowlist`, `full`).
- Working directory policy:
  - Keep configurable (`allow any cwd` vs workspace-restricted mode).
- Timeout policy:
  - Hard timeout with process kill.
- Output policy:
  - Truncate output with clear truncation marker.
- Audit policy:
  - Log command, exit code, duration, truncation flag.

Failure behavior:

- Return structured error (do not crash engine).
- Model gets concise error summary and can recover.

### Phase 6: Configuration

Add env/config knobs:

- `SHELL_TOOL_ENABLED=true|false`
- `SHELL_TOOL_MODE=allowlist|off`
- `SHELL_TOOL_TIMEOUT_MS`
- `SHELL_TOOL_MAX_OUTPUT_CHARS`
- `SHELL_TOOL_ALLOWED_PREFIXES` (comma-separated)

### Phase 7: Tests and Acceptance Criteria

Must-have tests:

- Registry behavior (enable/disable skills).
- Per-tool enabled/disabled via `tool-access.json`.
- Prompt builder includes selected skill blocks only.
- Shell tool:
  - executes allowed command
  - blocks disallowed command
  - enforces timeout
  - truncates long output
  - enforces cwd boundaries
- Engine tool loop:
  - successful tool call round-trip
  - tool failure round-trip
  - unknown tool handling

Acceptance criteria:

- Engine runs with no skills enabled.
- Enabling `shell` adds `# Skills` guidance and executable tool path.
- Removing `shell` requires only whitelist/config change (no code edits).
- Provider swap still works unchanged.

## Non-Goals (current milestone)

- Persistent cross-session memory.
- Autonomous multi-step planning.
- Unrestricted shell or host-level command execution.

## Coding and Safety Rules

- Keep TypeScript strict and deterministic behavior.
- Keep runtime provider-agnostic.
- Never execute shell without policy checks.
- Prefer explicit config over hidden magic.
- Keep modules small and independently testable.
