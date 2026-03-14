import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentLoop } from "../../src/ivec/agent-loop.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { SessionMemory, MemoryRunHandle } from "../../src/memory/types.js";
import { DocumentStore } from "../../src/documents/document-store.js";
import { DocumentContextBackend } from "../../src/documents/document-context-backend.js";
import type { ManagedDocumentManifest } from "../../src/documents/types.js";

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
    getPromptMemoryContext: vi.fn().mockReturnValue({
      conversationTurns: [{ role: "user", content: "hello", timestamp: "", sessionPath: "" }],
      previousSessionSummary: "",
      recentRunLedgers: [],
    }),
    setStaticTokenBudget: vi.fn(),
  };
}

function createAttachedDocument(path: string, name = "resume.pdf"): ManagedDocumentManifest {
  return {
    documentId: "doc-1",
    name,
    originalPath: path,
    storedPath: path,
    kind: "pdf",
    sizeBytes: 1024,
    checksum: "checksum-1",
  };
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
      expect(provider.generateTurn).toHaveBeenCalledTimes(11);

      const cachePath = join(result.runPath, "context-cache.json");
      expect(existsSync(cachePath)).toBe(true);
      const cache = JSON.parse(readFileSync(cachePath, "utf-8")) as {
        entries: Array<{ scope: string; targets: string[] }>;
      };
      expect(cache.entries).toHaveLength(1);
      expect(cache.entries[0]?.scope).toBe("run_artifacts");
      expect(cache.entries[0]?.targets).toContain("run_artifacts:step:1");
    } finally {
      cleanup();
    }
  });

  it("preloads attached document context before the first direct decision", async () => {
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
      const prepared = await documentStore.prepareDocuments(registered.documents);
      const chunkId = prepared[0]?.chunks[0]?.sourceId;
      expect(chunkId).toBeTruthy();

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
                approach: "use shell to search",
              }),
            };
          }
          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                items: [
                  {
                    sourceId: chunkId,
                    fact: "Termination requires 30 days written notice before cancellation.",
                    quote: "Termination requires 30 days written notice before cancellation.",
                    relevance: 0.95,
                    confidence: 0.88,
                  },
                ],
                dropped_noise_count: 0,
                insufficient_evidence: false,
              }),
            };
          }
          const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
          const prompt = messages.find((message) => message.role === "user")?.content ?? "";
          if (!prompt.includes("Termination requires 30 days written notice before cancellation.")) {
            throw new Error("Expected direct prompt to receive document scout context");
          }
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
        documentContextBackend: new DocumentContextBackend({ store: documentStore }),
      });

      expect(result.status).toBe("completed");
      expect(result.content).toContain("30 days written notice");
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
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

  it("reuses sufficient attached-document evidence instead of rerunning document context search", async () => {
    const dataDir = makeTmpDir();
    const attachmentPath = join(dataDir, "resume.pdf");
    try {
      writeFileSync(attachmentPath, "placeholder", "utf-8");
      const attachedDocuments = [createAttachedDocument(attachmentPath)];
        const documentContextBackend = {
          search: vi.fn().mockResolvedValue({
            context: "1. Sai Eshwar worked as a software engineer building Node.js services.",
            sources: [attachmentPath],
            confidence: 0.91,
            documentState: {
            status: "sufficient",
            insufficientEvidence: false,
            warnings: [],
          },
        }),
      } as unknown as DocumentContextBackend;

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
                approach: "search the document",
              }),
            };
          }

          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                context_search: true,
                query: "Extract the full work experience section from resume.pdf",
                scope: "documents",
                document_paths: [attachmentPath],
              }),
            };
          }

          const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
          const prompt = messages.find((message) => message.role === "user")?.content ?? "";
          expect(prompt).toContain("Document retrieval status: sufficient");
          expect(prompt).toContain("Do not request another document context search");
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Sai Eshwar worked as a software engineer building Node.js services.",
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
        userMessageOverride: "what is the sai eshwar working experience",
        attachedDocuments,
        documentContextBackend,
      });

      expect(result.status).toBe("completed");
      expect(result.content).toContain("software engineer");
      expect(documentContextBackend.search).toHaveBeenCalledTimes(1);
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
    } finally {
      cleanup();
    }
  });

  it("allows one narrower document retry when the initial attachment evidence is partial", async () => {
    const dataDir = makeTmpDir();
    const attachmentPath = join(dataDir, "resume.pdf");
    try {
      writeFileSync(attachmentPath, "placeholder", "utf-8");
      const attachedDocuments = [createAttachedDocument(attachmentPath)];
      const documentContextBackend = {
        search: vi.fn()
          .mockResolvedValueOnce({
            context: "The resume appears to describe a software profile, but the relevant section is incomplete.",
            sources: [attachmentPath],
            confidence: 0.52,
            documentState: {
              status: "partial",
              insufficientEvidence: true,
              warnings: [],
            },
          })
          .mockResolvedValueOnce({
            context: "1. Skills include TypeScript, Node.js, React, and testing.",
            sources: [attachmentPath],
            confidence: 0.9,
            documentState: {
              status: "sufficient",
              insufficientEvidence: false,
              warnings: [],
            },
          }),
      } as unknown as DocumentContextBackend;

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
                approach: "use the attached resume",
              }),
            };
          }

          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                context_search: true,
                query: "Extract the skills section from resume.pdf",
                scope: "documents",
                document_paths: [attachmentPath],
              }),
            };
          }

          const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
          const prompt = messages.find((message) => message.role === "user")?.content ?? "";
          expect(prompt).toContain("Document retrieval status: sufficient");
          expect(prompt).toContain("TypeScript, Node.js, React, and testing");
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Sai Eshwar's skills include TypeScript, Node.js, React, and testing.",
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
        userMessageOverride: "tell me about sai eshwar",
        attachedDocuments,
        documentContextBackend,
      });

      expect(result.status).toBe("completed");
      expect(result.content).toContain("TypeScript");
      expect(documentContextBackend.search).toHaveBeenCalledTimes(2);
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
    } finally {
      cleanup();
    }
  });

  it("surfaces empty attached-document retrieval as a not-found outcome after one narrower retry", async () => {
    const dataDir = makeTmpDir();
    const attachmentPath = join(dataDir, "resume.pdf");
    try {
      writeFileSync(attachmentPath, "placeholder", "utf-8");
      const attachedDocuments = [createAttachedDocument(attachmentPath)];
      const documentContextBackend = {
        search: vi.fn().mockResolvedValue({
          context: "No relevant document context was found for this query.",
          sources: [attachmentPath],
          confidence: 0,
          documentState: {
            status: "empty",
            insufficientEvidence: true,
            warnings: [],
          },
        }),
      } as unknown as DocumentContextBackend;

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
                goal: goalContract("check whether the attachment contains the requested detail"),
                approach: "use the attachment",
              }),
            };
          }

          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                context_search: true,
                query: "Find the aws certification section in resume.pdf",
                scope: "documents",
                document_paths: [attachmentPath],
              }),
            };
          }

          const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
          const prompt = messages.find((message) => message.role === "user")?.content ?? "";
          expect(prompt).toContain("Document retrieval status: empty");
          expect(prompt).toContain("requested information was not found");
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "I couldn't find AWS certification information in the attached resume.",
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
        userMessageOverride: "does the attached resume mention an aws certification",
        attachedDocuments,
        documentContextBackend,
      });

      expect(result.status).toBe("completed");
      expect(result.content).toContain("couldn't find AWS certification");
      expect(documentContextBackend.search).toHaveBeenCalledTimes(2);
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
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
