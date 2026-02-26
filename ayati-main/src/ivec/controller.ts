import type { LlmProvider } from "../core/contracts/provider.js";
import type { ToolDefinition } from "../skills/types.js";
import type { LoopState, ControllerOutput, SessionRotationDirective } from "./types.js";
import { buildToolCatalog } from "./tool-catalog.js";

export async function callController(
  provider: LlmProvider,
  state: LoopState,
  toolDefinitions: ToolDefinition[],
  systemContext?: string,
): Promise<ControllerOutput> {
  const prompt = buildControllerPrompt(state, toolDefinitions);
  const messages = systemContext
    ? [
        { role: "system" as const, content: systemContext },
        { role: "user" as const, content: prompt },
      ]
    : [{ role: "user" as const, content: prompt }];

  const turn = await provider.generateTurn({ messages });

  const text = turn.type === "assistant" ? turn.content : "";
  return parseControllerResponse(text);
}

function buildControllerPrompt(state: LoopState, toolDefinitions: ToolDefinition[]): string {
  const stepHistory = state.completedSteps
    .slice(-5)
    .map((s) => {
      let line = `  Step ${s.step}: [${s.outcome}] ${s.intent}`;
      if (s.summary) line += `\n    Result: ${s.summary.slice(0, 300)}`;
      else if (s.evidence) line += `\n    Evidence: ${s.evidence.slice(0, 300)}`;
      return line;
    })
    .join("\n");

  const factsBlock = state.facts.length > 0
    ? `Known facts:\n${state.facts.map((f) => `  - ${f}`).join("\n")}`
    : "Known facts: none yet";

  const uncertainBlock = state.uncertainties.length > 0
    ? `Uncertainties:\n${state.uncertainties.map((u) => `  - ${u}`).join("\n")}`
    : "";

  const toolCatalog = buildToolCatalog(toolDefinitions);

  return `You are a controller deciding the next step for an AI agent.

User request: ${state.userMessage}
Goal: ${state.goal}
Approach: ${state.approach}

${factsBlock}
${uncertainBlock}

Completed steps (${state.completedSteps.length} total):
${stepHistory || "  (none yet)"}

Consecutive failures: ${state.consecutiveFailures}
Iteration: ${state.iteration} / ${state.maxIterations}

${toolCatalog}

Instructions:
- If the user's message is casual conversation (greeting, small talk, simple question that needs no tools), respond immediately with done: true. Write the summary as a natural, friendly reply — this is shown directly to the user.
- If the task requires tool use, pick exactly 1 next action. Reduce uncertainty first.
- If ${state.consecutiveFailures} >= 3, change approach.
- If the task is complete, set done: true.
- Set tools_hint to the specific tool names the executor should use for the next step.
- The "summary" field in completion is the ACTUAL RESPONSE shown to the user. Write it as a helpful, natural reply — not a log or description of what happened.

Respond with a single JSON object (no markdown fences):
For next step: { "done": false, "intent": "...", "type": "...", "tools_hint": [...], "success_criteria": "...", "context": "..." }
For completion: { "done": true, "summary": "<your reply to the user>", "status": "completed" | "failed" }
For session rotation: { "done": false, "rotate_session": true, "reason": "...", "handoff_summary": "..." }`;
}

export function parseControllerResponse(text: string): ControllerOutput {
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

  return {
    done: false,
    intent: String(parsed["intent"] ?? ""),
    type: String(parsed["type"] ?? ""),
    tools_hint: Array.isArray(parsed["tools_hint"])
      ? (parsed["tools_hint"] as unknown[]).map(String)
      : [],
    success_criteria: String(parsed["success_criteria"] ?? ""),
    context: String(parsed["context"] ?? ""),
  };
}
