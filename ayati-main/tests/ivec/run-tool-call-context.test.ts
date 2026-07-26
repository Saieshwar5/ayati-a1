import { describe, expect, it } from "vitest";
import {
  buildPromptToolCallsForRun,
  compactPromptToolCall,
} from "../../src/ivec/agent-runner/run-tool-call-context.js";
import type { RunToolCallContext } from "../../src/ivec/types.js";

describe("run tool-call prompt context", () => {
  it("preserves exact inputs and outputs while removing detailed verification", () => {
    const content = "export const generated = true;\n".repeat(1_000);
    const output = JSON.stringify({
      requested: 1,
      succeeded: 1,
      files: [{
        path: "/workspace/src/generated.ts",
        operation: "created",
        bytesWritten: content.length,
      }],
    });
    const calls = buildPromptToolCallsForRun([{
      step: 2,
      callId: "write-generated",
      tool: "write_files",
      purpose: "Create the generated source file.",
      input: {
        files: [{
          path: "/workspace/src/generated.ts",
          content,
        }],
      },
      status: "success",
      output,
      hasMore: false,
      rawOutputChars: output.length,
      verification: {
        version: 1,
        status: "passed",
        method: "tool_contract",
        contract: "tool_result_v2",
        summary: "The write contract passed.",
        checks: [{
          id: "write_completed",
          kind: "filesystem_write",
          status: "passed",
          severity: "required",
        }],
        facts: [{
          kind: "file.written",
          message: "Wrote generated.ts.",
          subject: "/workspace/src/generated.ts",
          data: { sha256: "private-verification-hash" },
        }],
      },
      verificationPassed: true,
      completionEvidence: [{
        kind: "path_state",
        path: "/workspace/src/generated.ts",
        exists: true,
        actualKind: "file",
        change: "mutated",
        operation: "write",
        tool: "write_files",
        step: 2,
        callId: "write-generated",
      }],
    }]);

    expect(calls).toHaveLength(1);
    expect(calls?.[0]).toMatchObject({
      step: 2,
      callId: "write-generated",
      tool: "write_files",
      purpose: "Create the generated source file.",
      input: {
        files: [{
          path: "/workspace/src/generated.ts",
          content,
        }],
      },
      output,
      status: "success",
      verificationStatus: "passed",
      hasMore: false,
      rawOutputChars: output.length,
    });
    expect(calls?.[0]).not.toHaveProperty("verification");
    expect(calls?.[0]).not.toHaveProperty("verificationPassed");
    expect(calls?.[0]).not.toHaveProperty("completionEvidence");
    expect(JSON.stringify(calls?.[0])).not.toContain("private-verification-hash");
  });

  it("retains a compact verification failure needed for repair", () => {
    const call: RunToolCallContext = {
      step: 3,
      callId: "write-config",
      tool: "write_files",
      purpose: "Update the configuration.",
      input: {
        files: [{
          path: "/workspace/config.ts",
          content: "export const enabled = true;\n",
        }],
      },
      status: "success",
      output: "The filesystem call returned.",
      verification: {
        version: 1,
        status: "failed",
        method: "tool_contract",
        contract: "tool_result_v2",
        summary: "The resulting content did not match.",
        checks: [],
        facts: [],
        failure: {
          code: "CONTENT_MISMATCH",
          message: "The resulting content did not match.",
        },
      },
    };

    expect(buildPromptToolCallsForRun([call])?.[0]).toMatchObject({
      status: "success",
      verificationStatus: "failed",
      verificationFailure: {
        code: "CONTENT_MISMATCH",
        message: "The resulting content did not match.",
      },
    });
  });

  it("labels transient context calls without presenting them as durable steps", () => {
    const call: RunToolCallContext = {
      step: 1,
      stepKind: "transient_context",
      callId: "load-personal-memory",
      tool: "context_load",
      purpose: "Load the relevant personal preference.",
      input: {
        keys: ["personal.memory"],
      },
      status: "success",
      output: JSON.stringify({
        loaded: ["personal.memory"],
        mountedTokens: 120,
      }),
      verification: {
        version: 1,
        status: "passed",
        method: "tool_contract",
        contract: "tool_result_v2",
        summary: "The context load contract passed.",
        checks: [],
        facts: [],
      },
      verificationPassed: true,
    };

    expect(buildPromptToolCallsForRun([call])?.[0]).toMatchObject({
      step: 1,
      stepKind: "transient_context",
      callId: "load-personal-memory",
      tool: "context_load",
      status: "success",
      verificationStatus: "passed",
    });
  });

  it("projects a compact factual candidate set for a multi-match file search", () => {
    const call: RunToolCallContext = {
      step: 1,
      callId: "find-release-notes",
      tool: "find_files",
      purpose: "Find the requested release notes.",
      input: {
        query: "release-notes.txt",
        roots: ["/workspace"],
      },
      status: "success",
      output: "Found 2 matches.",
      projectionMetadata: {
        query: "release-notes.txt",
        roots: ["/workspace"],
        matches: [
          {
            absolutePath: "/workspace/north/release-notes.txt",
            kind: "file",
          },
          {
            absolutePath: "/workspace/south/release-notes.txt",
            kind: "file",
          },
        ],
        matchCount: 2,
        capped: false,
        traversalComplete: true,
        errorCount: 0,
      },
      verification: {
        version: 1,
        status: "passed",
        method: "tool_contract",
        contract: "tool_result_v2",
        summary: "The search contract passed.",
        checks: [],
        facts: [],
      },
    };

    const projected = buildPromptToolCallsForRun([call])?.[0];
    expect(projected?.candidateSet).toEqual({
      query: "release-notes.txt",
      matchCount: 2,
      candidates: [
        {
          label: "north/release-notes.txt",
          path: "/workspace/north/release-notes.txt",
          kind: "file",
        },
        {
          label: "south/release-notes.txt",
          path: "/workspace/south/release-notes.txt",
          kind: "file",
        },
      ],
    });

    const compacted = compactPromptToolCall(
      projected!,
      "summary",
      "context_budget",
    );
    expect(compacted.candidateSet).toEqual(projected?.candidateSet);
  });

  it("does not add candidate context to a unique file result", () => {
    const calls = buildPromptToolCallsForRun([{
      step: 1,
      tool: "find_files",
      input: { query: "notes.txt", roots: ["/workspace"] },
      status: "success",
      output: "Found 1 match.",
      projectionMetadata: {
        query: "notes.txt",
        roots: ["/workspace"],
        matches: [{ absolutePath: "/workspace/notes.txt", kind: "file" }],
        matchCount: 1,
      },
    }]);

    expect(calls?.[0]).not.toHaveProperty("candidateSet");
  });
});
