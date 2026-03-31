import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentLoop } from "../../src/ivec/agent-loop.js";
import * as XLSX from "xlsx";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { SessionMemory, MemoryRunHandle } from "../../src/memory/types.js";
import { MemoryManager } from "../../src/memory/session-manager.js";
import { DocumentStore } from "../../src/documents/document-store.js";
import { PreparedAttachmentRegistry } from "../../src/documents/prepared-attachment-registry.js";
import { PreparedAttachmentService } from "../../src/documents/prepared-attachment-service.js";
import { SessionAttachmentService } from "../../src/documents/session-attachment-service.js";
import { createAttachmentSkill } from "../../src/skills/builtins/attachments/index.js";
import { createDatasetSkill } from "../../src/skills/builtins/datasets/index.js";
import { createDocumentSkill } from "../../src/skills/builtins/documents/index.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";

function goalContract(objective: string): Record<string, unknown> {
  return {
    objective,
    done_when: [`${objective} is complete`],
    required_evidence: [],
    ask_user_when: [],
    stop_when_no_progress: [],
  };
}

function taskVerifyResponse(taskStatusAfter = "not_done", taskReason = "more work remains"): string {
  return JSON.stringify({
    taskStatusAfter,
    taskReason,
    taskEvidence: [],
  });
}

function stepVerifyFailureResponse(evidence = "permission denied"): string {
  return JSON.stringify({
    passed: false,
    evidence,
    newFacts: [],
    artifacts: [],
  });
}

function createMockSessionMemory(): SessionMemory {
  return {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    beginRun: vi.fn().mockReturnValue({ sessionId: "s1", runId: "r1" }),
    recordToolCall: vi.fn(),
    recordToolResult: vi.fn(),
    recordAssistantFinal: vi.fn(),
    recordRunFailure: vi.fn(),
    recordAgentStep: vi.fn(),
    recordRunLedger: vi.fn(),
    recordTaskSummary: vi.fn(),
    recordAssistantFeedback: vi.fn(),
    resolveOpenFeedback: vi.fn(),
    recordAssistantNotification: vi.fn(),
    getPromptMemoryContext: vi.fn().mockReturnValue({
      conversationTurns: [{ role: "user", content: "hello", timestamp: "", sessionPath: "" }],
      previousSessionSummary: "",
      recentRunLedgers: [],
      openFeedbacks: [],
      recentSystemActivity: [],
    }),
    setStaticTokenBudget: vi.fn(),
  };
}

function writeWorkbook(filePath: string, sheets: Array<{ name: string; rows: unknown[][] }>): void {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  }
  XLSX.writeFile(workbook, filePath);
}

describe("agentLoop", () => {
  let tmpDir: string;

  function makeTmpDir(): string {
    tmpDir = mkdtempSync(join(tmpdir(), "ayati-loop-"));
    return tmpDir;
  }

  function cleanup(): void {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }

  it("returns immediately when understand stage says done (simple message)", async () => {
    const dataDir = makeTmpDir();
    try {
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi
          .fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>()
          .mockResolvedValue({
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Hello! How can I help?",
              status: "completed",
            }),
          }),
      };

      const sessionMemory = createMockSessionMemory();
      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory,
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        inputKind: "user_message",
        dataDir,
      });

      expect(result.type).toBe("reply");
      expect(result.content).toBe("Hello! How can I help?");
      expect(result.status).toBe("completed");
      expect(result.totalIterations).toBe(0);
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);
      expect(sessionMemory.recordRunLedger as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("c1", expect.objectContaining({
        runId: "r1",
        state: "started",
      }));
    } finally {
      cleanup();
    }
  });

  it("resolves a matched open feedback before normal reasoning continues", async () => {
    const dataDir = makeTmpDir();
    try {
      const sessionMemory = createMockSessionMemory();
      (sessionMemory.getPromptMemoryContext as ReturnType<typeof vi.fn>).mockReturnValue({
        conversationTurns: [{ role: "user", content: "yes, send it", timestamp: "", sessionPath: "" }],
        previousSessionSummary: "",
        recentRunLedgers: [],
        openFeedbacks: [
          {
            feedbackId: "fb-1",
            status: "open",
            kind: "approval",
            shortLabel: "send Arun email",
            message: "Should I send the draft reply to Arun?",
            actionType: "send_email",
            sourceRunId: "r0",
            sourceEventId: "evt-1",
            entityHints: ["Arun", "email"],
          payloadSummary: "Draft ready",
          createdAt: "2026-02-16T00:00:00.000Z",
          expiresAt: "2026-02-17T00:00:00.000Z",
        },
      ],
        recentSystemActivity: [],
      });

      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                resolution: "matched",
                feedback_id: "fb-1",
                clarification: "",
                reason: "single approval request matches",
              }),
            };
          }
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Sending the draft now.",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory,
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        inputKind: "user_message",
        initialUserMessage: "yes, send it",
        dataDir,
      });

      expect(result.type).toBe("reply");
      expect(result.content).toBe("Sending the draft now.");
      expect(result.resolvedFeedbackId).toBe("fb-1");
      expect(sessionMemory.resolveOpenFeedback as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("c1", {
        runId: "r1",
        sessionId: "s1",
        feedbackId: "fb-1",
        resolution: "completed",
        userResponse: "yes, send it",
      });
    } finally {
      cleanup();
    }
  });

  it("stops immediately when a matched feedback reply is an explicit rejection", async () => {
    const dataDir = makeTmpDir();
    try {
      const sessionMemory = createMockSessionMemory();
      (sessionMemory.getPromptMemoryContext as ReturnType<typeof vi.fn>).mockReturnValue({
        conversationTurns: [{ role: "user", content: "do not do anything", timestamp: "", sessionPath: "" }],
        previousSessionSummary: "",
        recentRunLedgers: [],
        openFeedbacks: [
          {
            feedbackId: "fb-1",
            status: "open",
            kind: "approval",
            shortLabel: "send Arun email",
            message: "Should I send the draft reply to Arun?",
            actionType: "send_email",
            sourceRunId: "r0",
            sourceEventId: "evt-1",
            entityHints: ["Arun", "email"],
            payloadSummary: "Draft ready",
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: "2026-02-17T00:00:00.000Z",
          },
        ],
        recentSystemActivity: [],
      });

      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockResolvedValue({
          type: "assistant",
          content: JSON.stringify({
            resolution: "matched",
            feedback_id: "fb-1",
            clarification: "",
            reason: "single approval request matches",
          }),
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory,
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        inputKind: "user_message",
        initialUserMessage: "do not do anything",
        dataDir,
      });

      expect(result.type).toBe("reply");
      expect(result.content).toContain("won't do anything");
      expect(result.resolvedFeedbackId).toBe("fb-1");
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);
      expect(sessionMemory.resolveOpenFeedback as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("c1", {
        runId: "r1",
        sessionId: "s1",
        feedbackId: "fb-1",
        resolution: "rejected",
        userResponse: "do not do anything",
      });
    } finally {
      cleanup();
    }
  });

  it("asks for clarification when a user reply is ambiguous across open feedbacks", async () => {
    const dataDir = makeTmpDir();
    try {
      const sessionMemory = createMockSessionMemory();
      (sessionMemory.getPromptMemoryContext as ReturnType<typeof vi.fn>).mockReturnValue({
        conversationTurns: [{ role: "user", content: "go ahead", timestamp: "", sessionPath: "" }],
        previousSessionSummary: "",
        recentRunLedgers: [],
        openFeedbacks: [
          {
            feedbackId: "fb-1",
            status: "open",
            kind: "approval",
            shortLabel: "send Arun email",
            message: "Should I send Arun the reply?",
            sourceRunId: "r0",
            entityHints: ["Arun"],
            createdAt: "2026-02-16T00:00:00.000Z",
            expiresAt: "2026-02-17T00:00:00.000Z",
          },
          {
            feedbackId: "fb-2",
            status: "open",
            kind: "approval",
            shortLabel: "restart staging",
            message: "Should I restart the staging service?",
            sourceRunId: "r0",
            entityHints: ["staging"],
            createdAt: "2026-02-16T00:00:10.000Z",
            expiresAt: "2026-02-17T00:00:10.000Z",
          },
        ],
        recentSystemActivity: [],
      });

      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockResolvedValue({
          type: "assistant",
          content: JSON.stringify({
            resolution: "ambiguous",
            feedback_id: "",
            clarification: "Which open request do you mean: Arun email or staging restart?",
            reason: "multiple approvals could match",
          }),
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory,
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        inputKind: "user_message",
        initialUserMessage: "go ahead",
        dataDir,
      });

      expect(result.type).toBe("feedback");
      expect(result.content).toContain("Which open request");
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);
      expect(sessionMemory.resolveOpenFeedback as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("handles understand + direct multi-step execution", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          // Call 1: understand stage → complex task
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("analyze request"),
                approach: "analyze then conclude",
              }),
            };
          }
          // Call 2: direct stage → step directive
          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "analyze request",
                tools_hint: [],
                success_criteria: "analysis complete",
                context: "",
              }),
            };
          }
          // Call 3: act (no tools, just text)
          if (callCount === 3) {
            return { type: "assistant", content: "Analysis done" };
          }
          // Call 4: task verification
          if (callCount === 4) {
            return { type: "assistant", content: taskVerifyResponse("not_done") };
          }
          // Call 5: direct stage → done
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Completed analysis",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        inputKind: "user_message",
        dataDir,
      });

      expect(result.status).toBe("completed");
      expect(result.totalIterations).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("returns stuck when max iterations exhausted", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          // Call 1: understand → complex task
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("keep trying"),
                approach: "keep trying",
              }),
            };
          }
          if (callCount === 2 || callCount === 5) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "try again",
                tools_hint: [],
                success_criteria: "succeed",
                context: "",
              }),
            };
          }
          if (callCount === 3 || callCount === 6) {
            return { type: "assistant", content: "still trying" };
          }
          return { type: "assistant", content: taskVerifyResponse("not_done") };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
        config: { maxIterations: 2 },
      });

      expect(result.status).toBe("stuck");
    } finally {
      cleanup();
    }
  });

  it("re-evaluates approach after a single failed step", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("recover from failure"),
                approach: "initial approach",
              }),
            };
          }
          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "first attempt",
                tools_hint: [],
                success_criteria: "must produce evidence",
                context: "",
              }),
            };
          }
          if (callCount === 3) {
            return { type: "assistant", content: "" };
          }
          if (callCount === 4) {
            return { type: "assistant", content: stepVerifyFailureResponse("permission denied while executing") };
          }
          if (callCount === 5) {
            const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
            const prompt = messages.find((message) => message.role === "user")?.content ?? "";
            if (!prompt.includes("Re-evaluate this task")) {
              throw new Error("Expected re-eval prompt after single failure");
            }
            if (!prompt.includes("Current approach: initial approach")) {
              throw new Error("Expected current approach in re-eval prompt");
            }
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                reeval: true,
                approach: "fallback approach",
              }),
            };
          }

          const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
          const prompt = messages.find((message) => message.role === "user")?.content ?? "";
          if (!prompt.includes("Approach: fallback approach")) {
            throw new Error("Expected direct prompt to use re-evaluated approach");
          }
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Recovered with new approach",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
      });

      expect(result.status).toBe("completed");
      expect(result.content).toBe("Recovered with new approach");
    } finally {
      cleanup();
    }
  });

  it("handles context_search during re-eval before choosing a new approach", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("recover after lookup"),
                approach: "initial approach",
              }),
            };
          }
          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "first attempt",
                tools_hint: [],
                success_criteria: "must produce evidence",
                context: "",
              }),
            };
          }
          if (callCount === 3) {
            return { type: "assistant", content: "" };
          }
          if (callCount === 4) {
            return { type: "assistant", content: stepVerifyFailureResponse("step 1 failed because skill commands were missing") };
          }
          if (callCount === 5) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                context_search: true,
                query: "Read the playwright skill.md commands needed after the last failure",
                scope: "skills",
              }),
            };
          }
          if (callCount === 6) {
            return {
              type: "assistant",
              content: JSON.stringify({
                context: "Playwright skill.md says to install browsers before running screenshot commands",
                sources: ["playwright/skill.md"],
                confidence: 0.9,
              }),
            };
          }
          if (callCount === 7) {
            const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
            const prompt = messages.find((message) => message.role === "user")?.content ?? "";
            if (!prompt.includes("Retrieved context from prior context_search:")) {
              throw new Error("Expected scout results in re-eval prompt");
            }
            if (!prompt.includes("install browsers before running screenshot commands")) {
              throw new Error("Expected scout summary in re-eval prompt");
            }
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                reeval: true,
                approach: "load skill instructions first, then run the command",
              }),
            };
          }

          const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
          const prompt = messages.find((message) => message.role === "user")?.content ?? "";
          if (!prompt.includes("Approach: load skill instructions first, then run the command")) {
            throw new Error("Expected direct prompt to use the re-evaluated approach");
          }
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Recovered after re-eval lookup",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
      });

      expect(result.status).toBe("completed");
      expect(result.content).toBe("Recovered after re-eval lookup");
    } finally {
      cleanup();
    }
  });

  it("fails when approach changes reach configured maximum", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("retry with limits"),
                approach: "approach A",
              }),
            };
          }
          if (callCount === 2 || callCount === 6) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "attempt step",
                tools_hint: [],
                success_criteria: "must succeed",
                context: "",
              }),
            };
          }
          if (callCount === 3 || callCount === 7) {
            return { type: "assistant", content: "" };
          }
          if (callCount === 4 || callCount === 8) {
            return { type: "assistant", content: stepVerifyFailureResponse("no such file") };
          }
          if (callCount === 5) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                reeval: true,
                approach: "approach B",
              }),
            };
          }
          throw new Error(`Unexpected provider call ${callCount}`);
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
        config: {
          maxApproachChanges: 1,
          maxIterations: 5,
        },
      });

      expect(result.status).toBe("failed");
      expect(result.content).toContain("changing approach 1 times");
    } finally {
      cleanup();
    }
  });

  it("writes state file after each iteration", async () => {
    const dataDir = makeTmpDir();
    try {
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi
          .fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>()
          .mockResolvedValue({
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "done",
              status: "completed",
            }),
          }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
      });

      expect(existsSync(join(result.runPath, "state.json"))).toBe(true);
      const state = JSON.parse(readFileSync(join(result.runPath, "state.json"), "utf-8")) as {
        finalOutput?: string;
        goal?: { objective?: string };
        taskStatus?: string;
        sessionHistory?: unknown;
        recentRunLedgers?: unknown;
      };
      expect(state.finalOutput).toBe("done");
      expect(state.goal?.objective).toBe("");
      expect(state.taskStatus).toBe("not_done");
      expect(state).not.toHaveProperty("sessionHistory");
      expect(state).not.toHaveProperty("recentRunLedgers");
    } finally {
      cleanup();
    }
  });

  it("calls onProgress for each step iteration", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          // Call 1: understand
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("respond"),
                approach: "direct response",
              }),
            };
          }
          // Call 2: direct → step
          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "step 1",
                tools_hint: [],
                success_criteria: "ok",
                context: "",
              }),
            };
          }
          // Call 3: act
          if (callCount === 3) {
            return { type: "assistant", content: "text response" };
          }
          // Call 4: task verification
          if (callCount === 4) {
            return { type: "assistant", content: taskVerifyResponse("not_done") };
          }
          // Call 5: direct → done
          return {
            type: "assistant",
            content: JSON.stringify({ done: true, summary: "done", status: "completed" }),
          };
        }),
      };

      const onProgress = vi.fn();
      await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledTimes(1);
      expect(onProgress).toHaveBeenCalledWith(
        expect.stringContaining("Step 1"),
        expect.any(String),
      );
    } finally {
      cleanup();
    }
  });

  it("handles context_search directive by calling scout and re-calling direct", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          // Call 1: understand
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("respond"),
                approach: "respond directly",
              }),
            };
          }
          // Call 2: direct → step
          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "draft response",
                tools_hint: [],
                success_criteria: "response drafted",
                context: "",
              }),
            };
          }
          // Call 3: act
          if (callCount === 3) {
            return { type: "assistant", content: "Drafted response" };
          }
          // Call 4: task verification
          if (callCount === 4) {
            return { type: "assistant", content: taskVerifyResponse("not_done") };
          }
          // Call 5: direct → context_search
          if (callCount === 5) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                context_search: true,
                query: "What happened in step 1?",
                scope: "run_artifacts",
              }),
            };
          }
          // Call 6: scout LLM response (immediate text → no tool calls)
          if (callCount === 6) {
            return {
              type: "assistant",
              content: JSON.stringify({
                context: "Step 1 drafted a response",
                sources: ["steps/001-act.md"],
                confidence: 0.8,
              }),
            };
          }
          // Call 7: direct → done (after scout results injected)
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Completed with context search",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
      });

      expect(result.status).toBe("completed");
      expect(result.totalIterations).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("reuses cached context_search results across later steps without re-running scout", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("reuse earlier step context"),
                approach: "use run artifacts when needed",
              }),
            };
          }
          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "complete the first step",
                tools_hint: [],
                success_criteria: "step 1 is done",
                context: "",
              }),
            };
          }
          if (callCount === 3) {
            return { type: "assistant", content: "Step 1 finished" };
          }
          if (callCount === 4) {
            return { type: "assistant", content: taskVerifyResponse("not_done", "step 2 still needs prior context") };
          }
          if (callCount === 5) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                context_search: true,
                query: "What happened in step 1?",
                scope: "run_artifacts",
              }),
            };
          }
          if (callCount === 6) {
            return {
              type: "assistant",
              content: JSON.stringify({
                context: "Step 1 created the draft answer and verified it successfully.",
                sources: ["steps/001-act.md", "steps/001-verify.md"],
                confidence: 0.87,
              }),
            };
          }
          if (callCount === 7) {
            const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
            const prompt = messages.find((message) => message.role === "user")?.content ?? "";
            if (!prompt.includes("Step 1 created the draft answer")) {
              throw new Error("Expected direct prompt to receive scout context after the first lookup");
            }
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "use retrieved context",
                tools_hint: [],
                success_criteria: "step 2 uses step 1 facts",
                context: "",
              }),
            };
          }
          if (callCount === 8) {
            return { type: "assistant", content: "Step 2 used the earlier facts" };
          }
          if (callCount === 9) {
            return { type: "assistant", content: taskVerifyResponse("not_done", "one more summary remains") };
          }
          if (callCount === 10) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                context_search: true,
                query: "Review step 1 act and verify files again before finishing",
                scope: "run_artifacts",
              }),
            };
          }
          if (callCount === 11) {
            const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
            const prompt = messages.find((message) => message.role === "user")?.content ?? "";
            if (!prompt.includes("selecting useful cached context-search entries")) {
              throw new Error("Expected cache metadata selection prompt before reusing cached context");
            }
            return {
              type: "assistant",
              content: JSON.stringify({
                ids: ["cc_001"],
                reason: "The cached run-artifacts query is clearly about step 1 and should be reused.",
              }),
            };
          }
          if (callCount === 12) {
            const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
            const prompt = messages.find((message) => message.role === "user")?.content ?? "";
            if (!prompt.includes("deciding whether cached context-search entries are sufficient")) {
              throw new Error("Expected cache sufficiency prompt before reusing cached context");
            }
            if (!prompt.includes("Step 1 created the draft answer and verified it successfully.")) {
              throw new Error("Expected cached context to be evaluated for sufficiency");
            }
            return {
              type: "assistant",
              content: JSON.stringify({
                sufficient: true,
                ids: ["cc_001"],
                reason: "The cached step 1 summary is enough for the repeated run-artifacts request.",
              }),
            };
          }
          if (callCount === 13) {
            const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
            const prompt = messages.find((message) => message.role === "user")?.content ?? "";
            if (!prompt.includes("Retrieved context from prior context_search:")) {
              throw new Error("Expected cached scout context in the repeated direct prompt");
            }
            if (!prompt.includes("Step 1 created the draft answer and verified it successfully.")) {
              throw new Error("Expected cached scout summary to be reused");
            }
            return {
              type: "assistant",
              content: JSON.stringify({
                done: true,
                summary: "Completed with cached context reuse",
                status: "completed",
              }),
            };
          }

          throw new Error(`Unexpected provider call ${callCount}`);
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
      });

      expect(result.status).toBe("completed");
      expect(result.content).toBe("Completed with cached context reuse");
      expect(provider.generateTurn).toHaveBeenCalledTimes(13);

      const cachePath = join(result.runPath, "context-cache.json");
      expect(existsSync(cachePath)).toBe(true);
      const cache = JSON.parse(readFileSync(cachePath, "utf-8")) as {
        version: number;
        entries: Array<{ id: string; scope: string; query: string }>;
      };
      expect(cache.version).toBe(3);
      expect(cache.entries).toHaveLength(1);
      expect(cache.entries[0]?.id).toBeTruthy();
      expect(cache.entries[0]?.scope).toBe("run_artifacts");
      expect(cache.entries[0]?.query).toBe("What happened in step 1?");
    } finally {
      cleanup();
    }
  });

  it("falls back to scout when cached context is selected but not sufficient", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("reuse cache but fetch more exact evidence when needed"),
                approach: "use run artifacts when needed",
              }),
            };
          }
          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                context_search: true,
                query: "What happened in step 1?",
                scope: "run_artifacts",
              }),
            };
          }
          if (callCount === 3) {
            return {
              type: "assistant",
              content: JSON.stringify({
                context: "Step 1 created the draft answer.",
                sources: ["steps/001-act.md"],
                confidence: 0.82,
              }),
            };
          }
          if (callCount === 4) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                context_search: true,
                query: "What exact verify error happened in step 1?",
                scope: "run_artifacts",
              }),
            };
          }
          if (callCount === 5) {
            return {
              type: "assistant",
              content: JSON.stringify({
                ids: ["cc_001"],
                reason: "The cached step 1 summary is related to the new run-artifacts query.",
              }),
            };
          }
          if (callCount === 6) {
            const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
            const prompt = messages.find((message) => message.role === "user")?.content ?? "";
            if (!prompt.includes("Step 1 created the draft answer.")) {
              throw new Error("Expected cached step 1 context in the sufficiency prompt");
            }
            return {
              type: "assistant",
              content: JSON.stringify({
                sufficient: false,
                ids: ["cc_001"],
                reason: "The cached summary does not contain the exact verify error requested.",
              }),
            };
          }
          if (callCount === 7) {
            return {
              type: "assistant",
              content: JSON.stringify({
                context: "Step 1 verify failed with the message: permission denied while reading config.",
                sources: ["steps/001-verify.md"],
                confidence: 0.91,
              }),
            };
          }
          if (callCount === 8) {
            const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
            const prompt = messages.find((message) => message.role === "user")?.content ?? "";
            if (!prompt.includes("permission denied while reading config")) {
              throw new Error("Expected scout fallback context in the direct prompt");
            }
            return {
              type: "assistant",
              content: JSON.stringify({
                done: true,
                summary: "The exact step 1 verify error was permission denied while reading config.",
                status: "completed",
              }),
            };
          }

          throw new Error(`Unexpected provider call ${callCount}`);
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
      });

      expect(result.status).toBe("completed");
      expect(result.content).toContain("permission denied");
      expect(provider.generateTurn).toHaveBeenCalledTimes(8);
    } finally {
      cleanup();
    }
  });

  it("prepares attached documents before understand and shows prepared metadata in the direct prompt", async () => {
    const dataDir = makeTmpDir();
    const attachmentPath = join(dataDir, "policy.txt");
    try {
      writeFileSync(
        attachmentPath,
        "Termination requires 30 days written notice before cancellation.",
        "utf-8",
      );

      const documentStore = new DocumentStore({
        dataDir: join(dataDir, "documents"),
        preferCli: false,
      });
      const registered = await documentStore.registerAttachments([{ path: attachmentPath, name: "policy.txt" }]);
      const preparedAttachmentRegistry = new PreparedAttachmentRegistry();

      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("answer from the attachment"),
                approach: "use the prepared attachment",
                work_mode: "document_lookup",
              }),
            };
          }
          const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
          const prompt = messages.find((message) => message.role === "user")?.content ?? "";
          expect(prompt).toContain("Prepared attachments available (1):");
          expect(prompt).toContain("policy.txt | kind=txt | mode=unstructured_text | status=ready");
          expect(prompt).toContain("Work mode: document_lookup");
          expect(prompt).not.toContain("Document retrieval status:");
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "The policy requires 30 days written notice before cancellation.",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
        userMessageOverride: "What is the termination clause?",
        attachedDocuments: registered.documents,
        documentStore,
        preparedAttachmentRegistry,
      });

      expect(result.status).toBe("completed");
      expect(result.content).toContain("30 days written notice");
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);

      const persisted = JSON.parse(readFileSync(join(result.runPath, "state.json"), "utf-8")) as {
        preparedAttachments?: Array<{ mode?: string; displayName?: string }>;
        workMode?: string;
      };
      expect(persisted.preparedAttachments?.[0]?.displayName).toBe("policy.txt");
      expect(persisted.preparedAttachments?.[0]?.mode).toBe("unstructured_text");
      expect(persisted.workMode).toBe("document_lookup");
    } finally {
      cleanup();
    }
  });

  it("understand stage stores goal and approach on state", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
          callCount++;
          // Call 1: understand → complex task with rich state
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: {
                  objective: "find all config files",
                  done_when: ["config file paths are returned"],
                  required_evidence: ["at least one config file path"],
                  ask_user_when: ["the search root is ambiguous"],
                  stop_when_no_progress: ["two search attempts fail"],
                },
                approach: "use shell to search",
              }),
            };
          }
          // Call 2: direct → verify state was populated (check prompt includes goal/approach)
          if (callCount === 2) {
            const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
            const prompt = messages.find((message) => message.role === "user")?.content ?? "";
            // The direct prompt should include the understand output
            if (!prompt.includes("find all config files")) {
              throw new Error("Direct prompt missing goal from understand stage");
            }
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "search config files",
                tools_hint: [],
                success_criteria: "config file paths are returned",
                context: "",
              }),
            };
          }
          if (callCount === 3) {
            return { type: "assistant", content: "Found config files in the project" };
          }
          if (callCount === 4) {
            return { type: "assistant", content: taskVerifyResponse("done", "goal satisfied") };
          }
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Found config files",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
        systemContext: "system context with personality",
      });

      expect(result.status).toBe("completed");
      expect(result.content).toBe("Found config files");

      // Verify understand and direct both include system context
      const calls = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls;
      // Call 1: understand — has system message
      const understandInput = calls[0]![0] as { messages: Array<{ role: string }> };
      expect(understandInput.messages[0]!.role).toBe("system");
      // Call 2: direct — also has system message
      const directInput = calls[1]![0] as { messages: Array<{ role: string }> };
      expect(directInput.messages[0]!.role).toBe("system");
      expect(directInput.messages[1]!.role).toBe("user");

      const persisted = JSON.parse(readFileSync(join(result.runPath, "state.json"), "utf-8")) as {
        goal?: { objective?: string; done_when?: string[] };
        taskStatus?: string;
      };
      expect(persisted.goal?.objective).toBe("find all config files");
      expect(persisted.goal?.done_when).toEqual(["config file paths are returned"]);
      expect(persisted.taskStatus).toBe("done");
    } finally {
      cleanup();
    }
  });

  it("stores structured attachment metadata before the first controller decision", async () => {
    const dataDir = makeTmpDir();
    const attachmentPath = join(dataDir, "sales.csv");
    try {
      writeFileSync(attachmentPath, "month,amount\nJan,120\nFeb,180\n", "utf-8");
      const documentStore = new DocumentStore({
        dataDir: join(dataDir, "documents"),
        preferCli: false,
      });
      const registered = await documentStore.registerAttachments([{ path: attachmentPath, name: "sales.csv" }]);
      const preparedAttachmentRegistry = new PreparedAttachmentRegistry();

      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("analyze the attached sales csv"),
                approach: "use dataset tools",
                work_mode: "structured_data_process",
              }),
            };
          }

          const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
          const prompt = messages.find((message) => message.role === "user")?.content ?? "";
          expect(prompt).toContain("Prepared attachments available (1):");
          expect(prompt).toContain("sales.csv | kind=csv | mode=structured_data | status=ready | rows=2 | columns=month, amount");
          expect(prompt).toContain("Work mode: structured_data_process");
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "The CSV has 2 rows with columns month and amount.",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
        userMessageOverride: "analyze the attached sales csv",
        attachedDocuments: registered.documents,
        documentStore,
        preparedAttachmentRegistry,
      });

      expect(result.status).toBe("completed");
      expect(result.content).toContain("2 rows");
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
    }
  });

  it("stores xlsx attachment metadata before the first controller decision", async () => {
    const dataDir = makeTmpDir();
    const attachmentPath = join(dataDir, "sales.xlsx");
    try {
      writeWorkbook(attachmentPath, [
        {
          name: "Orders",
          rows: [["month", "amount"], ["Jan", 120], ["Feb", 180]],
        },
        {
          name: "Archive",
          rows: [["month", "amount"], ["Mar", 90]],
        },
      ]);
      const documentStore = new DocumentStore({
        dataDir: join(dataDir, "documents"),
        preferCli: false,
      });
      const registered = await documentStore.registerAttachments([{ path: attachmentPath, name: "sales.xlsx" }]);
      const preparedAttachmentRegistry = new PreparedAttachmentRegistry();

      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("analyze the attached sales workbook"),
                approach: "use dataset tools",
                work_mode: "structured_data_process",
              }),
            };
          }

          const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
          const prompt = messages.find((message) => message.role === "user")?.content ?? "";
          expect(prompt).toContain("Prepared attachments available (1):");
          expect(prompt).toContain("sales.xlsx | kind=xlsx | mode=structured_data | status=ready | sheet=Orders | rows=2 | columns=month, amount");
          expect(prompt).toContain("Workbook has 2 sheets; using first sheet: Orders");
          expect(prompt).toContain("Work mode: structured_data_process");
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "The workbook has 2 rows on the Orders sheet with columns month and amount.",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
        userMessageOverride: "analyze the attached sales workbook",
        attachedDocuments: registered.documents,
        documentStore,
        preparedAttachmentRegistry,
      });

      expect(result.status).toBe("completed");
      expect(result.content).toContain("Orders sheet");
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
    }
  });

  it("writes prepared attachment artifacts for structured and unstructured inputs", async () => {
    const dataDir = makeTmpDir();
    const csvPath = join(dataDir, "sales.csv");
    const textPath = join(dataDir, "profile.txt");
    try {
      writeFileSync(csvPath, "month,amount\nJan,120\n", "utf-8");
      writeFileSync(textPath, "Profile\n\nBackend engineer with Node.js experience.", "utf-8");
      const documentStore = new DocumentStore({
        dataDir: join(dataDir, "documents"),
        preferCli: false,
      });
      const registered = await documentStore.registerAttachments([
        { path: csvPath, name: "sales.csv" },
        { path: textPath, name: "profile.txt" },
      ]);
      const preparedAttachmentRegistry = new PreparedAttachmentRegistry();

      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("inspect prepared attachments"),
                approach: "review the prepared metadata",
              }),
            };
          }
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Prepared attachment metadata is ready.",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
        userMessageOverride: "inspect the prepared attachments",
        attachedDocuments: registered.documents,
        documentStore,
        preparedAttachmentRegistry,
      });

      expect(result.status).toBe("completed");
      const attachmentsIndex = JSON.parse(readFileSync(join(result.runPath, "attachments", "index.json"), "utf-8")) as {
        attachments?: Array<{ displayName?: string; mode?: string }>;
      };
      expect(attachmentsIndex.attachments).toHaveLength(2);
      expect(attachmentsIndex.attachments?.map((entry) => entry.displayName)).toEqual(["sales.csv", "profile.txt"]);
      expect(attachmentsIndex.attachments?.map((entry) => entry.mode)).toEqual(["structured_data", "unstructured_text"]);
    } finally {
      cleanup();
    }
  });

  it("updates prepared attachment state after dataset_query stages a dataset", async () => {
    const dataDir = makeTmpDir();
    const csvPath = join(dataDir, "employees.csv");
    try {
      writeFileSync(csvPath, "name,state\nLila,Maharashtra\nAsha,Kerala\n", "utf-8");
      const documentStore = new DocumentStore({
        dataDir: join(dataDir, "documents"),
        preferCli: false,
      });
      const registered = await documentStore.registerAttachments([{ path: csvPath, name: "employees.csv" }]);
      const preparedAttachmentRegistry = new PreparedAttachmentRegistry();
      const serviceProvider: LlmProvider = {
        name: "service-mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn(),
      };
      const preparedAttachmentService = new PreparedAttachmentService({
        registry: preparedAttachmentRegistry,
        documentStore,
        provider: serviceProvider,
      });
      const datasetSkill = createDatasetSkill({ preparedAttachmentService });
      const toolExecutor = createToolExecutor(datasetSkill.tools);
      const preparedInputId = `att_1_${registered.documents[0]!.documentId.slice(0, 8)}`;

      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("count employees from Maharashtra"),
                approach: "use dataset_query",
                work_mode: "structured_data_process",
              }),
            };
          }
          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "count Maharashtra employees",
                tools_hint: ["dataset_query"],
                success_criteria: "dataset query returns the employee count",
                context: "Use the prepared employees.csv attachment.",
              }),
            };
          }
          if (callCount === 3) {
            return {
              type: "tool_calls",
              calls: [{
                id: "tc1",
                name: "dataset_query",
                input: {
                  preparedInputId: "employees.csv",
                  sql: `SELECT COUNT(*) AS employee_count FROM staging_${preparedInputId} WHERE state = 'Maharashtra'`,
                },
              }],
            };
          }
          if (callCount === 4) {
            return { type: "assistant", content: "Found 1 employee from Maharashtra." };
          }
          if (callCount === 5) {
            return { type: "assistant", content: taskVerifyResponse("done", "dataset query returned the requested count") };
          }
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "There is 1 employee from Maharashtra.",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
        userMessageOverride: "how many employees are from Maharashtra",
        attachedDocuments: registered.documents,
        documentStore,
        preparedAttachmentRegistry,
      });

      expect(result.status).toBe("completed");
      const persisted = JSON.parse(readFileSync(join(result.runPath, "state.json"), "utf-8")) as {
        preparedAttachments?: Array<{ structured?: { staged?: boolean; stagingTableName?: string } }>;
      };
      expect(persisted.preparedAttachments?.[0]?.structured?.staged).toBe(true);
      expect(persisted.preparedAttachments?.[0]?.structured?.stagingTableName).toBe(`staging_${preparedInputId}`);
      expect(existsSync(join(result.runPath, "attachments", "staging.sqlite"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("updates prepared attachment state after document_query confirms indexing", async () => {
    const dataDir = makeTmpDir();
    const textPath = join(dataDir, "book.txt");
    try {
      writeFileSync(textPath, "Book summary\n\nA story about identity and isolation.", "utf-8");
      const documentStore = new DocumentStore({
        dataDir: join(dataDir, "documents"),
        preferCli: false,
      });
      const registered = await documentStore.registerAttachments([{ path: textPath, name: "book.txt" }]);
      const preparedAttachmentRegistry = new PreparedAttachmentRegistry();
      const serviceProvider: LlmProvider = {
        name: "service-mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn(),
      };
      const documentContextBackend = {
        search: vi.fn().mockImplementation(async ({ attachedDocuments }: { attachedDocuments: Array<{ documentId: string; originalPath: string }> }) => {
          const documentId = attachedDocuments[0]!.documentId;
          const indexDir = join(documentStore.documentsDir, documentId);
          writeFileSync(join(indexDir, "vector-index.json"), JSON.stringify({ indexed: true }), "utf-8");
          return {
            context: "The document is about identity and isolation.",
            sources: [attachedDocuments[0]!.originalPath],
            confidence: 0.91,
            documentState: {
              status: "sufficient",
              insufficientEvidence: false,
              warnings: [],
            },
          };
        }),
      } as unknown as import("../../src/documents/document-context-backend.js").DocumentContextBackend;
      const preparedAttachmentService = new PreparedAttachmentService({
        registry: preparedAttachmentRegistry,
        documentStore,
        provider: serviceProvider,
        documentContextBackend,
      });
      const documentSkill = createDocumentSkill({ preparedAttachmentService });
      const toolExecutor = createToolExecutor(documentSkill.tools);

      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("summarize the attached document"),
                approach: "use document_query",
                work_mode: "document_lookup",
              }),
            };
          }
          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "summarize the document",
                tools_hint: ["document_query"],
                success_criteria: "document query returns the document subject",
                context: "Use the prepared book.txt attachment.",
              }),
            };
          }
          if (callCount === 3) {
            return {
              type: "tool_calls",
              calls: [{
                id: "tc1",
                name: "document_query",
                input: { query: "What is this document about?" },
              }],
            };
          }
          if (callCount === 4) {
            return { type: "assistant", content: "The document is about identity and isolation." };
          }
          if (callCount === 5) {
            return { type: "assistant", content: taskVerifyResponse("done", "document query returned the requested summary") };
          }
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "The document is about identity and isolation.",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
        userMessageOverride: "what is this document about",
        attachedDocuments: registered.documents,
        documentStore,
        preparedAttachmentRegistry,
      });

      expect(result.status).toBe("completed");
      const persisted = JSON.parse(readFileSync(join(result.runPath, "state.json"), "utf-8")) as {
        preparedAttachments?: Array<{ unstructured?: { indexed?: boolean } }>;
      };
      expect(persisted.preparedAttachments?.[0]?.unstructured?.indexed).toBe(true);
      expect(existsSync(join(documentStore.documentsDir, registered.documents[0]!.documentId, "vector-index.json"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("restores an active session attachment in a follow-up run without re-upload", async () => {
    const dataDir = makeTmpDir();
    const csvPath = join(dataDir, "employees.csv");
    const sessionMemory = new MemoryManager({ dataDir: join(dataDir, "memory") });
    sessionMemory.initialize("c1");
    try {
      writeFileSync(csvPath, "name,state\nLila,Maharashtra\nAsha,Kerala\n", "utf-8");
      const documentStore = new DocumentStore({
        dataDir: join(dataDir, "documents"),
        preferCli: false,
      });
      const preparedAttachmentRegistry = new PreparedAttachmentRegistry();
      const registered = await documentStore.registerAttachments([{ path: csvPath, name: "employees.csv" }]);

      const firstRunHandle = sessionMemory.beginRun("c1", "please remember this csv");
      const firstProvider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockResolvedValue({
          type: "assistant",
          content: JSON.stringify({
            done: true,
            summary: "I have the CSV ready.",
            status: "completed",
          }),
        }),
      };

      await agentLoop({
        provider: firstProvider,
        toolExecutor: createToolExecutor([]),
        toolDefinitions: [],
        sessionMemory,
        runHandle: firstRunHandle,
        clientId: "c1",
        dataDir,
        userMessageOverride: "please remember this csv",
        attachedDocuments: registered.documents,
        documentStore,
        preparedAttachmentRegistry,
      });

      const preparedAttachmentService = new PreparedAttachmentService({
        registry: preparedAttachmentRegistry,
        documentStore,
        provider: firstProvider,
      });
      const sessionAttachmentService = new SessionAttachmentService({
        sessionMemory,
        preparedAttachmentRegistry,
        dataDir,
      });
      const attachmentSkill = createAttachmentSkill({ sessionAttachmentService });
      const datasetSkill = createDatasetSkill({ preparedAttachmentService });
      const toolExecutor = createToolExecutor([...attachmentSkill.tools, ...datasetSkill.tools]);
      const restoredPreparedInputId = `att_1_${registered.documents[0]!.documentId.slice(0, 8)}`;

      const secondRunHandle = sessionMemory.beginRun("c1", "how many people are from Maharashtra in that csv");
      let callCount = 0;
      const secondProvider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input) => {
          callCount++;
          if (callCount === 1) {
            const prompt = (input as { messages: Array<{ role: string; content: string }> }).messages.find((message) => message.role === "user")?.content ?? "";
            expect(prompt).toContain("Active session attachments (1):");
            expect(prompt).toContain("employees.csv");
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("count employees from Maharashtra using the previous csv"),
                approach: "restore the active session attachment and query it",
                work_mode: "structured_data_process",
              }),
            };
          }
          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "restore the previous csv and count Maharashtra rows",
                tools_hint: ["restore_attachment_context", "dataset_query"],
                success_criteria: "the previous csv is restored and the count is returned",
                context: "Use the active session attachment for employees.csv.",
              }),
            };
          }
          if (callCount === 3) {
            return {
              type: "tool_calls",
              calls: [{ id: "tc1", name: "restore_attachment_context", input: { reference: "employees.csv" } }],
            };
          }
          if (callCount === 4) {
            return {
              type: "tool_calls",
              calls: [{ id: "tc2", name: "dataset_query", input: { sql: `SELECT COUNT(*) AS employee_count FROM staging_${restoredPreparedInputId} WHERE state = 'Maharashtra'` } }],
            };
          }
          if (callCount === 5) {
            return { type: "assistant", content: "There is 1 person from Maharashtra." };
          }
          if (callCount === 6) {
            return { type: "assistant", content: taskVerifyResponse("done", "the restored csv returned the requested count") };
          }
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "There is 1 person from Maharashtra.",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider: secondProvider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        sessionMemory,
        runHandle: secondRunHandle,
        clientId: "c1",
        dataDir,
        userMessageOverride: "how many people are from Maharashtra in that csv",
        documentStore,
        preparedAttachmentRegistry,
      });

      expect(result.status).toBe("completed");
      expect(result.content).toContain("1 person");
      const persisted = JSON.parse(readFileSync(join(result.runPath, "state.json"), "utf-8")) as {
        preparedAttachments?: Array<{ displayName?: string; structured?: { staged?: boolean } }>;
      };
      expect(persisted.preparedAttachments?.[0]?.displayName).toBe("employees.csv");
      expect(persisted.preparedAttachments?.[0]?.structured?.staged).toBe(true);
    } finally {
      await sessionMemory.shutdown();
      cleanup();
    }
  });

  it("uses the canonical runHandle run id for prepared attachment registration and run path", async () => {
    const dataDir = makeTmpDir();
    const csvPath = join(dataDir, "employees.csv");
    try {
      writeFileSync(csvPath, "name,salary\nLila,42000\n", "utf-8");
      const documentStore = new DocumentStore({
        dataDir: join(dataDir, "documents"),
        preferCli: false,
      });
      const registered = await documentStore.registerAttachments([{ path: csvPath, name: "employees.csv" }]);
      const preparedAttachmentRegistry = new PreparedAttachmentRegistry();
      const runHandle = { sessionId: "s1", runId: "canonical-run-id" };

      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("inspect canonical run id"),
                approach: "review the prepared metadata",
                work_mode: "structured_data_process",
              }),
            };
          }
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Prepared metadata is available.",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle,
        clientId: "c1",
        dataDir,
        userMessageOverride: "inspect the attached csv",
        attachedDocuments: registered.documents,
        documentStore,
        preparedAttachmentRegistry,
      });

      expect(result.runPath).toBe(join(dataDir, "runs", runHandle.runId));
      const persisted = JSON.parse(readFileSync(join(result.runPath, "state.json"), "utf-8")) as {
        runId?: string;
      };
      expect(persisted.runId).toBe(runHandle.runId);
      const registeredAttachments = preparedAttachmentRegistry.getRunAttachments(runHandle.runId);
      expect(registeredAttachments).toHaveLength(1);
      expect(registeredAttachments[0]!.summary.displayName).toBe("employees.csv");
    } finally {
      cleanup();
    }
  });

  it("supports prepared attachment prompts in HTTP upload flows", async () => {
    const dataDir = makeTmpDir();
    const attachmentPath = join(dataDir, "resume.txt");
    try {
      writeFileSync(attachmentPath, "Policy\n\nTermination requires 30 days notice.", "utf-8");
      const documentStore = new DocumentStore({
        dataDir: join(dataDir, "documents"),
        preferCli: false,
      });
      const registered = await documentStore.registerAttachments([{ path: attachmentPath, name: "resume.txt" }]);
      const preparedAttachmentRegistry = new PreparedAttachmentRegistry();

      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("check the prepared uploaded attachment"),
                approach: "use the prepared uploaded attachment",
              }),
            };
          }

          const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
          const prompt = messages.find((message) => message.role === "user")?.content ?? "";
          expect(prompt).toContain("Prepared attachments available (1):");
          expect(prompt).toContain("resume.txt | kind=txt | mode=unstructured_text | status=ready");
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "The prepared uploaded attachment is visible to the agent.",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
        userMessageOverride: "can you see the uploaded attachment",
        attachedDocuments: registered.documents,
        documentStore,
        preparedAttachmentRegistry,
      });

      expect(result.status).toBe("completed");
      expect(result.content).toContain("visible to the agent");
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
    }
  });

  it("reuses a failed non-document scout summary instead of rerunning the same context_search", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("find the missing detail"),
                approach: "look up context first",
              }),
            };
          }

          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                context_search: true,
                query: "Need more details",
                scope: "run_artifacts",
              }),
            };
          }

          if (callCount === 3) {
            return {
              type: "tool_calls",
              calls: [
                { id: "tc1", name: "list_directory", input: { path: dataDir } },
              ],
            };
          }

          const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
          const prompt = messages.find((message) => message.role === "user")?.content ?? "";

          if (callCount === 4) {
            expect(prompt).toContain("Context search status: max_turns_exhausted");
            expect(prompt).toContain("What was searched:");
            expect(prompt).toContain(dataDir);
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                context_search: true,
                query: "Need more details",
                scope: "run_artifacts",
              }),
            };
          }

          expect(prompt).toContain("Repeat blocked: do not run the same context_search again in this iteration");
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "I couldn't find additional details after the repeated lookup was blocked.",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
        config: {
          maxScoutTurns: 1,
        },
      });

      expect(result.status).toBe("completed");
      expect(result.content).toContain("repeated lookup was blocked");
      expect(provider.generateTurn).toHaveBeenCalledTimes(5);
    } finally {
      cleanup();
    }
  });

  it("fails when context search requests exceed per-iteration limit", async () => {
    const dataDir = makeTmpDir();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          // Call 1: understand
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("respond"),
                approach: "respond directly",
              }),
            };
          }
          // Call 2: direct → step
          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                intent: "draft response",
                tools_hint: [],
                success_criteria: "response drafted",
                context: "",
              }),
            };
          }
          // Call 3: act
          if (callCount === 3) {
            return { type: "assistant", content: "Drafted response" };
          }
          // Call 4: task verification
          if (callCount === 4) {
            return { type: "assistant", content: taskVerifyResponse("not_done") };
          }
          // Call 5+: always context_search (and scout returns immediately)
          // Odd calls (5, 7, ...): context_search from direct
          // Even calls (6, 8, ...): scout immediate text response
          if (callCount % 2 === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                context_search: true,
                query: "Need more details",
                scope: "run_artifacts",
              }),
            };
          }
          return {
            type: "assistant",
            content: JSON.stringify({
              context: "Some context",
              sources: [],
              confidence: 0.5,
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
        config: {
          maxScoutCallsPerIteration: 1,
        },
      });

      expect(result.status).toBe("failed");
      expect(result.content).toContain("controller requested context_search too many times");
      expect(result.totalIterations).toBe(2);
    } finally {
      cleanup();
    }
  });
});
