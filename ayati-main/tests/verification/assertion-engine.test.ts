import { describe, expect, it } from "vitest";
import { runAssertions } from "../../src/verification/assertion-engine.js";
import type { ToolContractAssertion, ToolResultV2 } from "../../src/skills/types.js";

const successfulResult: ToolResultV2 = {
  transportOk: true,
  operationStatus: "succeeded",
  code: "OK",
  message: "ok",
  structuredContent: {},
};

describe("runAssertions", () => {
  it("fails unsupported assertion kinds without throwing", async () => {
    const assertion = {
      id: "model_invented_check",
      kind: "html_contains",
      text: "Organic Vegetables",
    } as unknown as ToolContractAssertion;

    const result = await runAssertions([assertion], {
      toolName: "write_files",
      input: {},
      result: successfulResult,
    });

    expect(result.status).toBe("failed");
    expect(result.assertions).toHaveLength(1);
    expect(result.assertions[0]).toMatchObject({
      id: "model_invented_check",
      kind: "html_contains",
      status: "failed",
      severity: "required",
      message: "Unsupported assertion kind: html_contains.",
      error: {
        code: "UNSUPPORTED_ASSERTION",
        category: "validation",
        retryable: false,
      },
    });
  });

  it("fails missing assertion kinds without throwing", async () => {
    const assertion = {
      id: "missing_kind_check",
    } as unknown as ToolContractAssertion;

    const result = await runAssertions([assertion], {
      toolName: "write_files",
      input: {},
      result: successfulResult,
    });

    expect(result.status).toBe("failed");
    expect(result.assertions[0]).toMatchObject({
      id: "missing_kind_check",
      kind: "unsupported_assertion",
      status: "failed",
      message: "Unsupported assertion kind: missing.",
      actual: "missing",
    });
  });
});
