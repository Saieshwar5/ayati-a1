# Agent Implementation Plan

## What We Are Building

Two core upgrades to the IVec agent:

1. **Agent Working Memory** — ephemeral, per-run structured memory that holds the
   plan, all step logs (full tool outputs), errors, and key facts. Lives in RAM
   only during a run. Destroyed when the run ends. Replaces the current scratchpad.

2. **Clean Session Memory** — session memory stops carrying raw tool events and
   agent step events from previous runs into new runs. It carries only what matters
   across sessions: conversation turns, previous session summary.

The agent loop gains a `plan` phase. The `reflect` phase is redefined as genuine
recovery thinking (not bookkeeping). State is upgraded to track phase history and
error categories.

---

## Architecture: Three Memory Layers

```
STATIC MEMORY (never changes per run)
  source: staticContext
  contains: base prompt, soul.md, user profile, tool schemas, skill blocks
  fed to: system prompt — built once, cached

SESSION MEMORY (persists across runs, cross-message)
  source: MemoryManager / SessionManager
  contains: conversation turns (user + agent messages), previous session summary
  fed to: system prompt — before every run
  does NOT contain: tool call logs, agent step events, errors (agentic internals)

AGENT WORKING MEMORY (ephemeral, per run)
  source: AgentWorkingMemory class (new)
  contains: plan, all step logs, full tool outputs, errors, key facts
  fed to: system message — rebuilt before every LLM call (replaces current scratchpad)
  destroyed: when run ends (only final answer goes to session memory)
```

---

## New Files to Create

### 1. `src/memory/agent-working-memory.ts`

The complete working memory store for one agent run.

**Types to define inside this file:**

```typescript
export type SubTaskStatus = "pending" | "in_progress" | "done" | "failed";

export interface SubTask {
  id: number;
  title: string;
  status: SubTaskStatus;
  depends_on?: number[];
}

export interface AgentPlan {
  goal: string;
  sub_tasks: SubTask[];
  current_sub_task: number;
  plan_version: number;
}

export interface WorkingMemoryStep {
  step: number;
  phase: string;
  thinking: string;
  summary: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;      // full output, never truncated
  toolStatus?: "success" | "failed";
  durationMs?: number;
}

export interface WorkingMemoryError {
  step: number;
  toolName?: string;
  errorMessage: string;
  resolved: boolean;
  resolutionSummary?: string;
}

export interface WorkingMemoryFact {
  fact: string;
  sourceStep: number;
  sourceToolName?: string;
}
```

**Class to define:**

```typescript
export class AgentWorkingMemory {
  readonly runId: string;
  plan: AgentPlan | null = null;
  steps: WorkingMemoryStep[] = [];
  errorRegister: WorkingMemoryError[] = [];
  keyFacts: WorkingMemoryFact[] = [];

  constructor(runId: string)

  // Called after each agent_step phase is processed
  addStep(entry: WorkingMemoryStep): void

  // Called when agent uses plan phase
  setPlan(plan: AgentPlan): void

  // Called during verify phase when agent marks a sub-task done or failed
  updateSubTaskStatus(subTaskId: number, status: SubTaskStatus): void

  // Advances current_sub_task to the next pending sub-task whose
  // depends_on sub-tasks are all done. Returns new sub-task id or null.
  advanceToNextSubTask(): number | null

  // Called when a tool returns ok: false
  addError(entry: WorkingMemoryError): void

  // Called when agent's reflect leads to a resolution
  resolveError(step: number, resolutionSummary: string): void

  // Called during verify phase when agent extracts key facts
  addKeyFacts(facts: WorkingMemoryFact[]): void

  // Renders working memory into text for injection into LLM system message.
  // This replaces buildScratchpadBlock().
  renderView(): string
}
```

**renderView() output format** (what the LLM sees at each step):

```
--- Agent Working Memory ---

[PLAN v1]  Goal: Migrate auth module to JWT
  ✓ Sub-task 1: Audit current auth code
  → Sub-task 2: Create JWT utils         ← CURRENT
  ○ Sub-task 3: Replace session calls    (needs: 2)
  ○ Sub-task 4: Update tests             (needs: 3)

[Key Facts]
  • auth.ts uses express-session for token storage  [step 3]
  • Token access pattern: req.session.userId  [step 3]
  • express-session in package.json  [step 4]

[Steps]
  [Step 1] PLAN: Created 4-step migration plan
  [Step 2] ACT: Read auth.ts
    Tool: read_file
    Result: (full tool output, no truncation)
    Duration: 12ms
  [Step 3] VERIFY: Confirmed express-session usage. Extracted 3 facts.

[Errors]
  (none)

[Context Signals]
  ℹ 5 of 14 steps used

--- End Agent Working Memory ---
```

Rules for renderView():
- [PLAN] section: only shown if plan exists. Shows ✓ done, → current, ○ pending.
- [Key Facts] section: only shown if keyFacts.length > 0.
- [Steps] section: always shown once any steps exist. All steps, full output.
- [Errors] section: always shown. Shows "(none)" if no errors yet.
- [Context Signals] section: passed in from AgentLoop state evaluation.

---

## Files to Modify

### 2. `src/ivec/agent-loop-types.ts`

**Change `AgentPhase`** — add `"plan"`:
```typescript
export type AgentPhase = "reason" | "plan" | "act" | "verify" | "reflect" | "feedback" | "end";
```

**Delete `ScratchpadEntry`** — no longer needed. Working memory replaces it.

**Update `RunState`**:

Remove:
- `scratchpad: ScratchpadEntry[]`
- `approachesTried: Set<string>`
- `reflectCycles: number`

Add:
```typescript
phaseHistory: AgentPhase[];
errorsByCategory: Map<string, number>;
hasPlan: boolean;
currentSubTaskId: number | null;
```

Keep unchanged:
- `step`, `toolCallsMade`, `toolNamesUsed`, `failedToolCalls`
- `consecutiveNonActSteps`, `lastActionSignature`, `consecutiveRepeatedActions`

**Update `AgentStepInput`** — add plan fields, remove approaches_tried:
```typescript
export interface AgentStepInput {
  phase: AgentPhase;
  thinking: string;
  summary: string;
  action?: AgentStepAction;
  plan?: {                               // present only when phase === "plan"
    goal: string;
    sub_tasks: Array<{
      id: number;
      title: string;
      depends_on?: number[];
    }>;
  };
  key_facts?: string[];                  // present only when phase === "verify"
  sub_task_outcome?: "done" | "failed";  // present only when phase === "verify"
  feedback_message?: string;
  end_status?: EndStatus;
  end_message?: string;
  // REMOVED: approaches_tried
}
```

---

### 3. `src/ivec/agent-step-tool.ts`

**Add `"plan"` to `VALID_PHASES`.**

**Update `AGENT_STEP_TOOL_SCHEMA`**:

a) Add `"plan"` to the phase enum.

b) Add `plan` property (required when phase is "plan"):
```typescript
plan: {
  type: "object",
  description: "Required when phase is 'plan'. Structured plan for this task.",
  properties: {
    goal: { type: "string" },
    sub_tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id:         { type: "number" },
          title:      { type: "string" },
          depends_on: { type: "array", items: { type: "number" } },
        },
        required: ["id", "title"],
      },
    },
  },
  required: ["goal", "sub_tasks"],
}
```

c) Add `key_facts` property (optional, use during verify phase):
```typescript
key_facts: {
  type: "array",
  items: { type: "string" },
  description: "Optional. Facts learned from the last action. Only use in verify phase.",
}
```

d) Add `sub_task_outcome` property (optional, use during verify phase):
```typescript
sub_task_outcome: {
  type: "string",
  enum: ["done", "failed"],
  description: "Optional. Mark the current plan sub-task as done or failed.",
}
```

e) **Remove `approaches_tried`** from the schema entirely.

**Update `parseAgentStep()`**:
- Parse `plan` field when phase === "plan"
- Parse `key_facts` array when present
- Parse `sub_task_outcome` when present
- Remove parsing of `approaches_tried`

**Delete `buildScratchpadBlock()`** and its constants:
- `SCRATCHPAD_KEEP_FIRST`
- `SCRATCHPAD_KEEP_LAST`
- `SCRATCHPAD_TRUNCATE_THRESHOLD`

These are replaced by `AgentWorkingMemory.renderView()`.

---

### 4. `src/ivec/agent-loop.ts`

**Constructor** — add `workingMemory` parameter after `sessionMemory`:
```typescript
constructor(
  provider: LlmProvider,
  toolExecutor: ToolExecutor | undefined,
  sessionMemory: SessionMemory,
  workingMemory: AgentWorkingMemory,
  onReply?: (clientId: string, data: unknown) => void,
  config?: AgentLoopConfigInput,
  toolDefinitions?: ToolDefinition[],
)
```

**`run()` method** — update initial RunState:
```typescript
const state: RunState = {
  step: 0,
  phaseHistory: [],
  toolCallsMade: 0,
  toolNamesUsed: new Set(),
  failedToolCalls: 0,
  consecutiveNonActSteps: 0,
  consecutiveRepeatedActions: 0,
  errorsByCategory: new Map(),
  hasPlan: false,
  currentSubTaskId: null,
};
```

**`rebuildSystemMessage()`** — replace scratchpad injection with working memory view:
```typescript
private rebuildSystemMessage(
  messages: LlmMessage[],
  workingMemory: AgentWorkingMemory,
  signals: string,
): void {
  if (workingMemory.steps.length === 0 && workingMemory.plan === null) return;

  const view = workingMemory.renderView(signals);
  const firstMsg = messages[0];
  if (firstMsg && firstMsg.role === "system") {
    const base = firstMsg.content.split("\n--- Agent Working Memory ---")[0]!.trimEnd();
    firstMsg.content = `${base}\n\n${view}`;
  }
}
```

**`routePhase()`** — add `plan` case, update all other cases:

`plan` case:
```typescript
case "plan": {
  if (!parsed.plan) {
    messages.push({ role: "assistant_tool_calls", calls: [call] });
    messages.push({ role: "tool", toolCallId: call.id, name: AGENT_STEP_TOOL_NAME,
      content: JSON.stringify({ error: "plan phase requires a plan object" }) });
    state.consecutiveNonActSteps++;
    state.phaseHistory.push("plan");
    return null;
  }
  const agentPlan: AgentPlan = {
    goal: parsed.plan.goal,
    sub_tasks: parsed.plan.sub_tasks.map(st => ({ ...st, status: "pending" as const })),
    current_sub_task: parsed.plan.sub_tasks[0]?.id ?? 1,
    plan_version: (workingMemory.plan?.plan_version ?? 0) + 1,
  };
  workingMemory.setPlan(agentPlan);
  workingMemory.addStep({ step: state.step, phase: "plan",
    thinking: parsed.thinking, summary: parsed.summary });
  state.hasPlan = true;
  state.currentSubTaskId = agentPlan.current_sub_task;
  messages.push({ role: "assistant_tool_calls", calls: [call] });
  messages.push({ role: "tool", toolCallId: call.id, name: AGENT_STEP_TOOL_NAME,
    content: JSON.stringify({ acknowledged: true,
      plan_version: agentPlan.plan_version,
      sub_tasks: agentPlan.sub_tasks.length }) });
  state.consecutiveNonActSteps++;
  state.phaseHistory.push("plan");
  return null;
}
```

`reason` case — add step to working memory, add to phaseHistory:
```typescript
case "reason": {
  workingMemory.addStep({ step: state.step, phase: "reason",
    thinking: parsed.thinking, summary: parsed.summary });
  messages.push({ role: "assistant_tool_calls", calls: [call] });
  messages.push({ role: "tool", toolCallId: call.id, name: AGENT_STEP_TOOL_NAME,
    content: JSON.stringify({ acknowledged: true, step: state.step }) });
  state.consecutiveNonActSteps++;
  state.phaseHistory.push("reason");
  return null;
}
```

`act` case — store full tool output, record errors:
```typescript
case "act": {
  const action = parsed.action!;
  const toolResult = await this.executeAction(clientId, state, action.tool_name,
    action.tool_input, runHandle);
  const resultStr = formatToolResult(action.tool_name, toolResult);

  workingMemory.addStep({
    step: state.step,
    phase: "act",
    thinking: parsed.thinking,
    summary: parsed.summary,
    toolName: action.tool_name,
    toolInput: action.tool_input,
    toolOutput: resultStr,
    toolStatus: toolResult.ok ? "success" : "failed",
  });

  if (!toolResult.ok) {
    workingMemory.addError({
      step: state.step,
      toolName: action.tool_name,
      errorMessage: toolResult.error ?? "unknown error",
      resolved: false,
    });
    const category = this.categorizeToolError(toolResult.error ?? "");
    state.errorsByCategory.set(category,
      (state.errorsByCategory.get(category) ?? 0) + 1);
  }

  messages.push({ role: "assistant_tool_calls", calls: [call] });
  messages.push({ role: "tool", toolCallId: call.id, name: AGENT_STEP_TOOL_NAME,
    content: resultStr });
  state.toolCallsMade++;
  state.consecutiveNonActSteps = 0;
  state.phaseHistory.push("act");
  return null;
}
```

`verify` case — handle key_facts and sub_task_outcome:
```typescript
case "verify": {
  if (parsed.key_facts && parsed.key_facts.length > 0) {
    const lastActStep = [...workingMemory.steps].reverse().find(s => s.phase === "act");
    workingMemory.addKeyFacts(parsed.key_facts.map(fact => ({
      fact,
      sourceStep: state.step,
      sourceToolName: lastActStep?.toolName,
    })));
  }
  if (parsed.sub_task_outcome && state.currentSubTaskId !== null) {
    workingMemory.updateSubTaskStatus(state.currentSubTaskId, parsed.sub_task_outcome);
    if (parsed.sub_task_outcome === "done") {
      const nextId = workingMemory.advanceToNextSubTask();
      state.currentSubTaskId = nextId;
    }
  }
  workingMemory.addStep({ step: state.step, phase: "verify",
    thinking: parsed.thinking, summary: parsed.summary });
  messages.push({ role: "assistant_tool_calls", calls: [call] });
  messages.push({ role: "tool", toolCallId: call.id, name: AGENT_STEP_TOOL_NAME,
    content: JSON.stringify({ acknowledged: true,
      facts_recorded: parsed.key_facts?.length ?? 0,
      sub_task_outcome: parsed.sub_task_outcome ?? null }) });
  state.consecutiveNonActSteps++;
  state.phaseHistory.push("verify");
  return null;
}
```

`reflect` case — recovery thinking, mark last error as resolved:
```typescript
case "reflect": {
  const lastUnresolved = [...workingMemory.errorRegister]
    .reverse().find(e => !e.resolved);
  if (lastUnresolved) {
    workingMemory.resolveError(lastUnresolved.step, parsed.summary);
  }
  workingMemory.addStep({ step: state.step, phase: "reflect",
    thinking: parsed.thinking, summary: parsed.summary });
  messages.push({ role: "assistant_tool_calls", calls: [call] });
  messages.push({ role: "tool", toolCallId: call.id, name: AGENT_STEP_TOOL_NAME,
    content: JSON.stringify({ acknowledged: true }) });
  state.consecutiveNonActSteps++;
  state.phaseHistory.push("reflect");
  return null;
}
```

`end` case — record final step:
```typescript
case "end": {
  workingMemory.addStep({ step: state.step, phase: "end",
    thinking: parsed.thinking, summary: parsed.end_message ?? "" });
  this.recordAgentStepEvent(clientId, state, parsed, runHandle);
  return { type: "reply", content: parsed.end_message!,
    endStatus: parsed.end_status, totalSteps: state.step,
    toolCallsMade: state.toolCallsMade };
}
```

**Add `generateStateSignals()` private method:**
```typescript
private generateStateSignals(state: RunState): string {
  const signals: string[] = [];
  const budget = this.effectiveLimit(state);
  signals.push(`ℹ ${state.step} of ${budget} steps used`);

  if (state.failedToolCalls >= 2 && state.consecutiveRepeatedActions >= 2) {
    signals.push("⚠ Same action failed twice. Reflect before acting again.");
  }
  if (state.consecutiveNonActSteps >= 3) {
    signals.push("⚠ 3 steps without action. Act, reflect, or ask.");
  }
  const permErrors = state.errorsByCategory.get("permission") ?? 0;
  if (permErrors >= 2) {
    signals.push("⚠ Multiple permission errors. Try a different approach.");
  }

  return signals.join("\n");
}
```

**Add `categorizeToolError()` private method:**
```typescript
private categorizeToolError(errorMessage: string): string {
  const msg = errorMessage.toLowerCase();
  if (msg.includes("not found") || msg.includes("no such")) return "not_found";
  if (msg.includes("permission") || msg.includes("denied")) return "permission";
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
  if (msg.includes("invalid") || msg.includes("validation")) return "invalid_input";
  return "runtime";
}
```

**Update the main while loop** to pass signals to rebuildSystemMessage:
```typescript
const signals = this.generateStateSignals(state);
this.rebuildSystemMessage(messages, workingMemory, signals);
```

**Update `handleDirectToolCalls()`** — store full output in working memory:
```typescript
workingMemory.addStep({
  step: state.step,
  phase: "act",
  thinking: `Direct tool call: ${call.name}`,
  summary: `Execute ${call.name}`,
  toolName: call.name,
  toolInput: call.input,
  toolOutput: resultStr,
  toolStatus: toolResult.ok ? "success" : "failed",
});
```

**Remove from `recordAgentStepEvent()`**: the `approachesTried` field (now gone from state).

---

### 5. `src/memory/types.ts`

**Simplify `PromptMemoryContext`**:
```typescript
export interface PromptMemoryContext {
  conversationTurns: ConversationTurn[];
  previousSessionSummary: string;
  activeTopicLabel?: string;
  // REMOVED: toolEvents
  // REMOVED: agentStepEvents
  // REMOVED: recalledEvidence
}
```

Tool events and agent step events are still WRITTEN to JSONL (audit trail preserved).
They are simply no longer read back into the system prompt.

---

### 6. `src/memory/session-manager.ts`

**Update `getPromptMemoryContext()`** — return only conversation and summary:
```typescript
getPromptMemoryContext(): PromptMemoryContext {
  if (this.promptWindowEvents.length === 0) {
    return { conversationTurns: [], previousSessionSummary: "" };
  }

  const promptSession = new InMemorySession(
    this.currentSession?.id ?? "prompt-window",
    this.activeClientId,
    this.nowIso(),
    this.currentSession?.sessionPath ?? "sessions/ephemeral/prompt-window.md",
  );
  for (const event of this.promptWindowEvents) {
    promptSession.addEntry(event);
  }

  return {
    conversationTurns: promptSession.getConversationTurns(PROMPT_EVENT_WINDOW),
    previousSessionSummary: "",
  };
}
```

`pushPromptToolWindowEvent()` and `pushPromptAgentStepWindowEvent()` can be
kept (they maintain the audit trail in `currentSession.timeline`).
They are just no longer merged into the prompt context.

---

### 7. `src/prompt/sections/memory.ts`

**Simplify `renderMemorySection()`** — only renders previous session summary:
```typescript
export function renderMemorySection(summary: string): string {
  const cleanSummary = summary.trim();
  if (cleanSummary.length === 0) return "";
  return joinPromptBlocks(["# Memory", "## Previous Session Summary", cleanSummary]);
}
```

Delete `renderToolEvent()` and `renderAgentStepEvent()` — no longer needed.

---

### 8. `src/prompt/builder.ts`

**Update `renderMemorySection` call** — only pass summary:
```typescript
const memory = renderMemorySection(input.previousSessionSummary ?? "");
```

Remove `toolEvents` and `agentStepEvents` from the call.

---

### 9. `src/prompt/types.ts`

Remove `toolEvents`, `agentStepEvents`, `recalledEvidence` from `PromptBuildInput`
if they are only used by the memory section renderer.

---

### 10. `src/context/load-system-prompt-input.ts`

Update `assemblePromptInput()` — stop mapping tool events and agent step events
from `PromptMemoryContext` into `PromptBuildInput`.

---

### 11. `src/ivec/index.ts`

**Update `processChat()`** — create `AgentWorkingMemory` per run, pass to loop:
```typescript
const workingMemory = new AgentWorkingMemory(runHandle.runId);

const loop = new AgentLoop(
  this.provider,
  this.toolExecutor,
  this.sessionMemory,
  workingMemory,        // new parameter
  this.onReply,
  this.loopConfig,
  toolDefs,
);
```

`workingMemory` is discarded after `loop.run()` returns — GC handles cleanup.
Only the final answer is sent to session memory via `sendAssistantReply()`.

---

## The New Agent Cycle

### Phase guide (what the system prompt teaches the agent)

```
PLAN    — Create a structured plan with sub-tasks when the task has multiple
          dependent goals or is clearly too large for 3-4 steps.
          Do this early. Can call plan again to re-plan if the situation changes.
          Not required for simple or short tasks.

REASON  — Think through uncertainty before acting.
          Not required before every act — only when the path forward is unclear.

ACT     — Execute a tool when you know exactly what to call.
          Always follow an act with verify.

VERIFY  — After every act that matters, check if it worked.
          Extract key facts from the result using key_facts field.
          Mark the current sub-task done or failed using sub_task_outcome field.

REFLECT — When verify shows failure: deeply rethink WHY it failed.
          Do not repeat the same action. Decide a genuinely different approach.
          Then act again with the new strategy.

FEEDBACK — Ask the user only when needed information cannot be found with tools.
           Keep this rare.

END     — When all goals are achieved, or when further progress is impossible.
          Set end_status: "solved", "partial", or "stuck".
          Write a clear end_message.
```

### How the agent advances sub-tasks (automatic — no external coordination needed)

```
Agent calls verify with sub_task_outcome: "done"
  → loop calls workingMemory.updateSubTaskStatus(currentSubTaskId, "done")
  → loop calls workingMemory.advanceToNextSubTask()
       → finds next pending sub-task whose depends_on are all "done"
       → returns that sub-task's id (or null if all done)
  → state.currentSubTaskId = returned id
  → workingMemory.plan.current_sub_task updated

Next step: agent reads working memory view
  → sees ✓ on completed sub-task, → on new current sub-task
  → naturally works on the new current sub-task
```

The agent does not need to be told "move to next sub-task." It reads the plan
in the working memory and sees what needs to be done next.

---

## Implementation Order

```
1.  src/memory/agent-working-memory.ts          ← create new file
2.  src/ivec/agent-loop-types.ts                ← update types, remove ScratchpadEntry
3.  src/ivec/agent-step-tool.ts                 ← add plan phase, remove approaches_tried
4.  src/memory/types.ts                         ← simplify PromptMemoryContext
5.  src/prompt/types.ts                         ← update PromptBuildInput
6.  src/prompt/sections/memory.ts               ← simplify renderMemorySection
7.  src/prompt/builder.ts                       ← update buildSystemPrompt call
8.  src/context/load-system-prompt-input.ts     ← update assemblePromptInput
9.  src/memory/session-manager.ts               ← clean getPromptMemoryContext
10. src/ivec/agent-loop.ts                      ← integrate working memory (largest)
11. src/ivec/index.ts                           ← create working memory, pass to loop
12. tests/                                      ← update and add tests
```

---

## Test Changes

### Tests to update:

`tests/ivec/agent-loop.test.ts`
- Add mock `AgentWorkingMemory` to all `AgentLoop` constructor calls
- Update `reflect` tests: no `approaches_tried` assertions
- Add tests for `plan` phase routing
- Add tests for `verify` with `key_facts` and `sub_task_outcome`
- Replace scratchpad assertions with working memory step assertions

`tests/memory/session-manager-callback.test.ts`
- `getPromptMemoryContext()` no longer returns `toolEvents` or `agentStepEvents`
- Update any assertions checking those fields

`tests/prompt/builder.test.ts`
- Remove `toolEvents` and `agentStepEvents` from `buildSystemPrompt` inputs
- Update rendered memory section assertions

`tests/context/system-prompt-input.test.ts`
- Update `assemblePromptInput` assertions — no tool/agent step event mapping

### New tests to create:

`tests/memory/agent-working-memory.test.ts`
- `setPlan()` → `renderView()` shows [PLAN] section
- `updateSubTaskStatus("done")` + `advanceToNextSubTask()` → plan advances
- `advanceToNextSubTask()` respects `depends_on` (does not advance if dep not done)
- `addKeyFacts()` → shows in [Key Facts] section
- `addError()` → shows in [Errors] section
- `resolveError()` → error marked resolved in view
- `renderView()` with all sections populated
- `renderView()` with empty working memory (no sections shown except steps empty)
- `addStep()` with full tool output → output visible in rendered view

---

## What Does NOT Change

- `SessionPersistence` — still writes all events to JSONL. Audit trail preserved.
- `InMemorySession` — still tracks all event types internally.
- Session rotation logic in `MemoryManager` — unchanged.
- `WsServer` — unchanged.
- `PluginRegistry` — unchanged.
- All tool implementations in `src/skills/` — unchanged.
- `AgentLoopConfig` and `DEFAULT_LOOP_CONFIG` — unchanged.
- `IVecEngine.start()` / `stop()` — unchanged.
- The `create_session` tool — unchanged.
- `AgentLoopResult` type — unchanged.
