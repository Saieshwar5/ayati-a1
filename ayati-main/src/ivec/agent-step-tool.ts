import type { LlmToolSchema } from "../core/contracts/llm-protocol.js";
import type { AgentStepInput } from "./agent-loop-types.js";

export const AGENT_STEP_TOOL_NAME = "agent_step";

const VALID_PHASES = new Set(["reason", "plan", "act", "verify", "reflect", "feedback", "end"]);
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
        enum: ["reason", "plan", "act", "verify", "reflect", "feedback", "end"],
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
      plan: {
        type: "object",
        description: "Required when phase is 'plan'. Structured plan for this task.",
        properties: {
          goal: { type: "string", description: "The overall goal of this task." },
          sub_tasks: {
            type: "array",
            description: "Ordered list of sub-tasks to accomplish the goal.",
            items: {
              type: "object",
              properties: {
                id: { type: "number", description: "Unique sub-task id." },
                title: { type: "string", description: "Short title for this sub-task." },
                depends_on: {
                  type: "array",
                  items: { type: "number" },
                  description: "Ids of sub-tasks that must be done before this one.",
                },
              },
              required: ["id", "title"],
            },
          },
        },
        required: ["goal", "sub_tasks"],
      },
      action: {
        type: "object",
        description: "Required when phase is 'act'. The tool to execute.",
        properties: {
          tool_name: { type: "string", description: "Name of the tool to call." },
          tool_input: {
            type: "object",
            description: "REQUIRED. Must contain ALL required fields for the named tool. Check the tool's own parameter list carefully — do not send an empty object.",
          },
        },
        required: ["tool_name", "tool_input"],
      },
      key_facts: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional. Use during 'verify' phase. Facts learned from the last action " +
          "that should be remembered for future steps.",
      },
      sub_task_outcome: {
        type: "string",
        enum: ["done", "failed"],
        description:
          "Optional. Use during 'verify' phase. Mark the current plan sub-task as done or failed.",
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

  if (phase === "plan") {
    const planRaw = raw["plan"];
    if (!planRaw || typeof planRaw !== "object") return null;
    const p = planRaw as Record<string, unknown>;
    if (typeof p["goal"] !== "string") return null;
    if (!Array.isArray(p["sub_tasks"])) return null;
    result.plan = {
      goal: p["goal"],
      sub_tasks: (p["sub_tasks"] as unknown[]).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const t = item as Record<string, unknown>;
        if (typeof t["id"] !== "number" || typeof t["title"] !== "string") return [];
        const subTask: { id: number; title: string; depends_on?: number[] } = {
          id: t["id"],
          title: t["title"],
        };
        if (Array.isArray(t["depends_on"])) {
          subTask.depends_on = (t["depends_on"] as unknown[]).filter(
            (d): d is number => typeof d === "number",
          );
        }
        return [subTask];
      }),
    };
  }

  if (phase === "act") {
    const action = raw["action"];
    if (!action || typeof action !== "object") return null;
    const act = action as Record<string, unknown>;
    if (typeof act["tool_name"] !== "string") return null;
    if (!act["tool_input"] || typeof act["tool_input"] !== "object" || Array.isArray(act["tool_input"])) return null;
    result.action = {
      tool_name: act["tool_name"],
      tool_input: act["tool_input"],
    };
  }

  if (phase === "verify") {
    if (Array.isArray(raw["key_facts"])) {
      result.key_facts = (raw["key_facts"] as unknown[]).filter(
        (item): item is string => typeof item === "string",
      );
    }
    const outcome = raw["sub_task_outcome"];
    if (outcome === "done" || outcome === "failed") {
      result.sub_task_outcome = outcome;
    }
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

  return result;
}
