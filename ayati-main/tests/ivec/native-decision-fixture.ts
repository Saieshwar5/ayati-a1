import type { LlmToolCall, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";

export function nativeDecisionFixture(response: unknown): LlmTurnOutput {
  const parsed = parseDecision(response);
  if (!parsed) {
    return {
      type: "assistant",
      content: typeof response === "string" ? response : JSON.stringify(response),
    };
  }

  switch (parsed["kind"]) {
    case "reply":
      return {
        type: "assistant",
        content: typeof parsed["message"] === "string" ? parsed["message"] : "",
      };
    case "ask_user":
      return toolTurn("ask_user_feedback", {
        question: parsed["question"],
        reason: parsed["reason"],
        ...(parsed["workingNotes"] ? { workingNotes: parsed["workingNotes"] } : {}),
      });
    case "load_tools": {
      const request = objectRecord(parsed["request"]);
      return toolTurn("decision_load_tools", {
        ...request,
        ...(parsed["workingNotes"] ? { workingNotes: parsed["workingNotes"] } : {}),
      });
    }
    case "workstream_completion": {
      const request = objectRecord(parsed["request"]);
      return toolTurn("workstream_completion", {
        summary: request["summary"],
        resources: request["resources"] ?? request["assets"],
        ...(parsed["workingNotes"] ? { workingNotes: parsed["workingNotes"] } : {}),
      });
    }
    case "resolve_workstream": {
      const request = objectRecord(parsed["request"]);
      return toolTurn("workstream_resolve", {
        purpose: request["purpose"],
        hints: request["hints"] ?? [],
        ...(parsed["workingNotes"] ? { workingNotes: parsed["workingNotes"] } : {}),
      });
    }
    case "act":
      return actionTurn(parsed);
    default:
      return {
        type: "assistant",
        content: typeof response === "string" ? response : JSON.stringify(response),
      };
  }
}

function actionTurn(decision: Record<string, unknown>): LlmTurnOutput {
  const action = objectRecord(decision["action"]);
  const calls = Array.isArray(action["calls"]) ? action["calls"] : [];
  return {
    type: "tool_calls",
    calls: calls.map((value, index): LlmToolCall => {
      const call = objectRecord(value);
      const input = objectRecord(call["input"]);
      return {
        id: typeof call["id"] === "string" ? call["id"] : `fixture_call_${index + 1}`,
        name: typeof call["tool"] === "string" ? call["tool"] : "",
        input: {
          ...input,
          ...(call["purpose"] === undefined ? {} : { purpose: call["purpose"] }),
        },
      };
    }),
  };
}

function toolTurn(name: string, input: Record<string, unknown>): LlmTurnOutput {
  return {
    type: "tool_calls",
    calls: [{ id: `fixture_${name}`, name, input }],
  };
}

function parseDecision(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
