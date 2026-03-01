import type { LlmProvider } from "../core/contracts/provider.js";
import type { ToolDefinition } from "../skills/types.js";
import type { LoopState, ControllerOutput, SessionRotationDirective, FailedApproach } from "./types.js";
import { buildToolCatalog } from "./tool-catalog.js";

interface ControllerPromptExtras {
  inspectedStepsContext?: string;
}

export async function callController(
  provider: LlmProvider,
  state: LoopState,
  toolDefinitions: ToolDefinition[],
  systemContext?: string,
  extras?: ControllerPromptExtras,
): Promise<ControllerOutput> {
  const prompt = buildControllerPrompt(state, toolDefinitions, extras);
  const messages = systemContext
    ? [
        { role: "system" as const, content: systemContext },
        { role: "user" as const, content: prompt },
      ]
    : [{ role: "user" as const, content: prompt }];

  const turn = await provider.generateTurn({ messages });

  const text = turn.type === "assistant" ? turn.content : "";
  return parseControllerResponse(text, state.approach);
}

function buildControllerPrompt(
  state: LoopState,
  toolDefinitions: ToolDefinition[],
  extras?: ControllerPromptExtras,
): string {
  const recentDetailedSteps = state.completedSteps
    .slice(-5)
    .map((s) => {
      let line = `  Step ${s.step}: [${s.outcome}] ${s.intent}`;
      if (s.summary) line += `\n    Summary: ${s.summary.slice(0, 300)}`;
      if (s.evidence) line += `\n    Evidence: ${s.evidence.slice(0, 300)}`;
      line += `\n    Tool results: success=${s.toolSuccessCount ?? 0}, failed=${s.toolFailureCount ?? 0}`;
      if (s.stoppedEarlyReason) line += `\n    Stop reason: ${s.stoppedEarlyReason}`;
      if (s.failureType) line += `\n    Failure type: ${s.failureType}`;
      if (s.artifacts.length > 0) line += `\n    Artifacts: ${s.artifacts.join(", ").slice(0, 300)}`;
      if (s.actFile || s.verifyFile) {
        line += `\n    Files: ${s.actFile ?? "n/a"}, ${s.verifyFile ?? "n/a"}`;
      }
      return line;
    })
    .join("\n");

  const allStepsIndex = state.completedSteps
    .map((s) => {
      const pad = String(s.step).padStart(3, "0");
      const actPath = s.actFile ?? `steps/${pad}-act.json`;
      const verifyPath = s.verifyFile ?? `steps/${pad}-verify.json`;
      const failure = s.failureType ? ` | failure=${s.failureType}` : "";
      const telemetry = ` | tool_success=${s.toolSuccessCount ?? 0} | tool_failed=${s.toolFailureCount ?? 0}`;
      const stopReason = s.stoppedEarlyReason ? ` | stop=${s.stoppedEarlyReason}` : "";
      const summary = s.summary?.trim().length > 0
        ? ` | summary=${truncateInline(s.summary, 120)}`
        : s.evidence?.trim().length > 0
          ? ` | evidence=${truncateInline(s.evidence, 120)}`
          : "";
      return `  Step ${s.step} | ${s.outcome}${failure}${telemetry}${stopReason} | intent=${truncateInline(s.intent, 90)} | files=${actPath}, ${verifyPath}${summary}`;
    })
    .join("\n");

  const factsBlock = state.facts.length > 0
    ? `Known facts:\n${state.facts.map((f) => `  - ${f}`).join("\n")}`
    : "Known facts: none yet";

  const uncertainBlock = state.uncertainties.length > 0
    ? `Uncertainties:\n${state.uncertainties.map((u) => `  - ${u}`).join("\n")}`
    : "";

  const toolCatalog = buildToolCatalog(toolDefinitions);
  const failureContext = buildFailureContext(state.failedApproaches);
  const inspectedStepsContext = extras?.inspectedStepsContext?.trim() ?? "";
  const inspectedBlock = inspectedStepsContext.length > 0
    ? `Inspected step details (requested by controller):\n${inspectedStepsContext}`
    : "";
  const goal = state.goal.trim().length > 0 ? state.goal : "(not set yet)";
  const approach = state.approach.trim().length > 0 ? state.approach : "(not set yet)";

  return `You are a controller deciding the next step for an AI agent.

User request: ${state.userMessage}
Goal: ${goal}
Approach: ${approach}

${factsBlock}
${uncertainBlock}

Run artifacts root: ${state.runPath}

All completed steps index (${state.completedSteps.length} total):
${allStepsIndex || "  (none yet)"}

Recent detailed steps (last 5):
${recentDetailedSteps || "  (none yet)"}

${inspectedBlock}

${failureContext}

Consecutive failures: ${state.consecutiveFailures}
Iteration: ${state.iteration} / ${state.maxIterations}

${toolCatalog}

Instructions:
- If the user's message is casual conversation (greeting, small talk, simple question that needs no tools), respond immediately with done: true. Write the summary as a natural, friendly reply — this is shown directly to the user.
- Keep user request RAW. Do not rewrite it.
- Goal should be a clearer, richer intent statement than the raw user request.
- If Goal is "(not set yet)", you MUST provide "goal_update".
- On the first actionable turn, provide "approach_update" as a rough direction using goal and available tools.
- If recent progress is successful, keep approach stable (no unnecessary changes).
- If failures/no-progress happen, provide "approach_update" and "approach_change_reason" to pivot direction.
- Always choose execution_mode for next step:
  - dependent: tools depend on prior output; executor will run max 1 tool call per turn.
  - independent: tools are parallel-safe; executor will run max 2 tool calls per turn.
- If the user refers to prior work, earlier conversations, dates, or says "like before", prefer a dependent step that uses recall_memory first.
- recall_memory returns compact session metadata only. If exact prior details are needed, use read_file on the returned sessionPath in the same step or the next step.
- Execution limits you must plan for:
  - max_act_turns_per_step: 4
  - max_calls_per_turn_dependent: 1
  - max_calls_per_turn_independent: 2
  - max_total_tool_calls_per_step: 6
- NEVER use any path or tool listed in "Paths/tools NEVER to use again".
- If any approach failed, your new approach MUST differ from it — not just in wording.
- If the task asks for machine-wide file/path discovery, first discover valid roots (for example, home directory) instead of guessing paths like /home/user or /Documents.
- If there are 2 no-progress/missing-path outcomes in a row, pivot strategy (different roots or tool family such as shell) instead of retrying the same style search.
- Never claim "entire filesystem searched" unless your tool inputs explicitly included root-level paths for that OS.
- If you need full details for specific prior steps, request them via "inspect_steps" (max 2 step numbers).
- Pick exactly 1 next action. Reduce uncertainty first.
- If consecutiveFailures >= 2, radically change direction.
- If the task is complete, set done: true.
- Set tools_hint to the specific tool names the executor should use for the next step.
- The "summary" field in completion is the ACTUAL RESPONSE shown to the user. Write it as a helpful, natural reply — not a log or description of what happened.

Respond with a single JSON object (no markdown fences):
For next step: { "done": false, "goal_update": "...optional...", "approach_update": "...optional...", "approach_change_reason": "...optional...", "approach": "...", "execution_mode": "dependent" | "independent", "intent": "...", "type": "...", "tools_hint": [...], "success_criteria": "...", "context": "..." }
For inspection request: { "done": false, "inspect_steps": [2, 5], "inspect_reason": "...", "goal_update": "...optional...", "approach_update": "...optional..." }
For completion: { "done": true, "summary": "<your reply to the user>", "status": "completed" | "failed" }
For session rotation: { "done": false, "rotate_session": true, "reason": "...", "handoff_summary": "..." }`;
}

function truncateInline(value: string, maxLen: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}...`;
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

export function parseControllerResponse(text: string, currentApproach = ""): ControllerOutput {
  let jsonStr = text.trim();

  // Extract JSON from markdown fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    jsonStr = fenceMatch[1].trim();
  }

  const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

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

  if (Array.isArray(parsed["inspect_steps"])) {
    return {
      done: false,
      inspect_steps: (parsed["inspect_steps"] as unknown[])
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0),
      inspect_reason: toOptionalString(parsed["inspect_reason"]),
      approach: toOptionalString(parsed["approach"]),
      goal_update: toOptionalString(parsed["goal_update"]),
      approach_update: toOptionalString(parsed["approach_update"]),
      approach_change_reason: toOptionalString(parsed["approach_change_reason"]),
    };
  }

  return {
    done: false,
    approach: String(parsed["approach"] ?? currentApproach),
    execution_mode: normalizeExecutionMode(parsed["execution_mode"]),
    intent: String(parsed["intent"] ?? ""),
    type: String(parsed["type"] ?? ""),
    tools_hint: Array.isArray(parsed["tools_hint"])
      ? (parsed["tools_hint"] as unknown[]).map(String)
      : [],
    success_criteria: String(parsed["success_criteria"] ?? ""),
    context: String(parsed["context"] ?? ""),
    goal_update: toOptionalString(parsed["goal_update"]),
    approach_update: toOptionalString(parsed["approach_update"]),
    approach_change_reason: toOptionalString(parsed["approach_change_reason"]),
  };
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeExecutionMode(value: unknown): "dependent" | "independent" {
  if (value === "independent") return "independent";
  return "dependent";
}
