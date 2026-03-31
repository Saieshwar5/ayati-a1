import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runContextScout } from "../../src/ivec/context-scout.js";
import type { ScoutKnownLocations, ContextScoutOptions } from "../../src/ivec/context-scout.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import { DocumentStore } from "../../src/documents/document-store.js";
import { DocumentContextBackend } from "../../src/documents/document-context-backend.js";
import { DocumentIndexer } from "../../src/documents/document-indexer.js";
import { DocumentRetriever } from "../../src/documents/document-retriever.js";
import type {
  DocumentChunkVectorMatch,
  DocumentChunkVectorRecord,
  DocumentEmbeddingProvider,
  DocumentVectorSearchInput,
  DocumentVectorStore,
} from "../../src/documents/document-vector-types.js";

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

class InMemoryDocumentVectorStore implements DocumentVectorStore {
  readonly records: DocumentChunkVectorRecord[] = [];
  upsertCalls = 0;
  searchCalls = 0;

  async upsertDocumentChunks(records: DocumentChunkVectorRecord[]): Promise<void> {
    this.upsertCalls++;
    this.records.push(...records);
  }

  async search(input: DocumentVectorSearchInput): Promise<DocumentChunkVectorMatch[]> {
    this.searchCalls++;
    const recordBySource = [...this.records]
      .filter((record) => input.documentIds.includes(record.documentId))
      .filter((record) => record.embeddingModel === input.embeddingModel)
      .map((record) => ({
        record,
        score: cosineSimilarity(input.vector, record.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit);

    return recordBySource.map(({ record, score }) => ({
      id: record.id,
      documentId: record.documentId,
      sourceId: record.sourceId,
      documentName: record.documentName,
      documentPath: record.documentPath,
      location: record.location,
      text: record.text,
      tokens: record.tokens,
      score,
    }));
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
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
          context: "Found state.json with running status",
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

    expect(result.context).toBe("Found state.json with running status");
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
          context: "Run is in running status",
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
    expect(result.context).toContain("running");
    expect(provider.generateTurn).toHaveBeenCalledTimes(2);
  });

  it("returns a negative summary when maxTurns exhausted", async () => {
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

    expect(result.context).toContain("Context search status: max_turns_exhausted");
    expect(result.context).toContain("What was searched:");
    expect(result.context).toContain(tmpDir);
    expect(result.sources).toContain(tmpDir);
    expect(result.confidence).toBe(0);
    expect(result.scoutState?.status).toBe("max_turns_exhausted");
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

    expect(result.context).toBe("I couldn't find any relevant files for this query.");
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
          context: "File not found",
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
          context: "Found shell command reference in step 1",
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

  it("allows relative file paths inside the scoped run directory", async () => {
    const provider = createMockProvider([
      {
        type: "tool_calls",
        calls: [
          { id: "tc1", name: "read_file", input: { path: "steps/001-act.md" } },
        ],
      },
      {
        type: "assistant",
        content: JSON.stringify({
          context: "Found step details",
          sources: ["steps/001-act.md"],
          confidence: 0.9,
        }),
      },
    ]);

    await runContextScout(
      { provider, maxTurns: 5 },
      "Read the current step details",
      "run_artifacts",
      createLocations(tmpDir),
    );

    const calls = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallInput = calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    const toolResultMsg = secondCallInput.messages.find((m) => m.role === "tool");
    expect(toolResultMsg?.content).toContain("Ran shell command ls");
  });

  it("blocks read_file outside the project_context scope", async () => {
    const outsideFile = join(tmpDir, "outside.txt");
    writeFileSync(outsideFile, "secret", "utf-8");

    const provider = createMockProvider([
      {
        type: "tool_calls",
        calls: [
          { id: "tc1", name: "read_file", input: { path: outsideFile } },
        ],
      },
      {
        type: "assistant",
        content: JSON.stringify({
          context: "blocked",
          sources: [],
          confidence: 0,
        }),
      },
    ]);

    await runContextScout(
      { provider, maxTurns: 5 },
      "Read an unrelated file",
      "project_context",
      createLocations(tmpDir),
    );

    const calls = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallInput = calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    const toolResultMsg = secondCallInput.messages.find((m) => m.role === "tool");
    expect(toolResultMsg?.content).toContain("[error] path outside allowed scope (project_context)");
  });

  it("blocks search_content outside the run_artifacts scope", async () => {
    const provider = createMockProvider([
      {
        type: "tool_calls",
        calls: [
          { id: "tc1", name: "search_content", input: { directory: tmpDir, pattern: "shell" } },
        ],
      },
      {
        type: "assistant",
        content: JSON.stringify({
          context: "blocked",
          sources: [],
          confidence: 0,
        }),
      },
    ]);

    await runContextScout(
      { provider, maxTurns: 5 },
      "Search outside the run",
      "run_artifacts",
      createLocations(tmpDir),
    );

    const calls = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallInput = calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    const toolResultMsg = secondCallInput.messages.find((m) => m.role === "tool");
    expect(toolResultMsg?.content).toContain("[error] directory outside allowed scope (run_artifacts)");
  });

  it("keeps both scope limited to known scout roots", async () => {
    const outsideFile = join(tmpDir, "outside.txt");
    writeFileSync(outsideFile, "secret", "utf-8");

    const provider = createMockProvider([
      {
        type: "tool_calls",
        calls: [
          { id: "tc1", name: "grep_file", input: { path: outsideFile, pattern: "secret" } },
        ],
      },
      {
        type: "assistant",
        content: JSON.stringify({
          context: "blocked",
          sources: [],
          confidence: 0,
        }),
      },
    ]);

    await runContextScout(
      { provider, maxTurns: 5 },
      "Read a file outside known roots",
      "both",
      createLocations(tmpDir),
    );

    const calls = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallInput = calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    const toolResultMsg = secondCallInput.messages.find((m) => m.role === "tool");
    expect(toolResultMsg?.content).toContain("[error] path outside allowed scope (both)");
  });

  it("grep_file returns targeted snippets from a known file", async () => {
    const locs = createLocations(tmpDir);
    const skillDir = join(tmpDir, "skills");
    locs.skillsDir = skillDir;
    mkdirSync(skillDir, { recursive: true });
    const skillFile = join(skillDir, "playwright.skill.md");
    writeFileSync(
      skillFile,
      [
        "# Playwright Skill",
        "Setup instructions",
        "Run npx playwright install before screenshots",
        "Usage example",
        "Run npx playwright test",
      ].join("\n"),
    );

    const provider = createMockProvider([
      {
        type: "tool_calls",
        calls: [
          {
            id: "tc1",
            name: "grep_file",
            input: { path: skillFile, pattern: "playwright install", context_before: 1, context_after: 1 },
          },
        ],
      },
      {
        type: "assistant",
        content: JSON.stringify({
          context: "Found install instructions in the skill file",
          sources: [skillFile],
          confidence: 0.92,
        }),
      },
    ]);

    const result = await runContextScout(
      { provider, maxTurns: 5 },
      "Find install instructions in the known skill file",
      "both",
      locs,
    );

    expect(result.confidence).toBe(0.92);

    const calls = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallInput = calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    const toolResultMsg = secondCallInput.messages.find((m) => m.role === "tool");
    expect(toolResultMsg?.content).toContain("Match 1");
    expect(toolResultMsg?.content).toContain("Run npx playwright install before screenshots");
    expect(toolResultMsg?.content).toContain("Usage example");
  });

  it("grep_file reports invalid regex errors", async () => {
    const locs = createLocations(tmpDir);
    const provider = createMockProvider([
      {
        type: "tool_calls",
        calls: [
          { id: "tc1", name: "grep_file", input: { path: join(locs.runPath, "steps", "001-act.md"), pattern: "[" } },
        ],
      },
      {
        type: "assistant",
        content: JSON.stringify({
          context: "regex invalid",
          sources: [],
          confidence: 0,
        }),
      },
    ]);

    await runContextScout(
      { provider, maxTurns: 5 },
      "Find invalid regex handling",
      "run_artifacts",
      locs,
    );

    const calls = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallInput = calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    const toolResultMsg = secondCallInput.messages.find((m) => m.role === "tool");
    expect(toolResultMsg?.content).toContain("[error] invalid regex");
  });

  it("grep_file respects max_matches and returns focused blocks", async () => {
    const locs = createLocations(tmpDir);
    const stepFile = join(locs.runPath, "steps", "002-verify.md");
    writeFileSync(
      stepFile,
      [
        "# Verify",
        "error: first issue",
        "details one",
        "ok line",
        "error: second issue",
        "details two",
        "error: third issue",
        "details three",
      ].join("\n"),
    );

    const provider = createMockProvider([
      {
        type: "tool_calls",
        calls: [
          {
            id: "tc1",
            name: "grep_file",
            input: { path: stepFile, pattern: "error:", context_before: 0, context_after: 1, max_matches: 2 },
          },
        ],
      },
      {
        type: "assistant",
        content: JSON.stringify({
          context: "Found two error blocks",
          sources: [stepFile],
          confidence: 0.88,
        }),
      },
    ]);

    await runContextScout(
      { provider, maxTurns: 5 },
      "Find the first two error blocks",
      "run_artifacts",
      locs,
    );

    const calls = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallInput = calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    const toolResultMsg = secondCallInput.messages.find((m) => m.role === "tool");
    expect(toolResultMsg?.content).toContain("error: first issue");
    expect(toolResultMsg?.content).toContain("error: second issue");
    expect(toolResultMsg?.content).not.toContain("error: third issue");
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
          context: "Found soul.json in context directory",
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
          context: "ok",
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
    expect(systemPrompt).toContain("Use search_content to discover which file matters");
    expect(systemPrompt).toContain("Use grep_file to narrow within a known file");
    expect(systemPrompt).toContain("Use read_file only when you need a larger block");
    expect(systemPrompt).toContain("Allowed roots for this scope:");
    expect(systemPrompt).toContain("Any tool call that targets a path outside the allowed roots will fail.");
  });

  it("routes document scope through the document backend and returns bounded evidence", async () => {
    const locs = createLocations(tmpDir);
    const attachmentPath = join(tmpDir, "policy.txt");
    writeFileSync(
      attachmentPath,
      [
        "Service Terms",
        "",
        "Termination requires 30 days written notice before cancellation.",
        "",
        "Payments are due within 15 days of invoice receipt.",
      ].join("\n"),
      "utf-8",
    );

    const store = new DocumentStore({
      dataDir: join(tmpDir, "managed-documents"),
      preferCli: false,
    });
    const registered = await store.registerAttachments([{ path: attachmentPath, name: "policy.txt" }]);
    const prepared = await store.prepareDocuments(registered.documents);
    const chunkId = prepared[0]?.chunks[0]?.sourceId;
    expect(chunkId).toBeTruthy();

    const provider = createMockProvider([
      {
        type: "assistant",
        content: JSON.stringify({
          items: [
            {
              sourceId: chunkId,
              fact: "Termination requires 30 days written notice before cancellation.",
              quote: "Termination requires 30 days written notice before cancellation.",
              relevance: 0.95,
              confidence: 0.9,
            },
          ],
          dropped_noise_count: 0,
          insufficient_evidence: false,
        }),
      },
    ]);

    const backend = new DocumentContextBackend({ store });
    const result = await runContextScout(
      { provider, maxTurns: 5, documentContextBackend: backend },
      "What is the termination clause?",
      "documents",
      {
        ...locs,
        attachedDocuments: registered.documents,
      },
      [attachmentPath],
    );

    expect(result.context).toContain("Termination requires 30 days written notice");
    expect(result.sources).toEqual([attachmentPath]);
    expect(result.confidence).toBe(0.9);
    expect(result.documentState?.status).toBe("sufficient");
    expect(provider.generateTurn).toHaveBeenCalledTimes(1);
  });

  it("matches uploaded web documents when document_paths references the saved upload path", async () => {
    const locs = createLocations(tmpDir);
    const documentsDir = join(tmpDir, "managed-web-documents");
    const uploadPath = join(documentsDir, "uploads", "upload-1", "policy.txt");
    mkdirSync(join(documentsDir, "uploads", "upload-1"), { recursive: true });
    writeFileSync(
      uploadPath,
      [
        "Service Terms",
        "",
        "Termination requires 45 days written notice before cancellation.",
      ].join("\n"),
      "utf-8",
    );

    const store = new DocumentStore({
      dataDir: documentsDir,
      preferCli: false,
    });
    const uploadedBytes = Buffer.byteLength(readFileSync(uploadPath, "utf-8"));
    const registered = await store.registerAttachments([
      {
        source: "web",
        uploadedPath: uploadPath,
        originalName: "policy.txt",
        mimeType: "text/plain",
        sizeBytes: uploadedBytes,
      },
    ]);
    const prepared = await store.prepareDocuments(registered.documents);
    const chunkId = prepared[0]?.chunks[0]?.sourceId;
    expect(chunkId).toBeTruthy();

    const provider = createMockProvider([
      {
        type: "assistant",
        content: JSON.stringify({
          items: [
            {
              sourceId: chunkId,
              fact: "Termination requires 45 days written notice before cancellation.",
              quote: "Termination requires 45 days written notice before cancellation.",
              relevance: 0.97,
              confidence: 0.93,
            },
          ],
          dropped_noise_count: 0,
          insufficient_evidence: false,
        }),
      },
    ]);

    const backend = new DocumentContextBackend({ store });
    const result = await runContextScout(
      { provider, maxTurns: 5, documentContextBackend: backend },
      "What is the termination clause?",
      "documents",
      {
        ...locs,
        attachedDocuments: registered.documents,
      },
      [uploadPath],
    );

    expect(result.context).toContain("45 days written notice");
    expect(result.sources).toEqual([uploadPath]);
    expect(result.confidence).toBe(0.93);
    expect(result.documentState?.status).toBe("sufficient");
  });

  it("treats multi-topic attachment questions as broad document retrieval", async () => {
    const locs = createLocations(tmpDir);
    const attachmentPath = join(tmpDir, "resume.txt");
    writeFileSync(
      attachmentPath,
      [
        "Profile",
        "Sai Eshwar is a software engineer.",
        "",
        "Skills",
        "TypeScript, Node.js, React, testing, debugging",
        "",
        "Education",
        "B.Tech in Computer Science",
      ].join("\n"),
      "utf-8",
    );

    const store = new DocumentStore({
      dataDir: join(tmpDir, "broad-documents"),
      preferCli: false,
    });
    const registered = await store.registerAttachments([{ path: attachmentPath, name: "resume.txt" }]);

    const provider: LlmProvider = {
      name: "mock",
      version: "1.0.0",
      capabilities: { nativeToolCalling: true },
      start: vi.fn(),
      stop: vi.fn(),
      generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
        const message = input.messages.find((entry) => entry.role === "user")?.content ?? "";
        expect(message).toContain("Skills");
        expect(message).toContain("Education");
        return {
          type: "assistant",
          content: JSON.stringify({
            items: [],
            dropped_noise_count: 0,
            insufficient_evidence: true,
          }),
        };
      }),
    };

    const backend = new DocumentContextBackend({ store });
    const result = await runContextScout(
      { provider, maxTurns: 5, documentContextBackend: backend },
      "what are the skills and qualifications of sai eshwar",
      "documents",
      {
        ...locs,
        attachedDocuments: registered.documents,
      },
      [attachmentPath],
    );

    expect(result.context).toContain("Skills");
    expect(result.context).toContain("Education");
    expect(result.documentState?.status).toBe("partial");
    expect(provider.generateTurn).toHaveBeenCalledTimes(1);
  });

  it("uses vector retrieval for large documents before evidence extraction", async () => {
    const locs = createLocations(tmpDir);
    const attachmentPath = join(tmpDir, "handbook.txt");
    writeFileSync(
      attachmentPath,
      [
        "Company handbook overview.\f",
        "Billing details and payment schedules.\f",
        "Termination requires 45 days written notice before cancellation.\f",
        "Support is available on weekdays.",
      ].join("\n"),
      "utf-8",
    );

    const store = new DocumentStore({
      dataDir: join(tmpDir, "vector-documents"),
      preferCli: false,
    });
    const registered = await store.registerAttachments([{ path: attachmentPath, name: "handbook.txt" }]);
    const prepared = await store.prepareDocuments(registered.documents);
    const terminationChunk = prepared[0]?.chunks.find((chunk) => chunk.text.includes("45 days written notice"));
    expect(terminationChunk).toBeTruthy();

    const vectorStore = new InMemoryDocumentVectorStore();
    const embedder: DocumentEmbeddingProvider = {
      modelName: "test-embedding-model",
      embed: vi.fn(async (text: string) => text.toLowerCase().includes("termination") ? [1, 0] : [0, 1]),
      embedBatch: vi.fn(async (texts: string[]) => texts.map((text) => text.toLowerCase().includes("termination") ? [1, 0] : [0, 1])),
    };
    const backend = new DocumentContextBackend({
      store,
      documentIndexer: new DocumentIndexer({
        embedder,
        store: vectorStore,
        documentsDir: store.documentsDir,
      }),
      documentRetriever: new DocumentRetriever({
        embedder,
        store: vectorStore,
      }),
      largeDocumentMinChunks: 3,
    });
    const provider = createMockProvider([
      {
        type: "assistant",
        content: JSON.stringify({
          items: [
            {
              sourceId: terminationChunk?.sourceId,
              fact: "Termination requires 45 days written notice before cancellation.",
              quote: "Termination requires 45 days written notice before cancellation.",
              relevance: 0.97,
              confidence: 0.94,
            },
          ],
          dropped_noise_count: 0,
          insufficient_evidence: false,
        }),
      },
    ]);

    const result = await runContextScout(
      { provider, maxTurns: 5, documentContextBackend: backend },
      "What is the termination clause?",
      "documents",
      {
        ...locs,
        attachedDocuments: registered.documents,
      },
      [attachmentPath],
    );

    expect(result.context).toContain("45 days written notice");
    expect(result.documentState?.status).toBe("sufficient");
    expect(vectorStore.upsertCalls).toBe(1);
    expect(vectorStore.searchCalls).toBe(1);
  });

  it("returns document unavailable state when no document backend is configured", async () => {
    const result = await runContextScout(
      { provider: createMockProvider([]), maxTurns: 5 },
      "what is in the attachment",
      "documents",
      createLocations(tmpDir),
    );

    expect(result.documentState?.status).toBe("unavailable");
    expect(result.context).toContain("unavailable");
    expect(result.confidence).toBe(0);
  });
});
