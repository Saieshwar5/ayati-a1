import { describe, expect, it } from "vitest";
import {
  buildValidationCompletionReceipts,
  MAX_VALIDATION_COMPLETION_RECEIPTS,
  mergeValidationCompletionReceipts,
} from "../../src/ivec/agent-runner/work-state/completion-receipts.js";
import type { ValidationCheckResult } from "../../src/ivec/agent-runner/task-validation-contracts.js";
import type { ImportantContextItem } from "../../src/ivec/agent-runner/work-state/contracts.js";

const RUN_ID = "RUN-COMPLETION";

describe("WorkState validation completion receipts", () => {
  it("creates one compact deterministic receipt for a verified complete read", () => {
    const receipts = buildValidationCompletionReceipts({
      runId: RUN_ID,
      checks: [passedCheck("file.read_complete", "/workspace/archive/garden-notes.txt", 2)],
    });

    expect(receipts).toEqual([{
      kind: "finding",
      value: "Verified a complete read of /workspace/archive/garden-notes.txt.",
      ref: `run:${RUN_ID}:step:2:call:call-2`,
    }]);
    expect(receipts[0]).not.toHaveProperty("tool");
    expect(receipts[0]).not.toHaveProperty("status");
    expect(receipts[0]).not.toHaveProperty("verification");
  });

  it("records the exact bounded read scope instead of claiming a complete read", () => {
    const receipts = buildValidationCompletionReceipts({
      runId: RUN_ID,
      checks: [{
        ...passedCheck("file.read_scope_satisfied", "/workspace/src/parser.ts", 3),
        readScope: {
          mode: "slice",
          startLine: 10,
          endLine: 14,
        },
      }],
    });

    expect(receipts).toEqual([{
      kind: "finding",
      value: "Verified a read of lines 10-14 from /workspace/src/parser.ts.",
      ref: `run:${RUN_ID}:step:3:call:call-3`,
    }]);
  });

  it("classifies durable outputs as artifacts and ignores unpassed checks", () => {
    const failed: ValidationCheckResult = {
      kind: "path.deleted",
      subject: "/workspace/old.txt",
      status: "failed",
      message: "No proof.",
    };
    const receipts = buildValidationCompletionReceipts({
      runId: RUN_ID,
      checks: [
        failed,
        passedCheck("file.written", "/workspace/result.txt", 4),
        passedCheck("artifact.available", "artifact:report-1", 5),
      ],
    });

    expect(receipts).toEqual([
      {
        kind: "artifact",
        value: "Verified the written file /workspace/result.txt.",
        ref: `run:${RUN_ID}:step:4:call:call-4`,
      },
      {
        kind: "artifact",
        value: "Verified the available artifact artifact:report-1.",
        ref: `run:${RUN_ID}:step:5:call:call-5`,
      },
    ]);
  });

  it("deduplicates receipts, caps validation additions, and preserves bounded prior context", () => {
    const existing: ImportantContextItem[] = Array.from(
      { length: 10 },
      (_, index) => ({
        kind: "decision" as const,
        value: `Existing decision ${index + 1}.`,
      }),
    );
    const checks = Array.from(
      { length: MAX_VALIDATION_COMPLETION_RECEIPTS + 2 },
      (_, index) => passedCheck(
        "path.exists",
        `/workspace/output-${index + 1}.txt`,
        index + 1,
      ),
    );
    checks.splice(1, 0, checks[0]!);

    const merged = mergeValidationCompletionReceipts({
      runId: RUN_ID,
      importantContext: existing,
      checks,
    });

    expect(merged).toHaveLength(12);
    expect(merged.slice(0, 8)).toEqual(existing.slice(0, 8));
    expect(merged.slice(8)).toEqual([
      expect.objectContaining({
        value: "Verified that /workspace/output-1.txt exists as a file.",
      }),
      expect.objectContaining({
        value: "Verified that /workspace/output-2.txt exists as a file.",
      }),
      expect.objectContaining({
        value: "Verified that /workspace/output-3.txt exists as a file.",
      }),
      expect.objectContaining({
        value: "Verified that /workspace/output-4.txt exists as a file.",
      }),
    ]);
  });

  it("uses the exact satisfying proof reference when validation provides one", () => {
    const check = passedCheck("process.exit_success", "pnpm test", 6);
    check.satisfiedBy = {
      ...check.satisfiedBy!,
      ref: "evidence:exact-test-run",
    };

    expect(buildValidationCompletionReceipts({
      runId: RUN_ID,
      checks: [check],
    })).toEqual([{
      kind: "finding",
      value: "Verified successful process completion for pnpm test.",
      ref: "evidence:exact-test-run",
    }]);
  });

  it("never stores a truncated proof reference", () => {
    const check = passedCheck("path.exists", "/workspace/result.txt", 7);
    check.satisfiedBy = {
      ...check.satisfiedBy!,
      ref: "evidence:" + "x".repeat(600),
    };

    expect(buildValidationCompletionReceipts({
      runId: RUN_ID,
      checks: [check],
    })).toEqual([]);
  });
});

function passedCheck(
  kind: ValidationCheckResult["kind"],
  subject: string,
  step: number,
): ValidationCheckResult {
  return {
    kind,
    subject,
    expectedKind: kind.startsWith("file.") || kind.startsWith("path.")
      ? "file"
      : undefined,
    status: "passed",
    actualKind: kind.startsWith("file.") || kind.startsWith("path.")
      ? "file"
      : undefined,
    tool: "fixture_tool",
    message: "Confirmed from deterministic proof.",
    satisfiedBy: {
      step,
      callId: `call-${step}`,
      tool: "fixture_tool",
      ref: `run:${RUN_ID}:step:${step}:call:call-${step}`,
    },
  };
}
