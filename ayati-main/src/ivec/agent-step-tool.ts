import type { LlmToolSchema } from "../core/contracts/llm-protocol.js";
import type { AgentStepInput, ScratchpadEntry } from "./agent-loop-types.js";

export const AGENT_STEP_TOOL_NAME = "agent_step";

const VALID_PHASES = new Set(["reason", "act", "verify", "reflect", "feedback", "end"]);
const VALID_END_STATUSES = new Set(["solved", "partial", "stuck"]);

export const AGENT_STEP_TOOL_SCHEMA: LlmToolSchema = {
  name: AGENT_STEP_TOOL_NAME,
  description:
    "Declare your current reasoning phase, thinking, and optional action. " +
    "You MUST call this tool every step of your agent loop.",
  inputSchema: {
    type: "object",
    properties: {
      phase: {
        type: "string",
        enum: ["reason", "act", "verify", "reflect", "feedback", "end"],
        description: "Current phase of the agent loop.",
      },
      thinking: {
        type: "string",
        description: "Your private reasoning for this step.",
      },
      summary: {
        type: "string",
        description: "A short public summary of what this step does.",
      },
      action: {
        type: "object",
        description: "Required when phase is 'act'. The tool to execute.",
        properties: {
          tool_name: { type: "string", description: "Name of the tool to call." },
          tool_input: { type: "object", description: "Input for the tool." },
        },
        required: ["tool_name", "tool_input"],
      },
      feedback_message: {
        type: "string",
        description: "Required when phase is 'feedback'. Message to show the user.",
      },
      end_status: {
        type: "string",
        enum: ["solved", "partial", "stuck"],
        description: "Required when phase is 'end'. Outcome status.",
      },
      end_message: {
        type: "string",
        description: "Required when phase is 'end'. Final message to the user.",
      },
      approaches_tried: {
        type: "array",
        items: { type: "string" },
        description: "Approaches tried so far (used in reflect phase).",
      },
    },
    required: ["phase", "thinking", "summary"],
  },
};

export function parseAgentStep(input: unknown): AgentStepInput | null {
  if (!input || typeof input !== "object") return null;

  const raw = input as Record<string, unknown>;

  const phase = raw["phase"];
  if (typeof phase !== "string" || !VALID_PHASES.has(phase)) return null;

  const thinking = raw["thinking"];
  if (typeof thinking !== "string") return null;

  const summary = typeof raw["summary"] === "string" ? raw["summary"] : "";

  const result: AgentStepInput = {
    phase: phase as AgentStepInput["phase"],
    thinking,
    summary,
  };

  if (phase === "act") {
    const action = raw["action"];
    if (!action || typeof action !== "object") return null;
    const act = action as Record<string, unknown>;
    if (typeof act["tool_name"] !== "string") return null;
    result.action = {
      tool_name: act["tool_name"],
      tool_input: act["tool_input"] ?? {},
    };
  }

  if (phase === "feedback") {
    if (typeof raw["feedback_message"] !== "string") return null;
    result.feedback_message = raw["feedback_message"];
  }

  if (phase === "end") {
    if (typeof raw["end_message"] !== "string") return null;
    result.end_message = raw["end_message"];
    const endStatus = raw["end_status"];
    if (typeof endStatus === "string" && VALID_END_STATUSES.has(endStatus)) {
      result.end_status = endStatus as AgentStepInput["end_status"];
    } else {
      result.end_status = "solved";
    }
  }

  if (Array.isArray(raw["approaches_tried"])) {
    result.approaches_tried = (raw["approaches_tried"] as unknown[])
      .filter((item): item is string => typeof item === "string");
  }

  return result;
}

const SCRATCHPAD_KEEP_FIRST = 2;
const SCRATCHPAD_KEEP_LAST = 3;
const SCRATCHPAD_TRUNCATE_THRESHOLD = 8;

export function buildScratchpadBlock(
  entries: ScratchpadEntry[],
  approaches: Set<string>,
): string {
  if (entries.length === 0 && approaches.size === 0) {
    return "[Scratchpad: empty]";
  }

  const lines: string[] = ["--- Scratchpad ---"];

  if (approaches.size > 0) {
    lines.push(`Approaches tried: ${[...approaches].join(", ")}`);
  }

  let visible: ScratchpadEntry[];
  if (entries.length > SCRATCHPAD_TRUNCATE_THRESHOLD) {
    const first = entries.slice(0, SCRATCHPAD_KEEP_FIRST);
    const last = entries.slice(-SCRATCHPAD_KEEP_LAST);
    const omitted = entries.length - SCRATCHPAD_KEEP_FIRST - SCRATCHPAD_KEEP_LAST;
    visible = [...first, ...last];
    lines.push(`(${omitted} intermediate steps omitted)`);
  } else {
    visible = entries;
  }

  for (const entry of visible) {
    lines.push(`[Step ${entry.step}] ${entry.phase.toUpperCase()}: ${entry.summary}`);
    if (entry.toolResult) {
      const preview = entry.toolResult.length > 300
        ? entry.toolResult.slice(0, 300) + "...[truncated]"
        : entry.toolResult;
      lines.push(`  Result: ${preview}`);
    }
  }

  lines.push("--- End Scratchpad ---");
  return lines.join("\n");
}
