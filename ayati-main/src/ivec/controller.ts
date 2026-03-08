import type { LlmProvider } from "../core/contracts/provider.js";
import type { ControllerPrompts } from "../context/types.js";
import type { ToolDefinition } from "../skills/types.js";
import type {
  LoopState,
  ControllerOutput,
  UnderstandDirective,
  ReEvalDirective,
  CompletionDirective,
  StepDirective,
  ContextSearchDirective,
  SessionRotationDirective,
  FailedApproach,
  GoalContract,
} from "./types.js";
import { buildToolCatalog } from "./tool-catalog.js";

const DEFAULT_UNDERSTAND_INSTRUCTIONS = `- First, classify the request:
  - If it is simple conversation or a direct question that needs no tools or multi-step work, return done: true with a natural user-facing reply.
  - Otherwise, treat it as a task that may require planning and execution.
- Before creating a plan, run a readiness check:
  - Is the objective clear?
  - Are required inputs or targets sufficiently specified?
  - Are constraints and boundaries clear enough to avoid unsafe or low-confidence assumptions?
  - Is success verifiable with concrete evidence?
- If the request is under-specified or ambiguous:
  - Do NOT start execution planning.
  - Return done: true and ask exactly ONE targeted clarification question that unlocks the next decision.
  - Ask the highest-information-gain question first (the single question whose answer most reduces uncertainty).
  - Keep the question short, specific, and easy to answer.
  - Do not ask multiple questions in one turn unless safety or permission constraints require it.
  - Do not ask for information that is already available in conversation or memory context.
- If the request is sufficiently clear, return done: false with:
  - goal.objective: specific, unambiguous intent
  - goal.done_when: concrete completion conditions
  - goal.required_evidence: objective evidence needed to mark task complete
  - goal.ask_user_when: explicit triggers that require pausing for user input
  - goal.stop_when_no_progress: explicit conditions for stopping after repeated non-progress
  - approach: a practical initial direction using available tools
  - constraints: relevant execution boundaries or preferences
- Quality bar for done: false:
  - objective must be actionable and specific (not a restatement of the raw message).
  - done_when and required_evidence should be concrete and non-empty for non-trivial tasks.
  - ask_user_when should include real ambiguity or permission triggers, not generic filler.
  - If confidence is not high enough to act reliably, prefer one clarifying question first.`;

const DEFAULT_REEVAL_INSTRUCTIONS = `- The current approach has not been working. You MUST provide a different approach.
- If the task is no longer achievable, respond with done: true and status: "failed".
- Otherwise provide an updated approach and constraints only.
- Do NOT change the goal contract during re-evaluation.
- Your new approach MUST differ substantially from any failed approaches listed above.`;

const DEFAULT_DIRECT_INSTRUCTIONS = `- Pick exactly 1 next action. Reduce uncertainty first.
- Choose execution_mode for next step:
  - dependent: tools depend on prior output; executor runs max 1 tool call per turn.
  - independent: tools are parallel-safe; executor runs max 2 tool calls per turn.
- If taskStatus is "done", "blocked", or "needs_user_input", do NOT plan another step. Return done: true with the final response to the user.
- If taskStatus is "likely_done", prefer returning done: true unless a specific missing requirement from the goal contract clearly requires one more step.
- If taskStatus is "not_done", prefer choosing the next step instead of returning done: true.
- If the user refers to prior work, earlier conversations, dates, or says "like before", prefer a dependent step that uses recall_memory first.
- recall_memory returns compact session metadata only. If exact prior details are needed, use read_file on the returned sessionPath in the same step or the next step.
- If user asks how previous work was done, use Recent Runs and Current Session pointers first; read the relevant runPath/session_path artifacts before answering.
- Execution limits you must plan for:
  - max_act_turns_per_step: 4
  - max_calls_per_turn_dependent: 1
  - max_calls_per_turn_independent: 2
  - max_total_tool_calls_per_step: 6
- NEVER use any path or tool listed in "Paths/tools NEVER to use again".
- If any approach failed, your new approach MUST differ from it - not just in wording.
- If the task asks for machine-wide file/path discovery, first discover valid roots instead of guessing paths.
- If there are 2 no-progress/missing-path outcomes in a row, pivot strategy instead of retrying the same style search.
- Never claim "entire filesystem searched" unless your tool inputs explicitly included root-level paths for that OS.
- Only the latest step newFacts are included inline. If you need facts from older steps, use context_search with scope "run_artifacts".
- For run_artifacts, default to the current run path first. Use prior run paths from Recent Runs only when the user explicitly asks about earlier runs.
- Run artifact format to target in context_search:
  - <runPath>/state.json has completedSteps[*] with outcome, summary, newFacts, artifacts, and tool counts.
  - <runPath>/steps/<NNN>-act.md contains action details per step.
  - <runPath>/steps/<NNN>-verify.md contains verification details per step.
- If you need project config, session history, or external skill commands, use context_search.
  - Scope options: "run_artifacts" (step files, state), "project_context" (soul, system prompt, user profile), "session" (session JSONL data), "skills" (external skill command reference), "both" (all).
  - Use "skills" scope when you need to load an external skill's commands before using it via the shell tool.
  - Write a clear, specific query with step numbers or file names so the scout can find the right information.
  - Use sparingly - max 2 per iteration.
- If consecutiveFailures >= 2, radically change direction.
- If the task is complete, set done: true.
- Set tools_hint to the specific tool names the executor should use for the next step.
- The "summary" field in completion is the ACTUAL RESPONSE shown to the user. Write it as a helpful, natural reply - not a log or description of what happened.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Understand stage — receives full system context.
 * Decides if this is simple (done:true) or complex (returns understand directive).
 */
export async function callUnderstand(
  provider: LlmProvider,
  state: LoopState,
  toolDefinitions: ToolDefinition[],
  systemContext: string,
  controllerPrompts?: ControllerPrompts,
): Promise<UnderstandDirective | CompletionDirective> {
  const prompt = buildUnderstandPrompt(
    state,
    toolDefinitions,
    resolveInstructions(controllerPrompts?.understand, DEFAULT_UNDERSTAND_INSTRUCTIONS),
  );
  const messages = [
    { role: "system" as const, content: systemContext },
    { role: "user" as const, content: prompt },
  ];

  const turn = await provider.generateTurn({ messages });
  const text = turn.type === "assistant" ? turn.content : "";
  return parseUnderstandResponse(text);
}

/**
 * Re-evaluation — runs understand again after consecutive failures.
 * Includes scout context (gathered by context scout) so the LLM can pivot.
 * Optionally includes system context when provided.
 */
export async function callReEval(
  provider: LlmProvider,
  state: LoopState,
  toolDefinitions: ToolDefinition[],
  scoutContext: string,
  controllerPrompts?: ControllerPrompts,
  systemContext?: string,
): Promise<ReEvalDirective | CompletionDirective> {
  const prompt = buildReEvalPrompt(
    state,
    toolDefinitions,
    scoutContext,
    resolveInstructions(controllerPrompts?.reeval, DEFAULT_REEVAL_INSTRUCTIONS),
  );
  const messages = [
    ...(systemContext && systemContext.trim().length > 0
      ? [{ role: "system" as const, content: systemContext }]
      : []),
    { role: "user" as const, content: prompt },
  ];

  const turn = await provider.generateTurn({ messages });
  const text = turn.type === "assistant" ? turn.content : "";
  return parseReEvalResponse(text);
}

/**
 * Direct stage — works from state fields populated by understand.
 * Optionally includes system context when provided.
 */
export async function callDirect(
  provider: LlmProvider,
  state: LoopState,
  toolDefinitions: ToolDefinition[],
  scoutContext?: string,
  controllerPrompts?: ControllerPrompts,
  systemContext?: string,
): Promise<StepDirective | ContextSearchDirective | CompletionDirective | SessionRotationDirective> {
  const prompt = buildDirectPrompt(
    state,
    toolDefinitions,
    scoutContext,
    resolveInstructions(controllerPrompts?.direct, DEFAULT_DIRECT_INSTRUCTIONS),
  );
  const messages = [
    ...(systemContext && systemContext.trim().length > 0
      ? [{ role: "system" as const, content: systemContext }]
      : []),
    { role: "user" as const, content: prompt },
  ];

  const turn = await provider.generateTurn({ messages });
  const text = turn.type === "assistant" ? turn.content : "";
  return parseDirectResponse(text);
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function formatSessionHistory(state: LoopState): string {
  if (state.sessionHistory.length === 0) return "";
  const lines = state.sessionHistory.map(
    (t) => `  [${t.timestamp}] ${t.role}: ${t.content.slice(0, 200)}`,
  );
  return `\nSession conversation so far:\n${lines.join("\n")}\n`;
}

function formatRecentRuns(state: LoopState): string {
  if (state.recentRunLedgers.length === 0) return "";
  const lines = state.recentRunLedgers.slice(-5).map((r, i) => {
    const runPath = r.runPath ? ` runPath=${truncateInline(r.runPath, 120)}` : "";
    const status = r.status ? ` status=${r.status}` : "";
    const summary = r.summary ? ` summary=${r.summary.slice(0, 120)}` : "";
    return `  ${i + 1}. [${r.timestamp}] runId=${r.runId}${runPath} state=${r.state}${status}${summary}`;
  });
  return `\nRecent runs (last ${lines.length}):\n${lines.join("\n")}\n`;
}

function resolveInstructions(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  return fallback;
}

function buildUnderstandPrompt(
  state: LoopState,
  toolDefinitions: ToolDefinition[],
  instructions: string,
): string {
  const toolNames = toolDefinitions.length > 0
    ? toolDefinitions.map((t) => t.name).join(", ")
    : "none";

  const sessionBlock = formatSessionHistory(state);
  const runsBlock = formatRecentRuns(state);

  return `Analyze this user request and decide how to handle it.

User message: ${state.userMessage}

Available tools: ${toolNames}
${sessionBlock}${runsBlock}
Instructions:
${instructions}

Respond with a single JSON object (no markdown fences):
For simple reply: { "done": true, "summary": "<your reply to the user>", "status": "completed" }
For complex task: { "done": false, "understand": true, "goal": { "objective": "...", "done_when": ["..."], "required_evidence": ["..."], "ask_user_when": ["..."], "stop_when_no_progress": ["..."] }, "approach": "...", "constraints": ["...", "..."] }`;
}

function buildReEvalPrompt(
  state: LoopState,
  toolDefinitions: ToolDefinition[],
  scoutContext?: string,
  instructions?: string,
): string {
  const toolNames = toolDefinitions.length > 0
    ? toolDefinitions.map((t) => t.name).join(", ")
    : "none";

  const failureContext = buildFailureContext(state.failedApproaches);

  const recentSteps = state.completedSteps
    .slice(-5)
    .map((s) => {
      let line = `  Step ${s.step}: [${s.outcome}] ${s.intent}`;
      if (s.summary) line += ` — ${s.summary.slice(0, 200)}`;
      if (s.failureType) line += ` (${s.failureType})`;
      return line;
    })
    .join("\n");

  const scoutBlock = scoutContext?.trim()
    ? `Context gathered by scout:\n${scoutContext}\n`
    : "";

  const sessionBlock = formatSessionHistory(state);
  const runsBlock = formatRecentRuns(state);

  return `The current approach has failed. Re-evaluate this task.

User message: ${state.userMessage}
Original goal:
${formatGoalContract(state.goal)}
Current approach: ${state.approach}
Constraints: ${state.constraints.length > 0 ? state.constraints.join("; ") : "none"}

Available tools: ${toolNames}
${sessionBlock}${runsBlock}
Recent steps:
${recentSteps || "  (none)"}

${failureContext}

${scoutBlock}
Consecutive failures: ${state.consecutiveFailures}

Instructions:
${instructions ?? DEFAULT_REEVAL_INSTRUCTIONS}

Respond with a single JSON object (no markdown fences):
For giving up: { "done": true, "summary": "<explanation to user>", "status": "failed" }
For new approach: { "done": false, "reeval": true, "approach": "...", "constraints": ["...", "..."] }`;
}

function buildDirectPrompt(
  state: LoopState,
  toolDefinitions: ToolDefinition[],
  scoutContext?: string,
  instructions?: string,
): string {
  const runsBlock = formatRecentRuns(state);
  const recentDetailedSteps = state.completedSteps
    .slice(-5)
    .map((s) => {
      let line = `  Step ${s.step}: [${s.outcome}] ${s.intent}`;
      if (s.summary) line += `\n    Summary: ${s.summary.slice(0, 300)}`;
      line += `\n    Tool results: success=${s.toolSuccessCount ?? 0}, failed=${s.toolFailureCount ?? 0}`;
      if (s.stoppedEarlyReason) line += `\n    Stop reason: ${s.stoppedEarlyReason}`;
      if (s.failureType) line += `\n    Failure type: ${s.failureType}`;
      if (s.artifacts.length > 0) line += `\n    Artifacts: ${s.artifacts.join(", ").slice(0, 300)}`;
      return line;
    })
    .join("\n");

  const allStepsIndex = state.completedSteps
    .map((s) => {
      const failure = s.failureType ? ` | failure=${s.failureType}` : "";
      const telemetry = ` | tool_success=${s.toolSuccessCount ?? 0} | tool_failed=${s.toolFailureCount ?? 0}`;
      const stopReason = s.stoppedEarlyReason ? ` | stop=${s.stoppedEarlyReason}` : "";
      const artifactRefs = s.artifacts.length > 0
        ? ` | artifacts=${truncateInline(s.artifacts.join(", "), 120)}`
        : "";
      const summary = s.summary?.trim().length > 0
        ? ` | summary=${truncateInline(s.summary, 120)}`
        : "";
      return `  Step ${s.step} | ${s.outcome}${failure}${telemetry}${stopReason} | intent=${truncateInline(s.intent, 90)}${artifactRefs}${summary}`;
    })
    .join("\n");

  const latestStep = state.completedSteps[state.completedSteps.length - 1];
  const latestStepFactsBlock = latestStep && latestStep.newFacts.length > 0
    ? `Latest step newFacts (step ${latestStep.step}):\n${latestStep.newFacts.map((fact) => `  - ${fact}`).join("\n")}`
    : "Latest step newFacts: none yet";
  const latestSuccessfulSummaryBlock = state.progressLedger.lastSuccessfulStepSummary.trim().length > 0
    ? `Latest successful step summary:\n  - ${truncateInline(state.progressLedger.lastSuccessfulStepSummary, 300)}`
    : "Latest successful step summary: none yet";

  const constraintsBlock = state.constraints.length > 0
    ? `Constraints:\n${state.constraints.map((c) => `  - ${c}`).join("\n")}`
    : "";

  const toolCatalog = buildToolCatalog(toolDefinitions);
  const failureContext = buildFailureContext(state.failedApproaches);
  const scoutBlock = scoutContext?.trim()
    ? `Scout research results (from prior context search):\n${scoutContext}`
    : "";
  const runArtifactsFormatBlock = `Run artifact format:\n  - ${state.runPath}/state.json (loop state; completedSteps[*] includes outcome, summary, newFacts, artifacts, toolSuccessCount, toolFailureCount)\n  - ${state.runPath}/steps/<NNN>-act.md (action details)\n  - ${state.runPath}/steps/<NNN>-verify.md (verification details)\n  - Only latest step newFacts are inlined here; use context_search to read older-step facts.`;

  return `You are directing an AI agent. Decide the next step.

Goal Contract:
${formatGoalContract(state.goal)}
Approach: ${state.approach}
${constraintsBlock}

User request: ${state.userMessage}
Task status: ${state.taskStatus}

${runsBlock}

${latestSuccessfulSummaryBlock}

${latestStepFactsBlock}

Run artifacts root: ${state.runPath}
${runArtifactsFormatBlock}

All completed steps index (${state.completedSteps.length} total):
${allStepsIndex || "  (none yet)"}

Recent detailed steps (last 5):
${recentDetailedSteps || "  (none yet)"}

${scoutBlock}

${failureContext}

Consecutive failures: ${state.consecutiveFailures}
Iteration: ${state.iteration} / ${state.maxIterations}

${toolCatalog}

Instructions:
${instructions ?? DEFAULT_DIRECT_INSTRUCTIONS}

Respond with a single JSON object (no markdown fences):
For next step: { "done": false, "execution_mode": "dependent" | "independent", "intent": "...", "tools_hint": [...], "success_criteria": "...", "context": "..." }
For context search: { "done": false, "context_search": true, "query": "...", "scope": "run_artifacts" | "project_context" | "session" | "skills" | "both" }
For completion: { "done": true, "summary": "<your reply to the user>", "status": "completed" | "failed" }
For session rotation: { "done": false, "rotate_session": true, "reason": "...", "handoff_summary": "..." }`;
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

export function parseUnderstandResponse(text: string): UnderstandDirective | CompletionDirective {
  const parsed = extractJson(text);

  if (parsed["done"] === true) {
    return {
      done: true,
      summary: String(parsed["summary"] ?? ""),
      status: parsed["status"] === "failed" ? "failed" : "completed",
    };
  }

  return {
    done: false,
    understand: true,
    goal: normalizeGoalContract(parsed["goal"]),
    approach: String(parsed["approach"] ?? ""),
    constraints: Array.isArray(parsed["constraints"])
      ? (parsed["constraints"] as unknown[]).map(String)
      : [],
  };
}

export function parseReEvalResponse(text: string): ReEvalDirective | CompletionDirective {
  const parsed = extractJson(text);

  if (parsed["done"] === true) {
    return {
      done: true,
      summary: String(parsed["summary"] ?? ""),
      status: parsed["status"] === "failed" ? "failed" : "completed",
    };
  }

  return {
    done: false,
    reeval: true,
    approach: String(parsed["approach"] ?? ""),
    constraints: Array.isArray(parsed["constraints"])
      ? (parsed["constraints"] as unknown[]).map(String)
      : [],
  };
}

export function parseDirectResponse(
  text: string,
): StepDirective | ContextSearchDirective | CompletionDirective | SessionRotationDirective {
  const parsed = extractJson(text);

  if (parsed["done"] === true) {
    return {
      done: true,
      summary: String(parsed["summary"] ?? ""),
      status: parsed["status"] === "failed" ? "failed" : "completed",
    };
  }

  if (parsed["rotate_session"] === true) {
    return {
      done: false,
      rotate_session: true,
      reason: String(parsed["reason"] ?? ""),
      handoff_summary: String(parsed["handoff_summary"] ?? ""),
    } satisfies SessionRotationDirective;
  }

  if (parsed["context_search"] === true) {
    return {
      done: false,
      context_search: true,
      query: String(parsed["query"] ?? ""),
      scope: normalizeScope(parsed["scope"]),
    } satisfies ContextSearchDirective;
  }

  return {
    done: false,
    execution_mode: normalizeExecutionMode(parsed["execution_mode"]),
    intent: String(parsed["intent"] ?? ""),
    tools_hint: Array.isArray(parsed["tools_hint"])
      ? (parsed["tools_hint"] as unknown[]).map(String)
      : [],
    success_criteria: String(parsed["success_criteria"] ?? ""),
    context: String(parsed["context"] ?? ""),
  };
}

// Keep backward-compat export for any external callers
export const parseControllerResponse = parseDirectResponse;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractJson(text: string): Record<string, unknown> {
  let jsonStr = text.trim();

  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    jsonStr = fenceMatch[1].trim();
  }

  return JSON.parse(jsonStr) as Record<string, unknown>;
}

function truncateInline(value: string, maxLen: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}...`;
}

function normalizeGoalContract(value: unknown): GoalContract {
  if (typeof value === "string") {
    return {
      objective: value,
      done_when: [],
      required_evidence: [],
      ask_user_when: [],
      stop_when_no_progress: [],
    };
  }

  const goal = (typeof value === "object" && value !== null)
    ? value as Partial<Record<keyof GoalContract, unknown>>
    : {};

  return {
    objective: String(goal.objective ?? ""),
    done_when: Array.isArray(goal.done_when) ? goal.done_when.map(String) : [],
    required_evidence: Array.isArray(goal.required_evidence) ? goal.required_evidence.map(String) : [],
    ask_user_when: Array.isArray(goal.ask_user_when) ? goal.ask_user_when.map(String) : [],
    stop_when_no_progress: Array.isArray(goal.stop_when_no_progress)
      ? goal.stop_when_no_progress.map(String)
      : [],
  };
}

function formatGoalContract(goal: GoalContract): string {
  const lines = [
    `  - objective: ${goal.objective || "(none)"}`,
    `  - done_when: ${formatInlineList(goal.done_when)}`,
    `  - required_evidence: ${formatInlineList(goal.required_evidence)}`,
    `  - ask_user_when: ${formatInlineList(goal.ask_user_when)}`,
    `  - stop_when_no_progress: ${formatInlineList(goal.stop_when_no_progress)}`,
  ];
  return lines.join("\n");
}

function formatInlineList(values: string[]): string {
  if (values.length === 0) return "(none)";
  return values.join("; ");
}

function buildFailureContext(failedApproaches: FailedApproach[]): string {
  if (failedApproaches.length === 0) return "";

  const lines: string[] = ["## Failed Approaches — DO NOT REPEAT"];
  for (const f of failedApproaches) {
    lines.push(`- Step ${f.step} [${f.failureType}]: ${f.intent}`);
    lines.push(`  Reason: ${f.reason}`);
    if (f.blockedTargets.length > 0) {
      lines.push(`  Blocked: ${f.blockedTargets.join(", ")}`);
    }
  }

  const allBlocked = [...new Set(failedApproaches.flatMap((f) => f.blockedTargets))];
  if (allBlocked.length > 0) {
    lines.push("\nPaths/tools NEVER to use again this run:");
    lines.push(allBlocked.map((t) => `  - ${t}`).join("\n"));
  }
  return lines.join("\n");
}

function normalizeExecutionMode(value: unknown): "dependent" | "independent" {
  if (value === "independent") return "independent";
  return "dependent";
}

function normalizeScope(value: unknown): "run_artifacts" | "project_context" | "session" | "skills" | "both" {
  const valid = new Set(["run_artifacts", "project_context", "session", "skills", "both"]);
  if (typeof value === "string" && valid.has(value)) {
    return value as "run_artifacts" | "project_context" | "session" | "skills" | "both";
  }
  return "both";
}
