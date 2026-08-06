import { describe, it, expect } from "vitest";
import {
  checkDeterministicSuccessGate,
  checkVerificationGates,
  isDeterministicSuccessTool,
} from "../../src/ivec/verification-gates.js";
import type { ActOutput } from "../../src/ivec/types.js";

describe("checkVerificationGates", () => {
  it("returns an execution failure when all tool calls fail", () => {
    const actOutput: ActOutput = {
      toolCalls: [
        { tool: "process_run", input: {}, output: "", error: "command not found" },
      ],
      finalText: "",
    };
    const result = checkVerificationGates(actOutput);
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
    expect(result!.method).toBe("execution_gate");
    expect(result!.executionStatus).toBe("all_failed");
    expect(result!.validationStatus).toBe("skipped");
    expect(result!.evidenceSummary).toContain("command not found");
  });

  it("returns null when execution succeeded and LLM validation should decide", () => {
    const actOutput: ActOutput = {
      toolCalls: [
        { tool: "process_run", input: {}, output: "hello" },
        { tool: "read", input: {}, output: "content" },
      ],
      finalText: "",
    };
    const result = checkVerificationGates(actOutput);
    expect(result).toBeNull();
  });

  it("returns null when no tools ran but assistant text exists for validation", () => {
    const actOutput: ActOutput = {
      toolCalls: [],
      finalText: "Here is your answer.",
    };
    const result = checkVerificationGates(actOutput);
    expect(result).toBeNull();
  });

  it("returns null when there is partial execution success", () => {
    const actOutput: ActOutput = {
      toolCalls: [
        { tool: "process_run", input: {}, output: "ok" },
        { tool: "read", input: {}, output: "", error: "file not found" },
      ],
      finalText: "",
    };
    const result = checkVerificationGates(actOutput);
    expect(result).toBeNull();
  });

  it("returns an execution failure for empty act output", () => {
    const actOutput: ActOutput = {
      toolCalls: [],
      finalText: "",
    };
    const result = checkVerificationGates(actOutput);
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
    expect(result!.executionStatus).toBe("no_tools");
    expect(result!.validationStatus).toBe("skipped");
  });

  it("does not make content-judgment decisions like discovery success or failure", () => {
    const actOutput: ActOutput = {
      toolCalls: [
        { tool: "find_files", input: { query: "learn1.go" }, output: "(no matches)" },
      ],
      finalText: "",
    };

    const result = checkVerificationGates(actOutput);
    expect(result).toBeNull();
  });
});

describe("checkDeterministicSuccessGate", () => {
  it("passes deterministic managed-table query results without LLM validation", () => {
    const actOutput: ActOutput = {
      toolCalls: [{
        tool: "file_query_table",
        input: { fileId: "file_employees", sql: "SELECT COUNT(*) AS count FROM file_data" },
        output: JSON.stringify({
          fileId: "file_employees",
          rows: [{ count: 2 }],
          rowCount: 1,
          columns: ["count"],
        }),
      }],
      finalText: "",
    };

    const result = checkDeterministicSuccessGate(actOutput, "table query returns the count");

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
    expect(result!.method).toBe("script");
    expect(result!.evidenceSummary).toContain("file_query_table succeeded");
    expect(result!.evidenceSummary).toContain("count=1");
  });

  it("passes unified attachment restore results without LLM validation", () => {
    const actOutput: ActOutput = {
      toolCalls: [{
        tool: "attachment_restore",
        input: { reference: "file_1234567890abcdef" },
        output: JSON.stringify({
          restored: true,
          attachmentKind: "file",
          attachmentId: "file_1234567890abcdef",
          fileId: "file_1234567890abcdef",
          displayName: "policy.txt",
          kind: "txt",
          mode: "file",
        }),
      }],
      finalText: "",
    };

    const result = checkDeterministicSuccessGate(actOutput, "restore the previous attachment");

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
    expect(result!.evidenceSummary).toContain("attachment_restore succeeded");
  });

  it("passes managed-file query results but rejects malformed results", () => {
    const valid: ActOutput = {
      toolCalls: [{
        tool: "file_query",
        input: { fileId: "file_policy", query: "identity" },
        output: JSON.stringify({
          fileId: "file_policy",
          matchCount: 1,
          matches: [{ text: "Identity and isolation." }],
        }),
      }],
      finalText: "",
    };
    const malformed: ActOutput = {
      toolCalls: [{
        tool: "file_query",
        input: { fileId: "file_policy", query: "identity" },
        output: JSON.stringify({ fileId: "file_policy" }),
      }],
      finalText: "",
    };

    expect(checkDeterministicSuccessGate(valid, "file query returns matches")).not.toBeNull();
    expect(checkDeterministicSuccessGate(malformed, "file query returns matches")).toBeNull();
  });

  it("does not treat send_email as a deterministic built-in verification tool", () => {
    const actOutput: ActOutput = {
      toolCalls: [{
        tool: "send_email",
        input: { to: "demo@example.com" },
        output: "sent",
      }],
      finalText: "",
    };

    expect(isDeterministicSuccessTool("send_email")).toBe(false);
    expect(checkDeterministicSuccessGate(actOutput, "email is sent")).toBeNull();
  });
});
