import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runContextScout } from "../../src/ivec/context-scout.js";
import type { ScoutKnownLocations, ContextScoutOptions } from "../../src/ivec/context-scout.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";

function createMockProvider(responses: LlmTurnOutput[]): LlmProvider {
  let callIndex = 0;
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi.fn().mockImplementation(async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      return response;
    }),
  };
}

function createLocations(tmpDir: string): ScoutKnownLocations {
  return {
    runPath: join(tmpDir, "run"),
    contextDir: join(tmpDir, "context"),
    sessionDir: join(tmpDir, "sessions"),
    runId: "r-test",
    activeSessionId: "s-test",
  };
}

describe("runContextScout", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "scout-test-"));
    const locs = createLocations(tmpDir);
    mkdirSync(locs.runPath, { recursive: true });
    mkdirSync(join(locs.runPath, "steps"), { recursive: true });
    mkdirSync(locs.contextDir, { recursive: true });
    mkdirSync(locs.sessionDir!, { recursive: true });
    writeFileSync(join(locs.runPath, "state.json"), JSON.stringify({ runId: "r-test", status: "running" }));
    writeFileSync(join(locs.runPath, "steps", "001-act.md"), "# Step 1 Act\nRan shell command ls");
    writeFileSync(join(locs.contextDir, "soul.json"), JSON.stringify({ name: "Ayati" }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns parsed result when LLM responds with text immediately", async () => {
    const provider = createMockProvider([
      {
        type: "assistant",
        content: JSON.stringify({
          summary: "Found state.json with running status",
          sources: ["state.json"],
          confidence: 0.9,
        }),
      },
    ]);

    const result = await runContextScout(
      { provider, maxTurns: 5 },
      "What is the current run status?",
      "run_artifacts",
      createLocations(tmpDir),
    );

    expect(result.summary).toBe("Found state.json with running status");
    expect(result.sources).toEqual(["state.json"]);
    expect(result.confidence).toBe(0.9);
  });

  it("executes tool calls and feeds results back before getting final answer", async () => {
    const locs = createLocations(tmpDir);
    const provider = createMockProvider([
      {
        type: "tool_calls",
        calls: [
          { id: "tc1", name: "read_file", input: { path: join(locs.runPath, "state.json") } },
        ],
      },
      {
        type: "assistant",
        content: JSON.stringify({
          summary: "Run is in running status",
          sources: ["state.json"],
          confidence: 0.95,
        }),
      },
    ]);

    const result = await runContextScout(
      { provider, maxTurns: 5 },
      "What is the run status?",
      "run_artifacts",
      locs,
    );

    expect(result.confidence).toBe(0.95);
    expect(result.summary).toContain("running");
    expect(provider.generateTurn).toHaveBeenCalledTimes(2);
  });

  it("returns empty result when maxTurns exhausted", async () => {
    const provider = createMockProvider([
      {
        type: "tool_calls",
        calls: [
          { id: "tc1", name: "list_directory", input: { path: tmpDir } },
        ],
      },
    ]);

    const result = await runContextScout(
      { provider, maxTurns: 1 },
      "Find something",
      "both",
      createLocations(tmpDir),
    );

    expect(result.summary).toBe("");
    expect(result.sources).toEqual([]);
    expect(result.confidence).toBe(0);
  });

  it("handles plain text fallback when LLM returns non-JSON text", async () => {
    const provider = createMockProvider([
      {
        type: "assistant",
        content: "I couldn't find any relevant files for this query.",
      },
    ]);

    const result = await runContextScout(
      { provider, maxTurns: 5 },
      "Find logs",
      "run_artifacts",
      createLocations(tmpDir),
    );

    expect(result.summary).toBe("I couldn't find any relevant files for this query.");
    expect(result.confidence).toBe(0.5);
  });

  it("read_file tool handles missing files gracefully", async () => {
    const provider = createMockProvider([
      {
        type: "tool_calls",
        calls: [
          { id: "tc1", name: "read_file", input: { path: "/nonexistent/file.txt" } },
        ],
      },
      {
        type: "assistant",
        content: JSON.stringify({
          summary: "File not found",
          sources: [],
          confidence: 0,
        }),
      },
    ]);

    const result = await runContextScout(
      { provider, maxTurns: 5 },
      "Read missing file",
      "both",
      createLocations(tmpDir),
    );

    expect(result.confidence).toBe(0);

    // Verify the tool result message contained the error
    const calls = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallInput = calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    const toolResultMsg = secondCallInput.messages.find((m) => m.role === "tool");
    expect(toolResultMsg?.content).toContain("[error]");
  });

  it("search_content tool finds matching content", async () => {
    const locs = createLocations(tmpDir);
    const provider = createMockProvider([
      {
        type: "tool_calls",
        calls: [
          { id: "tc1", name: "search_content", input: { directory: locs.runPath, pattern: "shell" } },
        ],
      },
      {
        type: "assistant",
        content: JSON.stringify({
          summary: "Found shell command reference in step 1",
          sources: ["steps/001-act.md"],
          confidence: 0.8,
        }),
      },
    ]);

    const result = await runContextScout(
      { provider, maxTurns: 5 },
      "Find shell commands",
      "run_artifacts",
      locs,
    );

    expect(result.confidence).toBe(0.8);

    // Verify search results were passed back
    const calls = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallInput = calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    const toolResultMsg = secondCallInput.messages.find((m) => m.role === "tool");
    expect(toolResultMsg?.content).toContain("shell");
  });

  it("list_directory tool returns directory entries", async () => {
    const locs = createLocations(tmpDir);
    const provider = createMockProvider([
      {
        type: "tool_calls",
        calls: [
          { id: "tc1", name: "list_directory", input: { path: locs.contextDir } },
        ],
      },
      {
        type: "assistant",
        content: JSON.stringify({
          summary: "Found soul.json in context directory",
          sources: ["context/soul.json"],
          confidence: 0.85,
        }),
      },
    ]);

    const result = await runContextScout(
      { provider, maxTurns: 5 },
      "List context files",
      "project_context",
      locs,
    );

    expect(result.confidence).toBe(0.85);
  });

  it("includes run artifact format guidance in scout system prompt", async () => {
    const locs = createLocations(tmpDir);
    const provider = createMockProvider([
      {
        type: "assistant",
        content: JSON.stringify({
          summary: "ok",
          sources: [],
          confidence: 0.7,
        }),
      },
    ]);

    await runContextScout(
      { provider, maxTurns: 5 },
      "Check older step facts",
      "run_artifacts",
      locs,
    );

    const calls = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls;
    const firstCallInput = calls[0]![0] as { messages: Array<{ role: string; content: string }> };
    const systemPrompt = firstCallInput.messages.find((message) => message.role === "system")?.content ?? "";

    expect(systemPrompt).toContain(`Only search within the run directory: ${locs.runPath}`);
    expect(systemPrompt).toContain("Default to the current run.");
    expect(systemPrompt).toContain(`${locs.runPath}/state.json`);
    expect(systemPrompt).toContain("completedSteps[] has step, intent, outcome, summary, newFacts, artifacts, toolSuccessCount, toolFailureCount");
    expect(systemPrompt).toContain(`${locs.runPath}/steps/<NNN>-act.md`);
    expect(systemPrompt).toContain(`${locs.runPath}/steps/<NNN>-verify.md`);
    expect(systemPrompt).toContain("For run_artifacts queries, read state.json first");
  });
});
