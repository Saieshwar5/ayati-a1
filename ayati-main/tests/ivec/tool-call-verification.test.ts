import { describe, expect, it } from "vitest";
import {
  deriveToolCallVerification,
  toolCallVerificationPassed,
} from "../../src/ivec/agent-runner/tool-call-verification.js";

describe("per-call deterministic verification", () => {
  it("normalizes passed tool-contract checks and facts", () => {
    const verification = deriveToolCallVerification({
      tool: "read_files",
      input: { files: [{ path: "/tmp/report.txt" }] },
      output: "report contents",
      operationStatus: "succeeded",
      result: {
        transportOk: true,
        operationStatus: "succeeded",
        code: "FILES_READ",
        message: "Read file.",
        verification: {
          status: "passed",
          summary: "Tool contract passed for read_files.",
          assertions: [{
            id: "complete_read",
            kind: "json_path_equals",
            status: "passed",
            severity: "required",
            message: "Complete coverage was returned.",
          }],
          facts: [{
            kind: "file_read",
            message: "File read by read_files.",
            path: "/tmp/report.txt",
            data: { coverage: "complete" },
          }],
          artifacts: [],
        },
      },
    });

    expect(verification).toEqual({
      version: 1,
      status: "passed",
      method: "tool_contract",
      contract: "tool_result_v2",
      summary: "Tool contract passed for read_files.",
      checks: [{
        id: "complete_read",
        kind: "json_path_equals",
        status: "passed",
        severity: "required",
      }],
      facts: [{
        kind: "file_read",
        message: "File read by read_files.",
        subject: "/tmp/report.txt",
        data: { coverage: "complete" },
      }],
    });
  });

  it("records execution failure without creating verified facts", () => {
    const verification = deriveToolCallVerification({
      tool: "read_files",
      input: {},
      output: "",
      error: "File not found.",
      code: "FILE_NOT_FOUND",
    });

    expect(verification).toMatchObject({
      status: "failed",
      method: "execution_only",
      checks: [],
      facts: [],
      failure: {
        code: "FILE_NOT_FOUND",
        message: "File not found.",
      },
    });
  });

  it("uses the existing deterministic runtime gate for supported legacy tools", () => {
    const verification = deriveToolCallVerification({
      tool: "dataset_query",
      purpose: "Return the item count.",
      input: { sql: "select count(*) from items" },
      output: JSON.stringify({
        rows: [{ count: 2 }],
        rowCount: 1,
        columns: ["count"],
      }),
    });

    expect(verification).toMatchObject({
      status: "passed",
      method: "runtime_check",
      contract: "deterministic_success_gate_v1",
      checks: [{
        id: "deterministic_success_gate",
        status: "passed",
      }],
    });
  });

  it("does not treat an error-free unsupported call as deterministically verified", () => {
    const verification = deriveToolCallVerification({
      tool: "custom_external_tool",
      input: {},
      output: "accepted",
    });

    expect(verification).toMatchObject({
      status: "not_available",
      method: "execution_only",
      checks: [],
      facts: [],
    });
    expect(toolCallVerificationPassed({ verification, verificationPassed: true })).toBe(false);
  });

  it("uses legacy verification only when no per-call record exists", () => {
    expect(toolCallVerificationPassed({ verificationPassed: true })).toBe(true);
    expect(toolCallVerificationPassed({ verificationPassed: false })).toBe(false);
  });
});
