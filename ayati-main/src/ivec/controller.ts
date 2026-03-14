import type { LlmProvider } from "../core/contracts/provider.js";
import type { LlmResponseFormat, LlmTurnOutput } from "../core/contracts/llm-protocol.js";
import type { ControllerPrompts } from "../context/types.js";
import { compileResponseFormatForProvider } from "../providers/shared/provider-profiles.js";
import type { ToolDefinition } from "../skills/types.js";
import type {
  LoopState,
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
- If attached documents are present and the user is asking about their contents, you MUST start with context_search using scope "documents" instead of guessing or reading large files through normal step tools.
- Do NOT propose shell/filesystem extraction as the first approach for attached-document questions.
- Before creating a plan, run a readiness check:
  - Is the objective clear?
  - Are required inputs or targets sufficiently specified?
  - Are boundaries clear enough to avoid unsafe or low-confidence assumptions?
  - Is success verifiable with concrete evidence?
- If the request is under-specified or ambiguous:
  - Do NOT ask by default.
  - First decide whether you can proceed safely by making a reasonable assumption or by verifying with available tools.
  - Return done: true and ask exactly ONE targeted clarification question only when the missing detail materially changes the answer or outcome, affects safety or permission boundaries, can only be decided by the user, or a mistake would be costly because the work is expensive, time-consuming, or hard to redo.
  - Ask the highest-information-gain question first (the single question whose answer most reduces uncertainty).
  - Keep the question short, specific, and easy to answer.
  - Do not ask multiple questions in one turn unless safety or permission boundaries require it.
  - Do not ask for information that is already available in conversation or memory context.
  - If the ambiguity is low-risk and recoverable, proceed with the best reasonable interpretation and briefly state the assumption only if it helps.
- If the request is sufficiently clear, return done: false with:
  - goal.objective: specific, unambiguous intent
  - goal.done_when: concrete completion conditions
  - goal.required_evidence: objective evidence needed to mark task complete
  - goal.ask_user_when: explicit triggers that require pausing for user input
  - goal.stop_when_no_progress: explicit conditions for stopping after repeated non-progress
  - approach: a practical initial direction using available tools
- Quality bar for done: false:
  - objective must be actionable and specific (not a restatement of the raw message).
  - done_when and required_evidence should be concrete and non-empty for non-trivial tasks.
  - ask_user_when should include real ambiguity or permission triggers, not generic filler.
  - If confidence is not high enough and the mistake would materially change the outcome or be costly to undo, prefer one clarifying question first. Otherwise proceed with a reasonable assumption or a verification step.`;

const DEFAULT_REEVAL_INSTRUCTIONS = `- The current approach has not been working. You MUST provide a different approach.
- If the task is no longer achievable, respond with done: true and status: "failed".
- Otherwise provide an updated approach only.
- Do NOT change the goal contract during re-evaluation.
- Your new approach MUST differ substantially from any failed approaches listed above.
- Use prior successful and failed step evidence to choose the next approach.
- If you need older-step facts, session details, project config, or external skill commands before choosing a new approach, request context_search first.
- If the revised approach depends on an older non-latest step, you MUST use context_search with scope "run_artifacts" to read that step's act/verify details before proposing the approach.
- If the revised approach will use an external skill, you MUST use context_search with scope "skills" to read that skill's skill.md before proposing the approach.`;

const DEFAULT_DIRECT_INSTRUCTIONS = `- Pick exactly 1 next action. Reduce uncertainty first.
- For low-risk public facts, current information, or other requests that are easy to verify, prefer checking with tools/search instead of asking the user to restate or reconfirm.
- If the next step would be expensive, time-consuming, or hard to undo, and key requirements are still unclear, prefer clarifying before executing.
- Choose execution_mode for next step:
  - dependent: tools depend on prior output; executor runs max 1 tool call per turn.
  - independent: tools are parallel-safe; executor runs max 2 tool calls per turn.
- If taskStatus is "done", "blocked", or "needs_user_input", do NOT plan another step. Return done: true with the final response to the user.
- If taskStatus is "likely_done", prefer returning done: true unless a specific missing requirement from the goal contract clearly requires one more step.
- If taskStatus is "not_done", prefer choosing the next step instead of returning done: true, unless grounded document scout context already sufficiently answers an attached-document question.
- If the user refers to prior work, earlier conversations, dates, or says "like before", prefer a dependent step that uses recall_memory first.
- recall_memory returns compact session metadata only. If exact prior details are needed, use read_file on the returned sessionPath in the same step or the next step.
- If user asks how previous work was done, use Recent Runs and Current Session pointers first; read the relevant runPath/session_path artifacts before answering.
- If attached documents are available and the answer depends on those documents, you MUST use context_search with scope "documents" before planning shell/filesystem tools.
- If scoutContext already contains grounded document evidence that answers the question, prefer done: true or a final user-facing answer instead of more tool calls.
- If scoutContext includes "Document retrieval status: sufficient", do NOT request another document context_search in the same iteration. Answer the user or choose the execution step that uses the existing document evidence.
- If scoutContext includes "Document retrieval status: empty", do not keep rephrasing the same document query. Either answer with what was found or explain that the requested information was not found in the attachment.
- If scoutContext includes "Document retrieval status: unavailable", do not request more document context_search. Explain the attachment-processing limitation to the user.
- Another document context_search is appropriate only when the current document retrieval state is partial or empty and the new query materially narrows the target section or fact you need.
- context_search with scope "documents" returns bounded, grounded document context only. It is the preferred path for large attachments.
- If only some attachments are relevant and their paths are known, include document_paths in the context_search directive.
- Execution limits you must plan for:
  - max_act_turns_per_step: 4
  - max_calls_per_turn_dependent: 1
  - max_calls_per_turn_independent: 2
  - max_total_tool_calls_per_step: 6
- If the task asks for machine-wide file/path discovery, first discover valid roots instead of guessing paths.
- If there are 2 no-progress/missing-path outcomes in a row, pivot strategy instead of retrying the same style search.
- Never claim "entire filesystem searched" unless your tool inputs explicitly included root-level paths for that OS.
- Only the latest step newFacts are included inline. If you need facts from older steps, use context_search with scope "run_artifacts".
- If the next action depends on an older non-latest step, you MUST use context_search with scope "run_artifacts" to read that step's act/verify details before planning the step.
- For run_artifacts, default to the current run path first. Use prior run paths from Recent Runs only when the user explicitly asks about earlier runs.
- Run artifact format to target in context_search:
  - <runPath>/state.json has completedSteps[*] with outcome, summary, newFacts, artifacts, and tool counts.
  - <runPath>/steps/<NNN>-act.md contains action details per step.
  - <runPath>/steps/<NNN>-verify.md contains verification details per step.
- If you need project config, session history, or external skill commands, use context_search.
  - Scope options: "run_artifacts" (step files, state), "project_context" (soul, system prompt, user profile), "session" (session JSONL data), "skills" (external skill command reference), "documents" (attached document retrieval), "both" (all non-document scout locations).
  - Before using any external skill, you MUST use "skills" scope to load that skill's full command reference from skill.md.
  - Write a clear, specific query with step numbers or file names so the scout can find the right information.
  - Use sparingly - max 4 per iteration.
- If the task is complete, set done: true.
- Set tools_hint to the specific tool names the executor should use for the next step.
- The "summary" field in completion is the ACTUAL RESPONSE shown to the user. Write it as a helpful, natural reply - not a log or description of what happened.`;

const CONTROLLER_STAGE_FORMAT_ERROR_PREFIX = "Invalid controller response format";
const STRICT_JSON_RESPONSE_NOTE =
  `Use strict JSON syntax with double-quoted strings and lowercase true, false, and null.`;
const CONTROLLER_JSON_REPAIR_PROMPT = `Your previous response was invalid because it was not a single valid JSON object that matched the requested shape.
Reply again with exactly one JSON object.
${STRICT_JSON_RESPONSE_NOTE}
Do not include markdown fences.
Do not include any explanation before or after the JSON.`;

const JSON_STRING_SCHEMA = { type: "string" } as const;
const JSON_STRING_ARRAY_SCHEMA = {
  type: "array",
  items: JSON_STRING_SCHEMA,
} as const;
const STATUS_ENUM = ["completed", "failed"] as const;
const EXECUTION_MODE_ENUM = ["dependent", "independent"] as const;
const CONTEXT_SEARCH_SCOPE_ENUM = [
  "run_artifacts",
  "project_context",
  "session",
  "skills",
  "documents",
  "both",
] as const;

const GOAL_CONTRACT_SCHEMA = {
  type: "object",
  properties: {
    objective: JSON_STRING_SCHEMA,
    done_when: JSON_STRING_ARRAY_SCHEMA,
    required_evidence: JSON_STRING_ARRAY_SCHEMA,
    ask_user_when: JSON_STRING_ARRAY_SCHEMA,
    stop_when_no_progress: JSON_STRING_ARRAY_SCHEMA,
  },
  required: [
    "objective",
    "done_when",
    "required_evidence",
    "ask_user_when",
    "stop_when_no_progress",
  ],
  additionalProperties: false,
} as const;

const COMPLETION_DIRECTIVE_SCHEMA = {
  type: "object",
  properties: {
    done: { enum: [true] },
    summary: JSON_STRING_SCHEMA,
    status: { type: "string", enum: [...STATUS_ENUM] },
  },
  required: ["done", "summary", "status"],
  additionalProperties: false,
} as const;

const CONTEXT_SEARCH_DIRECTIVE_SCHEMA = {
  type: "object",
  properties: {
    done: { enum: [false] },
    context_search: { enum: [true] },
    query: JSON_STRING_SCHEMA,
    scope: { type: "string", enum: [...CONTEXT_SEARCH_SCOPE_ENUM] },
    document_paths: JSON_STRING_ARRAY_SCHEMA,
  },
  required: ["done", "context_search", "query", "scope", "document_paths"],
  additionalProperties: false,
} as const;

const SESSION_ROTATION_DIRECTIVE_SCHEMA = {
  type: "object",
  properties: {
    done: { enum: [false] },
    rotate_session: { enum: [true] },
    reason: JSON_STRING_SCHEMA,
    handoff_summary: JSON_STRING_SCHEMA,
  },
  required: ["done", "rotate_session", "reason", "handoff_summary"],
  additionalProperties: false,
} as const;

const DIRECT_STEP_DIRECTIVE_SCHEMA = {
  type: "object",
  properties: {
    done: { enum: [false] },
    execution_mode: { type: "string", enum: [...EXECUTION_MODE_ENUM] },
    intent: JSON_STRING_SCHEMA,
    tools_hint: JSON_STRING_ARRAY_SCHEMA,
    success_criteria: JSON_STRING_SCHEMA,
    context: JSON_STRING_SCHEMA,
  },
  required: ["done", "execution_mode", "intent", "tools_hint", "success_criteria", "context"],
  additionalProperties: false,
} as const;

const UNDERSTAND_DIRECTIVE_SCHEMA = {
  type: "object",
  properties: {
    done: { enum: [false] },
    understand: { enum: [true] },
    goal: GOAL_CONTRACT_SCHEMA,
    approach: JSON_STRING_SCHEMA,
  },
  required: ["done", "understand", "goal", "approach"],
  additionalProperties: false,
} as const;

const REEVAL_DIRECTIVE_SCHEMA = {
  type: "object",
  properties: {
    done: { enum: [false] },
    reeval: { enum: [true] },
    approach: JSON_STRING_SCHEMA,
  },
  required: ["done", "reeval", "approach"],
  additionalProperties: false,
} as const;

function buildControllerEnvelopeSchema(
  kinds: readonly string[],
  payloadSchemas: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...kinds] },
      payload: {
        anyOf: payloadSchemas.map((schema) => ({ ...schema })),
      },
    },
    required: ["kind", "payload"],
    additionalProperties: false,
  };
}

const UNDERSTAND_RESPONSE_FORMAT: LlmResponseFormat = {
  type: "json_schema",
  name: "controller_understand_response",
  strict: true,
  schema: buildControllerEnvelopeSchema(
    ["completion", "understand"],
    [COMPLETION_DIRECTIVE_SCHEMA, UNDERSTAND_DIRECTIVE_SCHEMA],
  ),
};

const DIRECT_RESPONSE_FORMAT: LlmResponseFormat = {
  type: "json_schema",
  name: "controller_direct_response",
  strict: true,
  schema: buildControllerEnvelopeSchema(
    ["completion", "context_search", "rotate_session", "step"],
    [
      COMPLETION_DIRECTIVE_SCHEMA,
      CONTEXT_SEARCH_DIRECTIVE_SCHEMA,
      SESSION_ROTATION_DIRECTIVE_SCHEMA,
      DIRECT_STEP_DIRECTIVE_SCHEMA,
    ],
  ),
};

const REEVAL_RESPONSE_FORMAT: LlmResponseFormat = {
  type: "json_schema",
  name: "controller_reeval_response",
  strict: true,
  schema: buildControllerEnvelopeSchema(
    ["completion", "context_search", "reeval"],
    [
      COMPLETION_DIRECTIVE_SCHEMA,
      CONTEXT_SEARCH_DIRECTIVE_SCHEMA,
      REEVAL_DIRECTIVE_SCHEMA,
    ],
  ),
};

type ControllerStage = "understand" | "direct" | "reeval";

export class ControllerResponseFormatError extends Error {
  readonly stage: ControllerStage;
  readonly providerName: string;
  readonly attempts: number;
  readonly structuredOutputRequested: boolean;
  readonly rawResponsePreview: string;

  constructor(input: {
    stage: ControllerStage;
    providerName: string;
    attempts: number;
    structuredOutputRequested: boolean;
    rawResponse: string;
    cause?: unknown;
  }) {
    const preview = previewControllerResponse(input.rawResponse);
    super(
      `${CONTROLLER_STAGE_FORMAT_ERROR_PREFIX} at ${input.stage} stage from ${input.providerName} after ${input.attempts} attempt(s): ${preview || "(empty response)"}`,
    );
    this.name = "ControllerResponseFormatError";
    this.stage = input.stage;
    this.providerName = input.providerName;
    this.attempts = input.attempts;
    this.structuredOutputRequested = input.structuredOutputRequested;
    this.rawResponsePreview = preview;
    if (input.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = input.cause;
    }
  }
}

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
  return runControllerTurn(
    provider,
    "understand",
    messages,
    UNDERSTAND_RESPONSE_FORMAT,
    parseUnderstandResponse,
  );
}

/**
 * Re-evaluation — invoked after a failed step to choose a different approach.
 * Optionally includes system context when provided.
 */
export async function callReEval(
  provider: LlmProvider,
  state: LoopState,
  toolDefinitions: ToolDefinition[],
  scoutContext?: string,
  controllerPrompts?: ControllerPrompts,
  systemContext?: string,
): Promise<ReEvalDirective | ContextSearchDirective | CompletionDirective> {
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
  return runControllerTurn(
    provider,
    "reeval",
    messages,
    REEVAL_RESPONSE_FORMAT,
    parseReEvalResponse,
  );
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
  return runControllerTurn(
    provider,
    "direct",
    messages,
    DIRECT_RESPONSE_FORMAT,
    parseDirectResponse,
  );
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
  const attachmentsBlock = formatAttachedDocuments(state);
  const inputBlock = buildInputBlock(state);

  return `Analyze this user request and decide how to handle it.

${inputBlock}

Available tools: ${toolNames}
${sessionBlock}${runsBlock}${attachmentsBlock}
Instructions:
${instructions}

Respond with a single JSON object (no markdown fences):
${STRICT_JSON_RESPONSE_NOTE}
For simple reply: { "kind": "completion", "payload": { "done": true, "summary": "<your reply to the user>", "status": "completed" } }
For complex task: { "kind": "understand", "payload": { "done": false, "understand": true, "goal": { "objective": "...", "done_when": ["..."], "required_evidence": ["..."], "ask_user_when": ["..."], "stop_when_no_progress": ["..."] }, "approach": "..." } }`;
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

  const recentSuccessfulSteps = state.completedSteps
    .filter((s) => s.outcome === "success")
    .slice(-5)
    .map((s) => {
      let line = `  Step ${s.step}: ${s.intent}`;
      if (s.summary) line += ` — ${s.summary.slice(0, 220)}`;
      line += ` (tool_success=${s.toolSuccessCount ?? 0}, tool_failed=${s.toolFailureCount ?? 0})`;
      return line;
    })
    .join("\n");

  const recentFailedSteps = state.completedSteps
    .filter((s) => s.outcome === "failed")
    .slice(-5)
    .map((s) => {
      let line = `  Step ${s.step}: [${s.outcome}] ${s.intent}`;
      if (s.summary) line += ` — ${s.summary.slice(0, 200)}`;
      if (s.failureType) line += ` (${s.failureType})`;
      if (s.stoppedEarlyReason) line += ` [stop=${s.stoppedEarlyReason}]`;
      line += ` [tool_success=${s.toolSuccessCount ?? 0}, tool_failed=${s.toolFailureCount ?? 0}]`;
      return line;
    })
    .join("\n");

  const scoutBlock = scoutContext?.trim()
    ? `Retrieved context from prior context_search:\n${scoutContext}\n`
    : "";
  const sessionBlock = formatSessionHistory(state);
  const runsBlock = formatRecentRuns(state);
  const attachmentsBlock = formatAttachedDocuments(state);
  const runArtifactsFormatBlock = buildRunArtifactsFormatBlock(state.runPath);
  const inputBlock = buildInputBlock(state);

  return `The current approach has failed. Re-evaluate this task.

${inputBlock}
Original goal:
${formatGoalContract(state.goal)}
Current approach: ${state.approach}

Available tools: ${toolNames}
${sessionBlock}${runsBlock}${attachmentsBlock}

Run artifacts root: ${state.runPath}
${runArtifactsFormatBlock}

Previous successful steps (latest 5):
${recentSuccessfulSteps || "  (none)"}

Failed steps (latest 5):
${recentFailedSteps || "  (none)"}

${failureContext}

${scoutBlock}
Consecutive failures: ${state.consecutiveFailures}
Approach changes so far: ${state.approachChangeCount}

Instructions:
${instructions ?? DEFAULT_REEVAL_INSTRUCTIONS}

Respond with a single JSON object (no markdown fences):
${STRICT_JSON_RESPONSE_NOTE}
For giving up: { "kind": "completion", "payload": { "done": true, "summary": "<explanation to user>", "status": "failed" } }
For context search: { "kind": "context_search", "payload": { "done": false, "context_search": true, "query": "...", "scope": "run_artifacts" | "project_context" | "session" | "skills" | "documents" | "both", "document_paths": ["optional/path or empty array"] } }
For new approach: { "kind": "reeval", "payload": { "done": false, "reeval": true, "approach": "..." } }`;
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

  const toolCatalog = buildToolCatalog(toolDefinitions);
  const scoutBlock = scoutContext?.trim()
    ? `Retrieved context from prior context_search:\n${scoutContext}`
    : "";
  const attachmentsBlock = formatAttachedDocuments(state);
  const runArtifactsFormatBlock = buildRunArtifactsFormatBlock(state.runPath);
  const inputBlock = buildInputBlock(state);

  return `You are directing an AI agent. Decide the next step.

${inputBlock}

Goal Contract:
${formatGoalContract(state.goal)}
Approach: ${state.approach}
Task status: ${state.taskStatus}

${runsBlock}

${attachmentsBlock}

${latestSuccessfulSummaryBlock}

${latestStepFactsBlock}

Run artifacts root: ${state.runPath}
${runArtifactsFormatBlock}

All completed steps index (${state.completedSteps.length} total):
${allStepsIndex || "  (none yet)"}

Recent detailed steps (last 5):
${recentDetailedSteps || "  (none yet)"}

${scoutBlock}

Consecutive failures: ${state.consecutiveFailures}
Iteration: ${state.iteration} / ${state.maxIterations}

${toolCatalog}

Instructions:
${instructions ?? DEFAULT_DIRECT_INSTRUCTIONS}

Respond with a single JSON object (no markdown fences):
${STRICT_JSON_RESPONSE_NOTE}
For next step: { "kind": "step", "payload": { "done": false, "execution_mode": "dependent" | "independent", "intent": "...", "tools_hint": [...], "success_criteria": "...", "context": "..." } }
For context search: { "kind": "context_search", "payload": { "done": false, "context_search": true, "query": "...", "scope": "run_artifacts" | "project_context" | "session" | "skills" | "documents" | "both", "document_paths": ["optional/path or empty array"] } }
For completion: { "kind": "completion", "payload": { "done": true, "summary": "<your reply to the user>", "status": "completed" | "failed" } }
For session rotation: { "kind": "rotate_session", "payload": { "done": false, "rotate_session": true, "reason": "...", "handoff_summary": "..." } }`;
}

function buildInputBlock(state: LoopState): string {
  if (state.inputKind !== "system_event" || !state.systemEvent) {
    return `User message: ${state.userMessage}`;
  }

  const payloadPreview = JSON.stringify({
    source: state.systemEvent.source,
    eventName: state.systemEvent.eventName,
    receivedAt: state.systemEvent.receivedAt,
    payload: state.systemEvent.payload,
  });

  return [
    "Input kind: system_event",
    `System event summary: ${state.userMessage}`,
    `System event payload: ${payloadPreview}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

export function parseUnderstandResponse(text: string): UnderstandDirective | CompletionDirective {
  const parsed = unwrapControllerEnvelope(extractJson(text));

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
  };
}

export function parseReEvalResponse(text: string): ReEvalDirective | ContextSearchDirective | CompletionDirective {
  const parsed = unwrapControllerEnvelope(extractJson(text));

  if (parsed["done"] === true) {
    return {
      done: true,
      summary: String(parsed["summary"] ?? ""),
      status: parsed["status"] === "failed" ? "failed" : "completed",
    };
  }

  if (parsed["context_search"] === true) {
    const documentPaths = Array.isArray(parsed["document_paths"])
      ? (parsed["document_paths"] as unknown[]).map(String).filter((path) => path.trim().length > 0)
      : [];
    return {
      done: false,
      context_search: true,
      query: String(parsed["query"] ?? ""),
      scope: normalizeScope(parsed["scope"]),
      document_paths: documentPaths.length > 0 ? documentPaths : undefined,
    } satisfies ContextSearchDirective;
  }

  return {
    done: false,
    reeval: true,
    approach: String(parsed["approach"] ?? ""),
  };
}

export function parseDirectResponse(
  text: string,
): StepDirective | ContextSearchDirective | CompletionDirective | SessionRotationDirective {
  const parsed = unwrapControllerEnvelope(extractJson(text));

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
    const documentPaths = Array.isArray(parsed["document_paths"])
      ? (parsed["document_paths"] as unknown[]).map(String).filter((path) => path.trim().length > 0)
      : [];
    return {
      done: false,
      context_search: true,
      query: String(parsed["query"] ?? ""),
      scope: normalizeScope(parsed["scope"]),
      document_paths: documentPaths.length > 0 ? documentPaths : undefined,
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

async function runControllerTurn<T>(
  provider: LlmProvider,
  stage: ControllerStage,
  messages: Array<{ role: "system" | "user"; content: string }>,
  preferredResponseFormat: LlmResponseFormat,
  parser: (text: string) => T,
): Promise<T> {
  const responseFormat = resolveResponseFormat(provider, preferredResponseFormat);
  const firstTurn = await provider.generateTurn({
    messages,
    ...(responseFormat ? { responseFormat } : {}),
  });
  const firstText = extractControllerTurnText(firstTurn);

  try {
    return parser(firstText);
  } catch (error) {
    const retryMessages = [
      ...messages,
      ...(firstText.trim().length > 0 ? [{ role: "assistant" as const, content: firstText }] : []),
      { role: "user" as const, content: CONTROLLER_JSON_REPAIR_PROMPT },
    ];
    let retryText = firstText;

    try {
      const retryTurn = await provider.generateTurn({
        messages: retryMessages,
        ...(responseFormat ? { responseFormat } : {}),
      });
      retryText = extractControllerTurnText(retryTurn);
      return parser(retryText);
    } catch (retryError) {
      throw new ControllerResponseFormatError({
        stage,
        providerName: provider.name,
        attempts: 2,
        structuredOutputRequested: Boolean(responseFormat),
        rawResponse: retryText,
        cause: retryError,
      });
    }
  }
}

function extractJson(text: string): Record<string, unknown> {
  const normalized = unwrapJsonFence(text.trim());
  const direct = tryParseJsonRecordWithRecovery(normalized);
  if (direct) return direct;

  const extracted = findFirstJsonObject(normalized);
  if (extracted) {
    const parsed = tryParseJsonRecordWithRecovery(extracted);
    if (parsed) return parsed;
  }

  throw new SyntaxError(
    `Expected a JSON object but received: ${previewControllerResponse(text) || "(empty response)"}`,
  );
}

function tryParseJsonRecordWithRecovery(text: string): Record<string, unknown> | null {
  const direct = tryParseJsonRecord(text);
  if (direct) return direct;

  const normalized = normalizeJsonLikeRecord(text);
  if (normalized !== text) {
    return tryParseJsonRecord(normalized);
  }

  return null;
}

function resolveResponseFormat(
  provider: LlmProvider,
  preferred: LlmResponseFormat,
): LlmResponseFormat | undefined {
  return compileResponseFormatForProvider(provider.name, provider.capabilities, preferred);
}

function extractControllerTurnText(turn: LlmTurnOutput): string {
  if (turn.type === "assistant") {
    return turn.content;
  }
  return turn.assistantContent ?? "";
}

function unwrapJsonFence(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  return text;
}

function tryParseJsonRecord(text: string): Record<string, unknown> | null {
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function unwrapControllerEnvelope(parsed: Record<string, unknown>): Record<string, unknown> {
  if (typeof parsed["kind"] === "string" && isPlainObject(parsed["payload"])) {
    return parsed["payload"] as Record<string, unknown>;
  }
  return parsed;
}

function normalizeJsonLikeRecord(text: string): string {
  if (text.length === 0) return text;

  let normalized = "";
  let changed = false;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!char) continue;

    if (inString) {
      normalized += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      normalized += char;
      continue;
    }

    const literal =
      readPythonJsonLiteral(text, index, "True", "true")
      ?? readPythonJsonLiteral(text, index, "False", "false")
      ?? readPythonJsonLiteral(text, index, "None", "null");

    if (literal) {
      normalized += literal.replacement;
      index += literal.length - 1;
      changed = true;
      continue;
    }

    normalized += char;
  }

  return changed ? normalized : text;
}

function readPythonJsonLiteral(
  text: string,
  index: number,
  token: "True" | "False" | "None",
  replacement: "true" | "false" | "null",
): { length: number; replacement: string } | null {
  if (!text.startsWith(token, index)) return null;

  const before = index - 1;
  const after = index + token.length;
  if (!isJsonLiteralBoundary(text, before) || !isJsonLiteralBoundary(text, after)) {
    return null;
  }

  return { length: token.length, replacement };
}

function isJsonLiteralBoundary(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return true;
  const char = text[index];
  return !char || !/[A-Za-z0-9_$]/.test(char);
}

function findFirstJsonObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!char) continue;

    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
        inString = false;
        escaping = false;
      }
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth++;
      continue;
    }

    if (char === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function previewControllerResponse(text: string, maxLength = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength)}...`;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function formatAttachedDocuments(state: LoopState): string {
  const attachedDocuments = state.attachedDocuments ?? [];
  const warnings = state.attachmentWarnings ?? [];
  if (attachedDocuments.length === 0 && warnings.length === 0) return "";

  const lines = attachedDocuments.map((document) =>
    `  - ${document.name} | kind=${document.kind} | path=${truncateInline(document.originalPath, 140)}`,
  );
  const warningLines = warnings.map((warning) => `  - warning: ${truncateInline(warning, 160)}`);
  return `\nAttached documents available (${attachedDocuments.length}):\n${[...lines, ...warningLines].join("\n")}\n`;
}

function buildRunArtifactsFormatBlock(runPath: string): string {
  return `Run artifact format:\n  - ${runPath}/state.json (loop state; completedSteps[*] includes outcome, summary, newFacts, artifacts, toolSuccessCount, toolFailureCount)\n  - ${runPath}/steps/<NNN>-act.md (action details)\n  - ${runPath}/steps/<NNN>-verify.md (verification details)\n  - Only latest step newFacts are inlined here; use context_search to read older-step facts.`;
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

function normalizeScope(value: unknown): "run_artifacts" | "project_context" | "session" | "skills" | "documents" | "both" {
  const valid = new Set(["run_artifacts", "project_context", "session", "skills", "documents", "both"]);
  if (typeof value === "string" && valid.has(value)) {
    return value as "run_artifacts" | "project_context" | "session" | "skills" | "documents" | "both";
  }
  return "both";
}
