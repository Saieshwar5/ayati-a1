import type { LlmMessage, LlmToolSchema } from "../core/contracts/llm-protocol.js";
import type { ControllerHistoryBundle, RunStateManager, StepFullResult, SummaryWindowResult } from "./run-state-manager.js";

const MAX_WINDOW_STEPS = 10;
const MAX_TOOL_CALLS_PER_RUN = 10;
const MAX_RETRIEVED_CONTEXT_CHARS = 16_000;

export interface ControllerToolRuntime {
  readonly tools: LlmToolSchema[];
  readonly maxCallsPerRun: number;
  getUsedCalls(): number;
  recordToolCall(): { used: number; remaining: number };
  executeTool(name: string, input: unknown): Promise<string>;
  compressMessages(messages: LlmMessage[]): LlmMessage[];
}

type StateManagementInput =
  | {
      action: "read_summary_window";
      window: {
        from: number;
        to: number;
      };
    }
  | {
      action: "read_step_full";
      step: number;
    };

export const STATE_MANAGEMENT_TOOL_SCHEMA: LlmToolSchema = {
  name: "state_management",
  description: "Controller-only run state retrieval. Read step summary windows by explicit step range or read one full step when more context is needed.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        description: "One of: read_summary_window, read_step_full.",
      },
      window: {
        type: "object",
        description: "Explicit inclusive step range for summary retrieval.",
        properties: {
          from: { type: "number", description: "Starting step number (inclusive)." },
          to: { type: "number", description: "Ending step number (inclusive)." },
        },
      },
      step: {
        type: "number",
        description: "Single step number to read in full.",
      },
    },
  },
};

export function createControllerStateToolRuntime(
  runStateManager: RunStateManager,
): ControllerToolRuntime {
  let usedCalls = 0;

  return {
    tools: [STATE_MANAGEMENT_TOOL_SCHEMA],
    maxCallsPerRun: MAX_TOOL_CALLS_PER_RUN,
    getUsedCalls(): number {
      return usedCalls;
    },
    recordToolCall(): { used: number; remaining: number } {
      usedCalls++;
      return {
        used: usedCalls,
        remaining: Math.max(0, MAX_TOOL_CALLS_PER_RUN - usedCalls),
      };
    },
    async executeTool(name: string, input: unknown): Promise<string> {
      if (name !== STATE_MANAGEMENT_TOOL_SCHEMA.name) {
        return JSON.stringify({ ok: false, error: `Unknown controller tool: ${name}` }, null, 2);
      }

      const parsed = parseInput(input);
      if ("error" in parsed) {
        return JSON.stringify({ ok: false, error: parsed.error }, null, 2);
      }

      if (parsed.action === "read_summary_window") {
        const result = await runStateManager.readSummaryWindow(parsed.window);
        return JSON.stringify(formatSummaryWindowPayload(result), null, 2);
      }

      const result = await runStateManager.readStepFull(parsed.step);
      if (!result) {
        return JSON.stringify({
          ok: false,
          action: "read_step_full",
          step: parsed.step,
          error: `Step ${parsed.step} was not found in the active run.`,
        }, null, 2);
      }
      return JSON.stringify(formatFullStepPayload(result), null, 2);
    },
    compressMessages(messages: LlmMessage[]): LlmMessage[] {
      return compressStateToolMessages(messages);
    },
  };
}

export function formatControllerHistoryBundle(bundle: ControllerHistoryBundle): string {
  const recentStepDigests = bundle.recentStepDigests ?? [];
  const recentDigests = recentStepDigests.length > 0
    ? recentStepDigests.map((step) => [
      `  - Step ${step.step}: ${step.executionContract || "(no contract)"} [${step.outcome}]`,
      `    summary=${truncate(step.summary, 220)}`,
      `    keyFacts=${formatList(step.keyFacts)}`,
      `    evidence=${formatList(step.evidence)}`,
      `    artifacts=${formatList(step.artifacts)}`,
      `    blockedTargets=${formatList(step.blockedTargets)}`,
      `    toolCounts=success:${step.toolSuccessCount}, failed:${step.toolFailureCount}${step.stoppedEarlyReason ? `, stop:${step.stoppedEarlyReason}` : ""}`,
    ].join("\n")).join("\n")
    : "  - none";

  return [
    "Automatic run state context:",
    `Current Step Count: ${bundle.currentStepCount ?? 0}`,
    "",
    "Latest completed step full text:",
    bundle.latestCompletedStepFullText?.trim().length
      ? bundle.latestCompletedStepFullText
      : "(none yet)",
    "",
    "Previous 3-4 completed step digests:",
    recentDigests,
  ].join("\n");
}

function parseInput(input: unknown): StateManagementInput | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "Input must be an object." };
  }
  const value = input as Record<string, unknown>;
  if (value["action"] === "read_summary_window") {
    const window = value["window"];
    if (!window || typeof window !== "object" || Array.isArray(window)) {
      return { error: "read_summary_window requires a window object." };
    }
    const from = Number((window as Record<string, unknown>)["from"]);
    const to = Number((window as Record<string, unknown>)["to"]);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      return { error: "window.from and window.to must be integers." };
    }
    if (Math.abs(to - from) + 1 > MAX_WINDOW_STEPS) {
      return { error: `Summary window size cannot exceed ${MAX_WINDOW_STEPS} steps.` };
    }
    return {
      action: "read_summary_window",
      window: { from, to },
    };
  }
  if (value["action"] === "read_step_full") {
    const step = Number(value["step"]);
    if (!Number.isInteger(step) || step <= 0) {
      return { error: "read_step_full requires a positive integer step." };
    }
    return {
      action: "read_step_full",
      step,
    };
  }
  return { error: "Unsupported action. Use read_summary_window or read_step_full." };
}

function formatSummaryWindowPayload(result: SummaryWindowResult): Record<string, unknown> {
  return {
    ok: true,
    action: "read_summary_window",
    window: result.window,
    steps: result.steps,
  };
}

function formatFullStepPayload(result: StepFullResult): Record<string, unknown> {
  return {
    ok: true,
    action: "read_step_full",
    step: result.step,
    record: result.record,
    fullStepText: result.fullStepText,
  };
}

function compressStateToolMessages(messages: LlmMessage[]): LlmMessage[] {
  let totalChars = messages.reduce((sum, message) => {
    if (
      message.role !== "tool"
      || message.name !== STATE_MANAGEMENT_TOOL_SCHEMA.name
    ) {
      return sum;
    }
    return sum + message.content.length;
  }, 0);

  if (totalChars <= MAX_RETRIEVED_CONTEXT_CHARS) {
    return messages;
  }

  return messages.map((message) => {
    if (
      message.role !== "tool"
      || message.name !== STATE_MANAGEMENT_TOOL_SCHEMA.name
    ) {
      return message;
    }
    if (totalChars <= MAX_RETRIEVED_CONTEXT_CHARS) {
      return message;
    }
    const compressedContent = compressToolPayload(message.content);
    totalChars -= Math.max(0, message.content.length - compressedContent.length);
    return {
      ...message,
      content: compressedContent,
    };
  });
}

function compressToolPayload(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed["action"] === "read_summary_window" && Array.isArray(parsed["steps"])) {
      const lines = (parsed["steps"] as Array<Record<string, unknown>>).map((step) => {
        const stepNumber = step["step"];
        const executionContract = truncate(String(step["executionContract"] ?? ""), 120);
        const outcome = String(step["outcome"] ?? "");
        const summary = truncate(String(step["summary"] ?? ""), 180);
        const keyFacts = formatList(asStringArray(step["keyFacts"]).slice(0, 3));
        const evidence = formatList(asStringArray(step["evidence"]).slice(0, 3));
        return `step=${stepNumber} contract=${executionContract} outcome=${outcome} summary=${summary} keyFacts=${keyFacts} evidence=${evidence}`;
      });
      return [
        "Compressed retrieved summary window:",
        `window=${JSON.stringify(parsed["window"] ?? {})}`,
        ...lines,
      ].join("\n");
    }

    if (parsed["action"] === "read_step_full" && parsed["record"] && typeof parsed["record"] === "object") {
      const record = parsed["record"] as Record<string, unknown>;
      return [
        "Compressed retrieved full step:",
        `step=${record["step"] ?? parsed["step"] ?? "unknown"}`,
        `executionContract=${truncate(String(record["executionContract"] ?? ""), 140)}`,
        `outcome=${String(record["outcome"] ?? "")}`,
        `summary=${truncate(String(record["summary"] ?? ""), 220)}`,
        `keyFacts=${formatList(asStringArray(record["newFacts"]).slice(0, 4))}`,
        `evidence=${formatList(asStringArray(record["evidenceItems"]).slice(0, 4))}`,
        `blockedTargets=${formatList(asStringArray(record["blockedTargets"]).slice(0, 4))}`,
      ].join("\n");
    }
  } catch {
    // Fall through to truncation below.
  }
  return truncate(content, 1_400);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter((item) => item.trim().length > 0) : [];
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(" | ") : "(none)";
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}
