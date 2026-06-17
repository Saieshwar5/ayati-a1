import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmProvider } from "../core/contracts/provider.js";
import type { LlmTurnInput, LlmTokenUsage } from "../core/contracts/llm-protocol.js";
import { DocumentContextBackend } from "../documents/document-context-backend.js";
import { DocumentStore, type PreparedManagedDocument } from "../documents/document-store.js";
import { PreparedAttachmentRegistry } from "../documents/prepared-attachment-registry.js";
import { PreparedAttachmentService } from "../documents/prepared-attachment-service.js";
import type { ManagedDocumentManifest } from "../documents/types.js";
import { agentLoop } from "../ivec/agent-loop.js";
import { noopSessionMemory } from "../memory/provider.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import { createDocumentSkill } from "../skills/builtins/documents/index.js";
import filesystemSkill from "../skills/builtins/filesystem/index.js";
import shellSkill from "../skills/builtins/shell/index.js";
import { createToolExecutor } from "../skills/tool-executor.js";
import type { ToolDefinition } from "../skills/types.js";

type BenchmarkTier = "smoke" | "multistep" | "context_heavy" | "continuation" | "recovery";
type BenchmarkCategory = "direct_reply" | "code_search" | "file_edit" | "coding" | "context" | "follow_up" | "recovery" | "file_handling";
type EstimatedRuntime = "short" | "medium" | "long";

interface QueuedDecision {
  decision: unknown;
  usage?: Omit<LlmTokenUsage, "provider" | "model" | "exact">;
}

interface BenchmarkProviderStats {
  totalCalls: number;
  agentDecisionCalls: number;
  retrievalEvidenceCalls: number;
  retrievalEvidenceEstimatedTokens: number;
}

interface BenchmarkCheck {
  name: string;
  passed: boolean;
  details?: string;
}

interface BenchmarkBudget {
  maxLlmCalls?: number;
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxLatencyMs?: number;
}

interface BenchmarkCaseResult {
  caseId: string;
  title: string;
  tier: BenchmarkTier;
  category: BenchmarkCategory;
  success: boolean;
  latencyMs: number;
  outputDir: string;
  runPath: string;
  workspacePath?: string;
  status: string;
  runClass: string;
  totalIterations: number;
  totalToolCalls: number;
  llmCalls: number;
  totalTokens: number;
  estimatedCostUsd: number;
  totalContextGrowthTokens: number;
  maxContextDeltaTokens: number;
  maxPromptEstimatedTokens: number;
  checks: BenchmarkCheck[];
  budgetResults: BenchmarkCheck[];
  metrics?: Record<string, unknown>;
}

interface BenchmarkRunSummary {
  startedAt: string;
  finishedAt: string;
  outputRoot: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  totalLatencyMs: number;
  averageLatencyMs: number;
  totalLlmCalls: number;
  totalToolCalls: number;
  totalTokens: number;
  totalEstimatedCostUsd: number;
  results: BenchmarkCaseResult[];
}

interface BenchmarkRunContext {
  outputRoot: string;
  pdfOptions: PdfBenchmarkOptions;
}

interface BenchmarkCase {
  id: string;
  title: string;
  tier: BenchmarkTier;
  category: BenchmarkCategory;
  estimatedRuntime: EstimatedRuntime;
  budgets?: BenchmarkBudget;
  run(context: BenchmarkRunContext): Promise<BenchmarkCaseResult>;
}

interface RunCaseInput {
  outputRoot: string;
  caseId: string;
  title: string;
  tier: BenchmarkTier;
  category: BenchmarkCategory;
  userMessage: string;
  providerResponses: QueuedDecision[];
  tools?: ToolDefinition[];
  createTools?: (provider: LlmProvider) => ToolDefinition[];
  workspacePath?: string;
  snapshotWorkspace?: boolean;
  attachedDocuments?: ManagedDocumentManifest[];
  documentStore?: DocumentStore;
  preparedAttachmentRegistry?: PreparedAttachmentRegistry;
  budgets?: BenchmarkBudget;
  writeExtraReports?: (input: {
    outputDir: string;
    result: BenchmarkCaseResult;
    metrics: Record<string, unknown>;
    providerStats: BenchmarkProviderStats;
  }) => Promise<void>;
  checks: (input: {
    result: Awaited<ReturnType<typeof agentLoop>>;
    metrics: Record<string, unknown>;
    outputDir: string;
    workspacePath?: string;
    providerStats: BenchmarkProviderStats;
  }) => Promise<BenchmarkCheck[]>;
}

interface CliOptions {
  outputRoot?: string;
  caseId?: string;
  tier?: BenchmarkTier;
  category?: BenchmarkCategory;
  pdfPaths: string[];
  pdfDir?: string;
  maxPdfs: number;
  requirePdf: boolean;
  list: boolean;
}

interface PdfBenchmarkOptions {
  pdfPaths: string[];
  pdfDir?: string;
  maxPdfs: number;
  requirePdf: boolean;
}

interface PdfSource {
  path: string;
  displayName: string;
  sizeBytes: number;
  checksum: string;
}

interface PdfManifestEntry {
  sourcePath: string;
  benchmarkPath: string;
  displayName: string;
  sizeBytes: number;
  checksum: string;
  documentId?: string;
  preparedInputId?: string;
}

interface DocumentPreparationReport {
  documentId: string;
  displayName: string;
  sizeBytes: number;
  checksum: string;
  status: "ready" | "failed";
  latencyMs: number;
  extractorUsed?: string;
  sectionCount?: number;
  chunkCount?: number;
  warnings: string[];
  error?: string;
}

interface PdfBenchmarkFixture {
  workspacePath: string;
  documentStore: BenchmarkDocumentStore;
  preparedAttachmentRegistry: PreparedAttachmentRegistry;
  attachedDocuments: ManagedDocumentManifest[];
  pdfManifest: PdfManifestEntry[];
}

interface StepTraceEntry {
  step: number;
  type: "tool" | "verification" | "event";
  tool?: string;
  status?: string;
  durationMs?: number;
  input?: unknown;
  outputPreview?: string;
  verificationMethod?: string;
  validationStatus?: string;
  summary?: string;
}

const BENCHMARK_MODEL = "benchmark/mock-decision";
const ALL_TOOLS = [...filesystemSkill.tools, ...shellSkill.tools];

class BenchmarkDocumentStore extends DocumentStore {
  readonly preparationReports: DocumentPreparationReport[] = [];

  override async prepareDocument(manifest: ManagedDocumentManifest): Promise<PreparedManagedDocument> {
    const startedAt = Date.now();
    try {
      const prepared = await super.prepareDocument(manifest);
      this.preparationReports.push({
        documentId: manifest.documentId,
        displayName: manifest.displayName,
        sizeBytes: manifest.sizeBytes,
        checksum: manifest.checksum,
        status: "ready",
        latencyMs: Date.now() - startedAt,
        extractorUsed: prepared.extractorUsed,
        sectionCount: prepared.document.segments.length,
        chunkCount: prepared.chunks.length,
        warnings: [...prepared.document.warnings],
      });
      return prepared;
    } catch (err) {
      this.preparationReports.push({
        documentId: manifest.documentId,
        displayName: manifest.displayName,
        sizeBytes: manifest.sizeBytes,
        checksum: manifest.checksum,
        status: "failed",
        latencyMs: Date.now() - startedAt,
        warnings: [],
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

export async function runAgentHarnessBenchmarks(options: {
  outputRoot?: string;
  caseId?: string;
  tier?: BenchmarkTier;
  category?: BenchmarkCategory;
  pdfPaths?: string[];
  pdfDir?: string;
  maxPdfs?: number;
  requirePdf?: boolean;
} = {}): Promise<BenchmarkRunSummary> {
  const startedAt = new Date();
  const outputRoot = options.outputRoot ?? resolve("data", "benchmarks", "agent-harness", toRunStamp(startedAt));
  await mkdir(outputRoot, { recursive: true });
  const pdfOptions: PdfBenchmarkOptions = {
    pdfPaths: options.pdfPaths ?? [],
    ...(options.pdfDir ? { pdfDir: options.pdfDir } : {}),
    maxPdfs: Math.max(1, options.maxPdfs ?? 2),
    requirePdf: options.requirePdf === true,
  };

  const cases = filterCases(buildCases(), options);
  if (cases.length === 0) {
    throw new Error("No benchmark cases matched the requested filters.");
  }

  const results: BenchmarkCaseResult[] = [];
  for (const benchmarkCase of cases) {
    results.push(await benchmarkCase.run({ outputRoot, pdfOptions }));
  }

  const totalLatencyMs = sum(results.map((result) => result.latencyMs));
  const totalEstimatedCostUsd = roundUsd(sum(results.map((result) => result.estimatedCostUsd)));
  const summary: BenchmarkRunSummary = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    outputRoot,
    totalCases: results.length,
    passedCases: results.filter((result) => result.success).length,
    failedCases: results.filter((result) => !result.success).length,
    totalLatencyMs,
    averageLatencyMs: results.length > 0 ? Math.round(totalLatencyMs / results.length) : 0,
    totalLlmCalls: sum(results.map((result) => result.llmCalls)),
    totalToolCalls: sum(results.map((result) => result.totalToolCalls)),
    totalTokens: sum(results.map((result) => result.totalTokens)),
    totalEstimatedCostUsd,
    results,
  };

  await writeFile(join(outputRoot, "benchmark-results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf-8");
  await writeFile(join(outputRoot, "benchmark-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
  await writeFile(join(outputRoot, "benchmark-summary.md"), renderBenchmarkSummary(summary), "utf-8");
  await writeFile(join(outputRoot, "human-review.md"), renderHumanReview(summary), "utf-8");

  return summary;
}

function buildCases(): BenchmarkCase[] {
  return [
    directReplyBasicCase(),
    codeSearchContextPackCase(),
    smallFileEditCase(),
    pdfPrepareSmokeCase(),
    pdfQuerySingleDocumentCase(),
    pdfSectionReadExactCase(),
    pdfMultiDocumentCompareCase(),
    pdfLargeContextBudgetCase(),
    pdfBadFileRecoveryCase(),
    multistepBugfixSlugifyCase(),
    featureAddAverageHelperCase(),
    largeContextUpdateRelevantDocCase(),
    followupContinuePreviousFileEditCase(),
    missingDirectoryRecoveryCase(),
  ];
}

function directReplyBasicCase(): BenchmarkCase {
  return {
    id: "direct_reply_basic",
    title: "Direct reply without tools",
    tier: "smoke",
    category: "direct_reply",
    estimatedRuntime: "short",
    budgets: { maxLlmCalls: 1, maxToolCalls: 0, maxTotalTokens: 1_000 },
    async run({ outputRoot }) {
      return runCase({
        outputRoot,
        caseId: "direct_reply_basic",
        title: "Direct reply without tools",
        tier: "smoke",
        category: "direct_reply",
        userMessage: "Explain what Ayati is in one short sentence.",
        providerResponses: [{
          decision: {
            kind: "reply",
            status: "completed",
            message: "Ayati is a persistent AI agent daemon with memory, tools, and communication clients.",
          },
          usage: { inputTokens: 700, outputTokens: 30, totalTokens: 730 },
        }],
        tools: [],
        budgets: { maxLlmCalls: 1, maxToolCalls: 0, maxTotalTokens: 1_000 },
        checks: async ({ result }) => [
          check("completed", result.status === "completed", result.status),
          check("interaction run", result.runClass === "interaction", result.runClass),
          check("one iteration", result.totalIterations === 1, String(result.totalIterations)),
          check("no tools", result.totalToolCalls === 0, String(result.totalToolCalls)),
          check("answers directly", result.content.includes("persistent AI agent daemon"), result.content),
        ],
      });
    },
  };
}

function codeSearchContextPackCase(): BenchmarkCase {
  return {
    id: "code_search_context_pack",
    title: "Search for context pack implementation",
    tier: "smoke",
    category: "code_search",
    estimatedRuntime: "short",
    budgets: { maxLlmCalls: 2, maxToolCalls: 1, maxTotalTokens: 4_000 },
    async run({ outputRoot }) {
      return runCase({
        outputRoot,
        caseId: "code_search_context_pack",
        title: "Search for context pack implementation",
        tier: "smoke",
        category: "code_search",
        userMessage: "Where is the agent context pack built?",
        providerResponses: [
          {
            decision: {
              kind: "act",
              action: {
                mode: "single",
                calls: [{
                  id: "search_context_pack",
                  tool: "search_in_files",
                  input: {
                    query: "buildAgentContextPack",
                    roots: [resolve("src", "ivec")],
                    maxDepth: 6,
                    maxResults: 10,
                  },
                  dependsOn: [],
                  purpose: "Find the context pack builder",
                }],
                allowedTools: ["search_in_files"],
                maxCalls: 1,
              },
            },
            usage: { inputTokens: 1100, outputTokens: 140, totalTokens: 1240 },
          },
          {
            decision: {
              kind: "reply",
              status: "completed",
              message: "The agent context pack is built in ayati-main/src/ivec/agent-runner/context-pack.ts by buildAgentContextPack.",
            },
            usage: { inputTokens: 1500, outputTokens: 45, totalTokens: 1545 },
          },
        ],
        tools: ALL_TOOLS,
        budgets: { maxLlmCalls: 2, maxToolCalls: 1, maxTotalTokens: 4_000 },
        checks: async ({ result, metrics }) => [
          check("completed", result.status === "completed", result.status),
          check("task run", result.runClass === "task", result.runClass),
          check("one tool call", result.totalToolCalls === 1, String(result.totalToolCalls)),
          check("search tool succeeded", readMetricNumber(metrics, ["stages", "tool:search_in_files", "failures"]) === 0),
          check("mentions context-pack path", result.content.includes("context-pack.ts"), result.content),
          check("records provider usage", readMetricNumber(metrics, ["optimization", "providerUsage", "agent_decision", "totalTokens"]) > 0),
        ],
      });
    },
  };
}

function smallFileEditCase(): BenchmarkCase {
  return {
    id: "small_file_edit",
    title: "Edit one small file",
    tier: "smoke",
    category: "file_edit",
    estimatedRuntime: "short",
    budgets: { maxLlmCalls: 2, maxToolCalls: 1, maxTotalTokens: 5_000 },
    async run({ outputRoot }) {
      const workspacePath = await mkdtemp(join(tmpdir(), "ayati-bench-edit-"));
      const targetPath = join(workspacePath, "notes.md");
      await writeFile(targetPath, "status: draft\n", "utf-8");
      return runCase({
        outputRoot,
        caseId: "small_file_edit",
        title: "Edit one small file",
        tier: "smoke",
        category: "file_edit",
        userMessage: `Update ${targetPath} from draft to ready.`,
        workspacePath,
        snapshotWorkspace: true,
        providerResponses: [
          {
            decision: {
              kind: "act",
              action: {
                mode: "single",
                calls: [{
                  id: "edit_status",
                  tool: "edit_file",
                  input: {
                    path: targetPath,
                    oldString: "status: draft",
                    newString: "status: ready",
                  },
                  dependsOn: [],
                  purpose: "Update the status line",
                }],
                allowedTools: ["edit_file"],
                maxCalls: 1,
              },
            },
            usage: { inputTokens: 1300, outputTokens: 160, totalTokens: 1460 },
          },
          {
            decision: {
              kind: "reply",
              status: "completed",
              message: `Updated ${targetPath} from draft to ready.`,
            },
            usage: { inputTokens: 1700, outputTokens: 35, totalTokens: 1735 },
          },
        ],
        tools: ALL_TOOLS,
        budgets: { maxLlmCalls: 2, maxToolCalls: 1, maxTotalTokens: 5_000 },
        checks: async ({ result, metrics }) => {
          const content = await readFile(targetPath, "utf-8");
          return [
            check("completed", result.status === "completed", result.status),
            check("task run", result.runClass === "task", result.runClass),
            check("one tool call", result.totalToolCalls === 1, String(result.totalToolCalls)),
            check("file edited", content === "status: ready\n", content),
            check("no internal final wording", !containsInternalHarnessWords(result.content), result.content),
            check("records estimated prompt tokens", readMetricNumber(metrics, ["optimization", "prompts", "agent_decision", "totalEstimatedTokens"]) > 0),
          ];
        },
      });
    },
  };
}

function pdfPrepareSmokeCase(): BenchmarkCase {
  return {
    id: "pdf_prepare_smoke",
    title: "Prepare one PDF and list sections",
    tier: "smoke",
    category: "file_handling",
    estimatedRuntime: "medium",
    budgets: { maxLlmCalls: 2, maxToolCalls: 1, maxTotalTokens: 8_000 },
    async run(context) {
      return runPdfBenchmarkCase(context, {
        caseId: "pdf_prepare_smoke",
        title: "Prepare one PDF and list sections",
        requiredPdfCount: 1,
        userMessage: "List the available sections in the attached PDF.",
        providerResponses: () => [
          {
            decision: {
              kind: "act",
              action: {
                mode: "single",
                calls: [{
                  id: "list_pdf_sections",
                  tool: "document_list_sections",
                  input: {},
                  dependsOn: [],
                  purpose: "List sections from the attached PDF",
                }],
                allowedTools: ["document_list_sections"],
                maxCalls: 1,
              },
            },
            usage: { inputTokens: 2500, outputTokens: 170, totalTokens: 2670 },
          },
          {
            decision: {
              kind: "reply",
              status: "completed",
              message: "Listed the attached PDF sections and confirmed the document was prepared.",
            },
            usage: { inputTokens: 3200, outputTokens: 45, totalTokens: 3245 },
          },
        ],
        budgets: { maxLlmCalls: 2, maxToolCalls: 1, maxTotalTokens: 8_000 },
        checks: async ({ result, metrics, fixture }) => [
          check("completed", result.status === "completed", result.status),
          check("one pdf attached", fixture.attachedDocuments.length === 1, String(fixture.attachedDocuments.length)),
          check("document prepared", fixture.documentStore.preparationReports.some((entry) => entry.status === "ready")),
          check("sections detected", maxPreparedSectionCount(fixture.documentStore.preparationReports) > 0, String(maxPreparedSectionCount(fixture.documentStore.preparationReports))),
          check("section list tool used", readMetricNumber(metrics, ["stages", "tool:document_list_sections", "calls"]) === 1),
        ],
      });
    },
  };
}

function pdfQuerySingleDocumentCase(): BenchmarkCase {
  return {
    id: "pdf_query_single_document",
    title: "Query one PDF with document retrieval",
    tier: "smoke",
    category: "file_handling",
    estimatedRuntime: "medium",
    budgets: { maxLlmCalls: 2, maxToolCalls: 1, maxTotalTokens: 10_000 },
    async run(context) {
      return runPdfBenchmarkCase(context, {
        caseId: "pdf_query_single_document",
        title: "Query one PDF with document retrieval",
        requiredPdfCount: 1,
        userMessage: "Summarize the main topic of the attached PDF and mention the document evidence you used.",
        providerResponses: () => [
          {
            decision: {
              kind: "act",
              action: {
                mode: "single",
                calls: [{
                  id: "query_pdf_summary",
                  tool: "document_query",
                  input: { query: "summarize overview main points" },
                  dependsOn: [],
                  purpose: "Retrieve summary evidence from the attached PDF",
                }],
                allowedTools: ["document_query"],
                maxCalls: 1,
              },
            },
            usage: { inputTokens: 3000, outputTokens: 190, totalTokens: 3190 },
          },
          {
            decision: {
              kind: "reply",
              status: "completed",
              message: "Summarized the attached PDF using retrieved document context and source evidence.",
            },
            usage: { inputTokens: 4200, outputTokens: 55, totalTokens: 4255 },
          },
        ],
        budgets: { maxLlmCalls: 2, maxToolCalls: 1, maxTotalTokens: 10_000 },
        checks: async ({ result, metrics, providerStats }) => [
          check("completed", result.status === "completed", result.status),
          check("query tool used", readMetricNumber(metrics, ["stages", "tool:document_query", "calls"]) === 1),
          check("retrieval provider observed", providerStats.retrievalEvidenceCalls >= 1, String(providerStats.retrievalEvidenceCalls)),
          check("document query returned context", await hasToolOutputContaining(result.runPath, "document_query", "context")),
          check("final answer mentions document", /pdf|document/i.test(result.content), result.content),
        ],
      });
    },
  };
}

function pdfSectionReadExactCase(): BenchmarkCase {
  return {
    id: "pdf_section_read_exact",
    title: "List and read exact PDF sections",
    tier: "smoke",
    category: "file_handling",
    estimatedRuntime: "medium",
    budgets: { maxLlmCalls: 3, maxToolCalls: 2, maxTotalTokens: 12_000 },
    async run(context) {
      return runPdfBenchmarkCase(context, {
        caseId: "pdf_section_read_exact",
        title: "List and read exact PDF sections",
        requiredPdfCount: 1,
        userMessage: "Find the first readable section in the attached PDF, read it, and explain what it says.",
        providerResponses: () => [
          {
            decision: {
              kind: "act",
              action: {
                mode: "sequential",
                calls: [
                  {
                    id: "list_pdf_sections",
                    tool: "document_list_sections",
                    input: {},
                    dependsOn: [],
                    purpose: "Find readable section handles",
                  },
                  {
                    id: "read_first_pdf_section",
                    tool: "document_read_section",
                    input: { sectionIds: ["segment-1", "page-1"] },
                    dependsOn: ["list_pdf_sections"],
                    purpose: "Read the first section or first page",
                  },
                ],
                allowedTools: ["document_list_sections", "document_read_section"],
                maxCalls: 2,
              },
            },
            usage: { inputTokens: 3400, outputTokens: 260, totalTokens: 3660 },
          },
          {
            decision: {
              kind: "reply",
              status: "completed",
              message: "Read the first available PDF section and summarized its contents.",
            },
            usage: { inputTokens: 4700, outputTokens: 55, totalTokens: 4755 },
          },
        ],
        budgets: { maxLlmCalls: 3, maxToolCalls: 2, maxTotalTokens: 12_000 },
        checks: async ({ result, metrics }) => [
          check("completed", result.status === "completed", result.status),
          check("section list used", readMetricNumber(metrics, ["stages", "tool:document_list_sections", "calls"]) === 1),
          check("section read used", readMetricNumber(metrics, ["stages", "tool:document_read_section", "calls"]) === 1),
          check("section text returned", await hasToolOutputContaining(result.runPath, "document_read_section", "\"sections\"")),
          check("final answer mentions section", /section|page|contents/i.test(result.content), result.content),
        ],
      });
    },
  };
}

function pdfMultiDocumentCompareCase(): BenchmarkCase {
  return {
    id: "pdf_multi_document_compare",
    title: "Compare two attached PDFs",
    tier: "context_heavy",
    category: "file_handling",
    estimatedRuntime: "long",
    budgets: { maxLlmCalls: 3, maxToolCalls: 2, maxTotalTokens: 16_000 },
    async run(context) {
      return runPdfBenchmarkCase(context, {
        caseId: "pdf_multi_document_compare",
        title: "Compare two attached PDFs",
        tier: "context_heavy",
        requiredPdfCount: 2,
        userMessage: "Compare the two attached PDFs. What is each document mainly about, and how are they different?",
        providerResponses: ({ fixture }) => {
          const first = preparedInputIdForDocument(fixture.attachedDocuments[0]!, 0);
          const second = preparedInputIdForDocument(fixture.attachedDocuments[1]!, 1);
          return [
            {
              decision: {
                kind: "act",
                action: {
                  mode: "parallel",
                  calls: [
                    {
                      id: "query_first_pdf",
                      tool: "document_query",
                      input: { preparedInputId: first, query: "summarize overview main points" },
                      dependsOn: [],
                      purpose: "Summarize the first PDF",
                    },
                    {
                      id: "query_second_pdf",
                      tool: "document_query",
                      input: { preparedInputId: second, query: "summarize overview main points" },
                      dependsOn: [],
                      purpose: "Summarize the second PDF",
                    },
                  ],
                  allowedTools: ["document_query"],
                  maxCalls: 2,
                },
              },
              usage: { inputTokens: 4600, outputTokens: 380, totalTokens: 4980 },
            },
            {
              decision: {
                kind: "reply",
                status: "completed",
                message: "Compared both attached PDFs using separate retrieved context for each document.",
              },
              usage: { inputTokens: 6500, outputTokens: 80, totalTokens: 6580 },
            },
          ];
        },
        budgets: { maxLlmCalls: 3, maxToolCalls: 2, maxTotalTokens: 16_000 },
        checks: async ({ result, metrics, fixture }) => [
          check("completed", result.status === "completed", result.status),
          check("two pdfs attached", fixture.attachedDocuments.length === 2, String(fixture.attachedDocuments.length)),
          check("two document queries", readMetricNumber(metrics, ["stages", "tool:document_query", "calls"]) === 2),
          check("first document targeted", await hasToolOutputContaining(result.runPath, "document_query", fixture.attachedDocuments[0]!.displayName)),
          check("second document targeted", await hasToolOutputContaining(result.runPath, "document_query", fixture.attachedDocuments[1]!.displayName)),
          check("final answer compares", /compar/i.test(result.content), result.content),
        ],
      });
    },
  };
}

function pdfLargeContextBudgetCase(): BenchmarkCase {
  return {
    id: "pdf_large_context_budget",
    title: "Summarize the largest available PDF within context budget",
    tier: "context_heavy",
    category: "file_handling",
    estimatedRuntime: "long",
    budgets: { maxLlmCalls: 2, maxToolCalls: 1, maxTotalTokens: 14_000 },
    async run(context) {
      return runPdfBenchmarkCase(context, {
        caseId: "pdf_large_context_budget",
        title: "Summarize the largest available PDF within context budget",
        requiredPdfCount: 1,
        preferLargest: true,
        userMessage: "Give a concise summary of the attached PDF. Focus only on the most important ideas.",
        providerResponses: () => [
          {
            decision: {
              kind: "act",
              action: {
                mode: "single",
                calls: [{
                  id: "query_large_pdf",
                  tool: "document_query",
                  input: { query: "summarize overview main points" },
                  dependsOn: [],
                  purpose: "Retrieve bounded context from the large PDF",
                }],
                allowedTools: ["document_query"],
                maxCalls: 1,
              },
            },
            usage: { inputTokens: 4200, outputTokens: 210, totalTokens: 4410 },
          },
          {
            decision: {
              kind: "reply",
              status: "completed",
              message: "Produced a concise summary from bounded retrieved PDF context.",
            },
            usage: { inputTokens: 5600, outputTokens: 55, totalTokens: 5655 },
          },
        ],
        budgets: { maxLlmCalls: 2, maxToolCalls: 1, maxTotalTokens: 14_000 },
        checks: async ({ result, metrics, fixture }) => [
          check("completed", result.status === "completed", result.status),
          check("largest pdf selected", fixture.pdfManifest[0]?.sizeBytes === Math.max(...fixture.pdfManifest.map((entry) => entry.sizeBytes)), String(fixture.pdfManifest[0]?.sizeBytes ?? 0)),
          check("query tool used", readMetricNumber(metrics, ["stages", "tool:document_query", "calls"]) === 1),
          check("context growth recorded", readAgentDecisionContextGrowth(metrics).maxEstimatedTokens > 0),
          check("final answer concise", result.content.length <= 240, String(result.content.length)),
        ],
      });
    },
  };
}

function pdfBadFileRecoveryCase(): BenchmarkCase {
  return {
    id: "pdf_bad_file_recovery",
    title: "Record extraction failure for an invalid PDF",
    tier: "recovery",
    category: "file_handling",
    estimatedRuntime: "short",
    budgets: { maxLlmCalls: 0, maxToolCalls: 0, maxTotalTokens: 0 },
    async run({ outputRoot }) {
      const caseId = "pdf_bad_file_recovery";
      const title = "Record extraction failure for an invalid PDF";
      const outputDir = join(outputRoot, caseId);
      await mkdir(outputDir, { recursive: true });
      const workspacePath = await mkdtemp(join(tmpdir(), "ayati-bench-bad-pdf-"));
      const badPdfPath = join(workspacePath, "invalid.pdf");
      await writeFile(badPdfPath, "this is not a real pdf\n", "utf-8");
      const fixture = await createPdfBenchmarkFixture({
        caseId,
        pdfSources: [await buildPdfSource(badPdfPath)],
      });

      try {
        await runCase({
          outputRoot,
          caseId,
          title,
          tier: "recovery",
          category: "file_handling",
          userMessage: "Read the attached PDF and summarize it.",
          providerResponses: [{
            decision: {
              kind: "act",
              action: {
                mode: "single",
                calls: [{
                  id: "query_invalid_pdf",
                  tool: "document_query",
                  input: { query: "summarize overview" },
                  dependsOn: [],
                  purpose: "Attempt to query the invalid PDF",
                }],
                allowedTools: ["document_query"],
                maxCalls: 1,
              },
            },
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          }],
          workspacePath: fixture.workspacePath,
          attachedDocuments: fixture.attachedDocuments,
          documentStore: fixture.documentStore,
          preparedAttachmentRegistry: fixture.preparedAttachmentRegistry,
          createTools: (provider) => createPdfBenchmarkTools(fixture, provider),
          checks: async () => [check("invalid pdf unexpectedly completed", false)],
          writeExtraReports: async ({ metrics, providerStats }) => {
            await writePdfReports(outputDir, fixture, metrics, providerStats);
          },
        });
      } catch (err) {
        const details = err instanceof Error ? err.message : String(err);
        const result = buildSyntheticCaseResult({
          caseId,
          title,
          tier: "recovery",
          category: "file_handling",
          outputDir,
          workspacePath: fixture.workspacePath,
          status: "failed",
          success: true,
          checks: [
            check("invalid pdf preparation failed", /failed to prepare|pdf|tika|pandoc/i.test(details), details),
            check("failure captured in benchmark report", true),
          ],
        });
        await writeSyntheticCaseReports(outputDir, result, {
          error: details,
          documentPreparation: fixture.documentStore.preparationReports,
        });
        await writePdfReports(outputDir, fixture, {}, emptyProviderStats());
        return result;
      }

      const result = buildSyntheticCaseResult({
        caseId,
        title,
        tier: "recovery",
        category: "file_handling",
        outputDir,
        workspacePath: fixture.workspacePath,
        status: "completed",
        success: false,
        checks: [check("invalid pdf should fail preparation", false)],
      });
      await writeSyntheticCaseReports(outputDir, result, {});
      return result;
    },
  };
}

function multistepBugfixSlugifyCase(): BenchmarkCase {
  return {
    id: "multistep_bugfix_slugify",
    title: "Fix a failing slugify implementation",
    tier: "multistep",
    category: "coding",
    estimatedRuntime: "medium",
    budgets: { maxLlmCalls: 4, maxToolCalls: 5, maxTotalTokens: 15_000 },
    async run({ outputRoot }) {
      const workspacePath = await createSlugifyFixture();
      const sourcePath = join(workspacePath, "src", "string-utils.mjs");
      return runCase({
        outputRoot,
        caseId: "multistep_bugfix_slugify",
        title: "Fix a failing slugify implementation",
        tier: "multistep",
        category: "coding",
        userMessage: `Fix the failing slugify tests in ${workspacePath}. Keep the change minimal and run the relevant test.`,
        workspacePath,
        snapshotWorkspace: true,
        providerResponses: [
          {
            decision: {
              kind: "act",
              action: {
                mode: "single",
                calls: [{
                  id: "run_failing_test",
                  tool: "shell",
                  input: { cmd: "node tests/string-utils.test.mjs", cwd: workspacePath },
                  dependsOn: [],
                  purpose: "Run the failing slugify test",
                }],
                allowedTools: ["shell"],
                maxCalls: 1,
              },
            },
            usage: { inputTokens: 2400, outputTokens: 180, totalTokens: 2580 },
          },
          {
            decision: {
              kind: "act",
              action: {
                mode: "sequential",
                calls: [
                  {
                    id: "read_slugify",
                    tool: "read_file",
                    input: { path: sourcePath },
                    dependsOn: [],
                    purpose: "Inspect the slugify implementation",
                  },
                  {
                    id: "fix_slugify",
                    tool: "write_file",
                    input: {
                      path: sourcePath,
                      content: [
                        "export function slugify(value) {",
                        "  return value",
                        "    .trim()",
                        "    .toLowerCase()",
                        "    .replace(/[^a-z0-9]+/g, \"-\")",
                        "    .replace(/^-+|-+$/g, \"\");",
                        "}",
                        "",
                      ].join("\n"),
                    },
                    dependsOn: ["read_slugify"],
                    purpose: "Fix punctuation and whitespace handling",
                  },
                  {
                    id: "rerun_test",
                    tool: "shell",
                    input: { cmd: "node tests/string-utils.test.mjs", cwd: workspacePath },
                    dependsOn: ["fix_slugify"],
                    purpose: "Verify the slugify fix",
                  },
                ],
                allowedTools: ["read_file", "write_file", "shell"],
                maxCalls: 3,
              },
            },
            usage: { inputTokens: 3800, outputTokens: 420, totalTokens: 4220 },
          },
          {
            decision: {
              kind: "reply",
              status: "completed",
              message: "Fixed slugify in src/string-utils.mjs and verified it with node tests/string-utils.test.mjs.",
            },
            usage: { inputTokens: 2600, outputTokens: 55, totalTokens: 2655 },
          },
        ],
        tools: ALL_TOOLS,
        budgets: { maxLlmCalls: 4, maxToolCalls: 5, maxTotalTokens: 15_000 },
        checks: async ({ result, metrics, workspacePath: workspace }) => {
          const content = await readFile(sourcePath, "utf-8");
          return [
            check("completed", result.status === "completed", result.status),
            check("test initially failed", readMetricNumber(metrics, ["stages", "tool:shell", "failures"]) >= 1),
            check("source file fixed", content.includes("replace(/[^a-z0-9]+/g"), content),
            check("verification rerun passed", await hasSuccessfulShellStep(result.runPath, "slugify tests passed")),
            check("final answer mentions test", result.content.includes("node tests/string-utils.test.mjs"), result.content),
            check("workspace retained", workspace !== undefined && workspace.length > 0),
          ];
        },
      });
    },
  };
}

function featureAddAverageHelperCase(): BenchmarkCase {
  return {
    id: "feature_add_average_helper",
    title: "Add average helper with tests",
    tier: "multistep",
    category: "coding",
    estimatedRuntime: "medium",
    budgets: { maxLlmCalls: 4, maxToolCalls: 6, maxTotalTokens: 18_000 },
    async run({ outputRoot }) {
      const workspacePath = await createCalculatorFixture();
      const sourcePath = join(workspacePath, "src", "calculator.mjs");
      const testPath = join(workspacePath, "tests", "calculator.test.mjs");
      return runCase({
        outputRoot,
        caseId: "feature_add_average_helper",
        title: "Add average helper with tests",
        tier: "multistep",
        category: "coding",
        userMessage: `Add an average(numbers) helper in ${workspacePath} following the existing style and add a test for it.`,
        workspacePath,
        snapshotWorkspace: true,
        providerResponses: [
          {
            decision: {
              kind: "act",
              action: {
                mode: "parallel",
                calls: [
                  {
                    id: "read_calculator",
                    tool: "read_file",
                    input: { path: sourcePath },
                    dependsOn: [],
                    purpose: "Inspect calculator implementation style",
                  },
                  {
                    id: "read_tests",
                    tool: "read_file",
                    input: { path: testPath },
                    dependsOn: [],
                    purpose: "Inspect calculator tests",
                  },
                ],
                allowedTools: ["read_file"],
                maxCalls: 2,
              },
            },
            usage: { inputTokens: 2600, outputTokens: 260, totalTokens: 2860 },
          },
          {
            decision: {
              kind: "act",
              action: {
                mode: "sequential",
                calls: [
                  {
                    id: "write_calculator",
                    tool: "write_file",
                    input: {
                      path: sourcePath,
                      content: [
                        "export function add(left, right) {",
                        "  return left + right;",
                        "}",
                        "",
                        "export function subtract(left, right) {",
                        "  return left - right;",
                        "}",
                        "",
                        "export function average(numbers) {",
                        "  if (numbers.length === 0) {",
                        "    return 0;",
                        "  }",
                        "  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;",
                        "}",
                        "",
                      ].join("\n"),
                    },
                    dependsOn: [],
                    purpose: "Add average helper",
                  },
                  {
                    id: "write_tests",
                    tool: "write_file",
                    input: {
                      path: testPath,
                      content: [
                        "import assert from \"node:assert/strict\";",
                        "import { add, average, subtract } from \"../src/calculator.mjs\";",
                        "",
                        "assert.equal(add(2, 3), 5);",
                        "assert.equal(subtract(7, 2), 5);",
                        "assert.equal(average([2, 4, 6]), 4);",
                        "assert.equal(average([]), 0);",
                        "console.log(\"calculator tests passed\");",
                        "",
                      ].join("\n"),
                    },
                    dependsOn: ["write_calculator"],
                    purpose: "Add average tests",
                  },
                  {
                    id: "run_tests",
                    tool: "shell",
                    input: { cmd: "node tests/calculator.test.mjs", cwd: workspacePath },
                    dependsOn: ["write_tests"],
                    purpose: "Verify calculator tests",
                  },
                ],
                allowedTools: ["write_file", "shell"],
                maxCalls: 3,
              },
            },
            usage: { inputTokens: 3900, outputTokens: 520, totalTokens: 4420 },
          },
          {
            decision: {
              kind: "reply",
              status: "completed",
              message: "Added average(numbers) in src/calculator.mjs, added tests, and verified them with node tests/calculator.test.mjs.",
            },
            usage: { inputTokens: 2800, outputTokens: 65, totalTokens: 2865 },
          },
        ],
        tools: ALL_TOOLS,
        budgets: { maxLlmCalls: 4, maxToolCalls: 6, maxTotalTokens: 18_000 },
        checks: async ({ result }) => {
          const source = await readFile(sourcePath, "utf-8");
          const test = await readFile(testPath, "utf-8");
          return [
            check("completed", result.status === "completed", result.status),
            check("average exported", source.includes("export function average"), source),
            check("average tests added", test.includes("average([2, 4, 6])") && test.includes("average([])"), test),
            check("verification passed", await hasSuccessfulShellStep(result.runPath, "calculator tests passed")),
            check("final answer mentions test", result.content.includes("node tests/calculator.test.mjs"), result.content),
          ];
        },
      });
    },
  };
}

function largeContextUpdateRelevantDocCase(): BenchmarkCase {
  return {
    id: "large_context_update_relevant_doc",
    title: "Find and update the relevant doc in a noisy workspace",
    tier: "context_heavy",
    category: "context",
    estimatedRuntime: "medium",
    budgets: { maxLlmCalls: 3, maxToolCalls: 4, maxTotalTokens: 18_000 },
    async run({ outputRoot }) {
      const workspacePath = await createLargeContextFixture();
      const targetPath = join(workspacePath, "docs", "runtime", "context-pack.md");
      return runCase({
        outputRoot,
        caseId: "large_context_update_relevant_doc",
        title: "Find and update the relevant doc in a noisy workspace",
        tier: "context_heavy",
        category: "context",
        userMessage: `Find where the docs describe context pack limits in ${workspacePath} and update the note to mention activeFocus is capped at 3.`,
        workspacePath,
        snapshotWorkspace: true,
        providerResponses: [
          {
            decision: {
              kind: "act",
              action: {
                mode: "sequential",
                calls: [
                  {
                    id: "search_context_limits",
                    tool: "search_in_files",
                    input: { query: "context pack limits", roots: [workspacePath], maxDepth: 5, maxResults: 8 },
                    dependsOn: [],
                    purpose: "Find the relevant context limit documentation",
                  },
                  {
                    id: "read_context_doc",
                    tool: "read_file",
                    input: { path: targetPath },
                    dependsOn: ["search_context_limits"],
                    purpose: "Read the relevant context pack doc",
                  },
                  {
                    id: "update_context_doc",
                    tool: "write_file",
                    input: {
                      path: targetPath,
                      content: [
                        "# Context Pack Limits",
                        "",
                        "The context pack keeps recent conversation, active focus, session focus cards, and the attention shelf bounded.",
                        "",
                        "- recentConversation is capped at 5 completed exchanges.",
                        "- activeFocus is capped at 3 activated focus cards.",
                        "- sessionFocusCards and attentionShelf are each capped at 5 compact cards.",
                        "",
                      ].join("\n"),
                    },
                    dependsOn: ["read_context_doc"],
                    purpose: "Add activeFocus cap note",
                  },
                ],
                allowedTools: ["search_in_files", "read_file", "write_file"],
                maxCalls: 3,
              },
            },
            usage: { inputTokens: 4200, outputTokens: 420, totalTokens: 4620 },
          },
          {
            decision: {
              kind: "reply",
              status: "completed",
              message: "Updated docs/runtime/context-pack.md to mention that activeFocus is capped at 3.",
            },
            usage: { inputTokens: 3500, outputTokens: 45, totalTokens: 3545 },
          },
        ],
        tools: ALL_TOOLS,
        budgets: { maxLlmCalls: 3, maxToolCalls: 4, maxTotalTokens: 18_000 },
        checks: async ({ result, metrics }) => {
          const content = await readFile(targetPath, "utf-8");
          const readCalls = readMetricNumber(metrics, ["stages", "tool:read_file", "calls"]);
          return [
            check("completed", result.status === "completed", result.status),
            check("correct doc updated", content.includes("activeFocus is capped at 3"), content),
            check("search used", readMetricNumber(metrics, ["stages", "tool:search_in_files", "calls"]) === 1),
            check("read calls under budget", readCalls <= 1, String(readCalls)),
            check("final answer names doc", result.content.includes("docs/runtime/context-pack.md"), result.content),
          ];
        },
      });
    },
  };
}

function followupContinuePreviousFileEditCase(): BenchmarkCase {
  return {
    id: "followup_continue_previous_file_edit",
    title: "Continue a prior edit in a second run",
    tier: "continuation",
    category: "follow_up",
    estimatedRuntime: "medium",
    budgets: { maxLlmCalls: 6, maxToolCalls: 8, maxTotalTokens: 24_000 },
    async run({ outputRoot }) {
      const workspacePath = await createCacheFixture();
      const syncPath = join(workspacePath, "src", "sync-cache.mjs");
      const asyncPath = join(workspacePath, "src", "async-cache.mjs");
      const outputDir = join(outputRoot, "followup_continue_previous_file_edit");
      await mkdir(outputDir, { recursive: true });
      await snapshotDirectory(workspacePath, join(outputDir, "fixture-before"));

      const first = await runCase({
        outputRoot: outputDir,
        caseId: "run-1-sync-cache",
        title: "Run 1: add TTL to sync cache",
        tier: "continuation",
        category: "follow_up",
        userMessage: `Add TTL expiry behavior to the sync cache in ${workspacePath} and verify it.`,
        workspacePath,
        providerResponses: [
          {
            decision: {
              kind: "act",
              action: {
                mode: "sequential",
                calls: [
                  { id: "read_sync", tool: "read_file", input: { path: syncPath }, dependsOn: [], purpose: "Inspect sync cache" },
                  {
                    id: "write_sync",
                    tool: "write_file",
                    input: { path: syncPath, content: syncCacheWithTtlSource() },
                    dependsOn: ["read_sync"],
                    purpose: "Add TTL behavior to sync cache",
                  },
                  {
                    id: "run_tests",
                    tool: "shell",
                    input: { cmd: "node tests/cache.test.mjs", cwd: workspacePath },
                    dependsOn: ["write_sync"],
                    purpose: "Verify sync cache TTL",
                  },
                ],
                allowedTools: ["read_file", "write_file", "shell"],
                maxCalls: 3,
              },
            },
            usage: { inputTokens: 3400, outputTokens: 430, totalTokens: 3830 },
          },
          {
            decision: { kind: "reply", status: "completed", message: "Added TTL behavior to src/sync-cache.mjs and verified the cache tests." },
            usage: { inputTokens: 2600, outputTokens: 45, totalTokens: 2645 },
          },
        ],
        tools: ALL_TOOLS,
        checks: async ({ result }) => [
          check("run 1 completed", result.status === "completed", result.status),
          check("run 1 verified", await hasSuccessfulShellStep(result.runPath, "cache tests passed")),
        ],
      });

      const second = await runCase({
        outputRoot: outputDir,
        caseId: "run-2-async-cache",
        title: "Run 2: continue TTL work for async cache",
        tier: "continuation",
        category: "follow_up",
        userMessage: "Now add the same behavior for the async version.",
        workspacePath,
        providerResponses: [
          {
            decision: {
              kind: "act",
              action: {
                mode: "sequential",
                calls: [
                  { id: "read_async", tool: "read_file", input: { path: asyncPath }, dependsOn: [], purpose: "Inspect async cache" },
                  {
                    id: "write_async",
                    tool: "write_file",
                    input: { path: asyncPath, content: asyncCacheWithTtlSource() },
                    dependsOn: ["read_async"],
                    purpose: "Add TTL behavior to async cache",
                  },
                  {
                    id: "run_tests",
                    tool: "shell",
                    input: { cmd: "node tests/cache.test.mjs", cwd: workspacePath },
                    dependsOn: ["write_async"],
                    purpose: "Verify async cache TTL",
                  },
                ],
                allowedTools: ["read_file", "write_file", "shell"],
                maxCalls: 3,
              },
            },
            usage: { inputTokens: 3600, outputTokens: 450, totalTokens: 4050 },
          },
          {
            decision: { kind: "reply", status: "completed", message: "Added the same TTL behavior to src/async-cache.mjs and verified the cache tests." },
            usage: { inputTokens: 2700, outputTokens: 50, totalTokens: 2750 },
          },
        ],
        tools: ALL_TOOLS,
        checks: async ({ result }) => [
          check("run 2 completed", result.status === "completed", result.status),
          check("run 2 verified", await hasSuccessfulShellStep(result.runPath, "cache tests passed")),
        ],
      });

      await snapshotDirectory(workspacePath, join(outputDir, "fixture-after"));
      await writeDiffPatch(join(outputDir, "fixture-before"), join(outputDir, "fixture-after"), join(outputDir, "diff.patch"));
      const syncContent = await readFile(syncPath, "utf-8");
      const asyncContent = await readFile(asyncPath, "utf-8");
      const combinedChecks = [
        ...first.checks.map((entry) => ({ ...entry, name: `run1 ${entry.name}` })),
        ...second.checks.map((entry) => ({ ...entry, name: `run2 ${entry.name}` })),
        check("sync cache has ttl", syncContent.includes("expiresAt"), syncContent),
        check("async cache has ttl", asyncContent.includes("expiresAt"), asyncContent),
      ];
      const metrics = second.metrics ?? {};
      const result: BenchmarkCaseResult = {
        caseId: "followup_continue_previous_file_edit",
        title: "Continue a prior edit in a second run",
        tier: "continuation",
        category: "follow_up",
        success: combinedChecks.every((entry) => entry.passed),
        latencyMs: first.latencyMs + second.latencyMs,
        outputDir,
        runPath: second.runPath,
        workspacePath,
        status: second.status,
        runClass: second.runClass,
        totalIterations: first.totalIterations + second.totalIterations,
        totalToolCalls: first.totalToolCalls + second.totalToolCalls,
        llmCalls: first.llmCalls + second.llmCalls,
        totalTokens: first.totalTokens + second.totalTokens,
        estimatedCostUsd: roundUsd(first.estimatedCostUsd + second.estimatedCostUsd),
        totalContextGrowthTokens: first.totalContextGrowthTokens + second.totalContextGrowthTokens,
        maxContextDeltaTokens: Math.max(first.maxContextDeltaTokens, second.maxContextDeltaTokens),
        maxPromptEstimatedTokens: Math.max(first.maxPromptEstimatedTokens, second.maxPromptEstimatedTokens),
        checks: combinedChecks,
        budgetResults: evaluateBudgets({ maxLlmCalls: 6, maxToolCalls: 8, maxTotalTokens: 24_000 }, {
          llmCalls: first.llmCalls + second.llmCalls,
          toolCalls: first.totalToolCalls + second.totalToolCalls,
          totalTokens: first.totalTokens + second.totalTokens,
          latencyMs: first.latencyMs + second.latencyMs,
        }),
        metrics,
      };
      await writeCaseReports(outputDir, result, metrics, second.runPath);
      return result;
    },
  };
}

function missingDirectoryRecoveryCase(): BenchmarkCase {
  return {
    id: "missing_directory_recovery",
    title: "Recover from missing parent directory",
    tier: "recovery",
    category: "recovery",
    estimatedRuntime: "short",
    budgets: { maxLlmCalls: 3, maxToolCalls: 3, maxTotalTokens: 10_000 },
    async run({ outputRoot }) {
      const workspacePath = await mkdtemp(join(tmpdir(), "ayati-bench-recovery-"));
      const targetPath = join(workspacePath, "reports", "summary.txt");
      await writeFile(join(workspacePath, "README.md"), "Fixture project for missing directory recovery.\n", "utf-8");
      return runCase({
        outputRoot,
        caseId: "missing_directory_recovery",
        title: "Recover from missing parent directory",
        tier: "recovery",
        category: "recovery",
        userMessage: `Create ${targetPath} with a short summary of the fixture project.`,
        workspacePath,
        snapshotWorkspace: true,
        providerResponses: [
          {
            decision: {
              kind: "act",
              action: {
                mode: "single",
                calls: [{
                  id: "write_summary",
                  tool: "write_file",
                  input: { path: targetPath, content: "Fixture project summary: missing directory recovery benchmark.\n" },
                  dependsOn: [],
                  purpose: "Create the summary file",
                }],
                allowedTools: ["write_file"],
                maxCalls: 1,
              },
            },
            usage: { inputTokens: 1900, outputTokens: 170, totalTokens: 2070 },
          },
          {
            decision: {
              kind: "reply",
              status: "completed",
              message: `Created ${targetPath} after recovering from the missing parent directory.`,
            },
            usage: { inputTokens: 2200, outputTokens: 45, totalTokens: 2245 },
          },
        ],
        tools: ALL_TOOLS,
        budgets: { maxLlmCalls: 3, maxToolCalls: 3, maxTotalTokens: 10_000 },
        checks: async ({ result, metrics }) => {
          const content = await readFile(targetPath, "utf-8");
          return [
            check("completed", result.status === "completed", result.status),
            check("file created", content.includes("missing directory recovery"), content),
            check("local recovery recorded", readMetricNumber(metrics, ["stages", "local_recovery", "calls"]) >= 1),
            check("final answer mentions recovery", result.content.includes("recovering"), result.content),
          ];
        },
      });
    },
  };
}

interface PdfCaseInput {
  caseId: string;
  title: string;
  tier?: BenchmarkTier;
  requiredPdfCount: number;
  preferLargest?: boolean;
  userMessage: string;
  budgets?: BenchmarkBudget;
  providerResponses: (input: { fixture: PdfBenchmarkFixture }) => QueuedDecision[];
  checks: (input: {
    result: Awaited<ReturnType<typeof agentLoop>>;
    metrics: Record<string, unknown>;
    outputDir: string;
    workspacePath?: string;
    providerStats: BenchmarkProviderStats;
    fixture: PdfBenchmarkFixture;
  }) => Promise<BenchmarkCheck[]>;
}

async function runPdfBenchmarkCase(
  context: BenchmarkRunContext,
  input: PdfCaseInput,
): Promise<BenchmarkCaseResult> {
  const outputDir = join(context.outputRoot, input.caseId);
  await mkdir(outputDir, { recursive: true });
  const pdfSources = await selectPdfSources(context.pdfOptions, {
    count: input.requiredPdfCount,
    preferLargest: input.preferLargest === true,
  });

  if (pdfSources.length < input.requiredPdfCount) {
    const message = `Needed ${input.requiredPdfCount} PDF(s), found ${pdfSources.length}. Use --pdf <path> or --pdf-dir <dir>.`;
    if (context.pdfOptions.requirePdf) {
      throw new Error(message);
    }
    const result = buildSyntheticCaseResult({
      caseId: input.caseId,
      title: input.title,
      tier: pdfCaseTier(input),
      category: "file_handling",
      outputDir,
      status: "skipped",
      success: true,
      checks: [check("skipped because pdf source is unavailable", true, message)],
    });
    await writeSyntheticCaseReports(outputDir, result, { skipped: true, reason: message });
    return result;
  }

  const fixture = await createPdfBenchmarkFixture({
    caseId: input.caseId,
    pdfSources,
  });

  try {
    return await runCase({
      outputRoot: context.outputRoot,
      caseId: input.caseId,
      title: input.title,
      tier: pdfCaseTier(input),
      category: "file_handling",
      userMessage: input.userMessage,
      workspacePath: fixture.workspacePath,
      attachedDocuments: fixture.attachedDocuments,
      documentStore: fixture.documentStore,
      preparedAttachmentRegistry: fixture.preparedAttachmentRegistry,
      providerResponses: input.providerResponses({ fixture }),
      createTools: (provider) => createPdfBenchmarkTools(fixture, provider),
      budgets: input.budgets,
      checks: async (checkInput) => input.checks({ ...checkInput, fixture }),
      writeExtraReports: async ({ metrics, providerStats }) => {
        await writePdfReports(outputDir, fixture, metrics, providerStats);
      },
    });
  } catch (err) {
    const details = err instanceof Error ? err.message : String(err);
    const result = buildSyntheticCaseResult({
      caseId: input.caseId,
      title: input.title,
      tier: pdfCaseTier(input),
      category: "file_handling",
      outputDir,
      workspacePath: fixture.workspacePath,
      status: "failed",
      success: false,
      checks: [
        check("agent loop completed", false, details),
        check("document preparation attempted", fixture.documentStore.preparationReports.length > 0, String(fixture.documentStore.preparationReports.length)),
      ],
    });
    await writeSyntheticCaseReports(outputDir, result, {
      error: details,
      documentPreparation: fixture.documentStore.preparationReports,
    });
    await writePdfReports(outputDir, fixture, {}, emptyProviderStats());
    return result;
  }
}

function pdfCaseTier(input: PdfCaseInput): BenchmarkTier {
  return input.tier ?? (input.preferLargest ? "context_heavy" : "smoke");
}

function createPdfBenchmarkTools(fixture: PdfBenchmarkFixture, provider: LlmProvider): ToolDefinition[] {
  const documentContextBackend = new DocumentContextBackend({
    store: fixture.documentStore,
    maxRetrievedChunks: 6,
    maxEvidenceItems: 4,
  });
  const preparedAttachmentService = new PreparedAttachmentService({
    registry: fixture.preparedAttachmentRegistry,
    documentStore: fixture.documentStore,
    provider,
    documentContextBackend,
  });
  return createDocumentSkill({ preparedAttachmentService }).tools;
}

async function selectPdfSources(options: PdfBenchmarkOptions, input: {
  count: number;
  preferLargest: boolean;
}): Promise<PdfSource[]> {
  const effectiveCount = Math.min(input.count, options.maxPdfs);
  if (effectiveCount <= 0) {
    return [];
  }
  const explicit = await Promise.all(options.pdfPaths.map((path) => buildPdfSource(expandHomePath(path))));
  const discovered = explicit.length >= effectiveCount
    ? []
    : await discoverPdfSources(options.pdfDir ? expandHomePath(options.pdfDir) : join(homedir(), "Downloads"));
  const byPath = new Map<string, PdfSource>();
  for (const source of [...explicit, ...discovered]) {
    if (source.path.toLowerCase().endsWith(".pdf")) {
      byPath.set(source.path, source);
    }
  }
  const sorted = [...byPath.values()].sort((left, right) => {
    if (input.preferLargest) {
      return right.sizeBytes - left.sizeBytes || left.displayName.localeCompare(right.displayName);
    }
    return left.sizeBytes - right.sizeBytes || left.displayName.localeCompare(right.displayName);
  });
  return sorted.slice(0, effectiveCount);
}

async function discoverPdfSources(pdfDir: string): Promise<PdfSource[]> {
  try {
    const entries = await readdir(pdfDir, { withFileTypes: true });
    const sources: PdfSource[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".pdf")) {
        continue;
      }
      sources.push(await buildPdfSource(join(pdfDir, entry.name)));
    }
    return sources;
  } catch {
    return [];
  }
}

async function buildPdfSource(pdfPath: string): Promise<PdfSource> {
  const absolutePath = resolve(expandHomePath(pdfPath));
  const info = await stat(absolutePath);
  if (!info.isFile()) {
    throw new Error(`PDF path is not a file: ${absolutePath}`);
  }
  if (info.size === 0) {
    throw new Error(`PDF path is empty: ${absolutePath}`);
  }
  return {
    path: absolutePath,
    displayName: basename(absolutePath),
    sizeBytes: info.size,
    checksum: await hashFile(absolutePath),
  };
}

async function createPdfBenchmarkFixture(input: {
  caseId: string;
  pdfSources: PdfSource[];
}): Promise<PdfBenchmarkFixture> {
  const workspacePath = await mkdtemp(join(tmpdir(), `ayati-bench-${input.caseId}-`));
  const pdfDir = join(workspacePath, "pdfs");
  await mkdir(pdfDir, { recursive: true });
  const pdfManifest: PdfManifestEntry[] = [];
  const attachmentInputs: Array<{ path: string; name: string }> = [];

  for (const [index, source] of input.pdfSources.entries()) {
    const safeName = sanitizeBenchmarkFileName(`${index + 1}-${source.displayName}`);
    const benchmarkPath = join(pdfDir, safeName);
    await cp(source.path, benchmarkPath);
    pdfManifest.push({
      sourcePath: source.path,
      benchmarkPath,
      displayName: source.displayName,
      sizeBytes: source.sizeBytes,
      checksum: source.checksum,
    });
    attachmentInputs.push({ path: benchmarkPath, name: source.displayName });
  }

  const documentStore = new BenchmarkDocumentStore({
    dataDir: join(workspacePath, "data", "documents"),
  });
  const registered = await documentStore.registerAttachments(attachmentInputs);
  const preparedAttachmentRegistry = new PreparedAttachmentRegistry();
  const attachedDocuments = registered.documents;
  for (const entry of pdfManifest) {
    const matchedIndex = attachedDocuments.findIndex((document) => document.displayName === entry.displayName && document.sizeBytes === entry.sizeBytes);
    const matched = matchedIndex >= 0 ? attachedDocuments[matchedIndex] : undefined;
    if (matched && matchedIndex >= 0) {
      entry.documentId = matched.documentId;
      entry.preparedInputId = preparedInputIdForDocument(matched, matchedIndex);
    }
  }

  return {
    workspacePath,
    documentStore,
    preparedAttachmentRegistry,
    attachedDocuments,
    pdfManifest,
  };
}

async function writePdfReports(
  outputDir: string,
  fixture: PdfBenchmarkFixture,
  metrics: Record<string, unknown>,
  providerStats: BenchmarkProviderStats,
): Promise<void> {
  const attachmentRecords = fixture.preparedAttachmentRegistry.getRunAttachments(basename(outputDir));
  const preparedByDocumentId = new Map(attachmentRecords.map((record) => [record.manifest.documentId, record.summary]));
  const pdfManifest = fixture.pdfManifest.map((entry) => {
    const summary = entry.documentId ? preparedByDocumentId.get(entry.documentId) : undefined;
    return {
      ...entry,
      ...(summary ? {
        preparedInputId: summary.preparedInputId,
        status: summary.status,
        mode: summary.mode,
        extractorUsed: summary.unstructured?.extractorUsed,
        sectionCount: summary.unstructured?.sectionCount,
        chunkCount: summary.unstructured?.chunkCount,
        warnings: summary.warnings,
      } : {}),
    };
  });
  const documentToolCalls = {
    listSections: readMetricNumber(metrics, ["stages", "tool:document_list_sections", "calls"]),
    readSection: readMetricNumber(metrics, ["stages", "tool:document_read_section", "calls"]),
    query: readMetricNumber(metrics, ["stages", "tool:document_query", "calls"]),
  };
  const summary = {
    documents: pdfManifest,
    preparation: fixture.documentStore.preparationReports,
    documentToolCalls,
    providerStats,
    promptMetrics: readRecord(metrics, ["optimization", "prompts", "agent_decision"]),
    contextGrowth: readRecord(metrics, ["optimization", "contextGrowth", "agent_decision"]),
    privacy: {
      copiedIntoIgnoredWorkspace: true,
      fullPdfTextStoredInReport: false,
      sourcePathsRecordedForLocalDebugging: true,
    },
  };

  await writeFile(join(outputDir, "pdf-manifest.json"), `${JSON.stringify(pdfManifest, null, 2)}\n`, "utf-8");
  await writeFile(join(outputDir, "document-preparation.json"), `${JSON.stringify(fixture.documentStore.preparationReports, null, 2)}\n`, "utf-8");
  await writeFile(join(outputDir, "document-tool-calls.json"), `${JSON.stringify(documentToolCalls, null, 2)}\n`, "utf-8");
  await writeFile(join(outputDir, "file-handling-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
}

function buildSyntheticCaseResult(input: {
  caseId: string;
  title: string;
  tier: BenchmarkTier;
  category: BenchmarkCategory;
  outputDir: string;
  workspacePath?: string;
  status: string;
  success: boolean;
  checks: BenchmarkCheck[];
}): BenchmarkCaseResult {
  return {
    caseId: input.caseId,
    title: input.title,
    tier: input.tier,
    category: input.category,
    success: input.success && input.checks.every((entry) => entry.passed),
    latencyMs: 0,
    outputDir: input.outputDir,
    runPath: input.outputDir,
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    status: input.status,
    runClass: "task",
    totalIterations: 0,
    totalToolCalls: 0,
    llmCalls: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    totalContextGrowthTokens: 0,
    maxContextDeltaTokens: 0,
    maxPromptEstimatedTokens: 0,
    checks: input.checks,
    budgetResults: [],
    metrics: {},
  };
}

async function writeSyntheticCaseReports(
  outputDir: string,
  result: BenchmarkCaseResult,
  details: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(outputDir, "benchmark-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf-8");
  await writeFile(join(outputDir, "synthetic-result-details.json"), `${JSON.stringify(details, null, 2)}\n`, "utf-8");
  await writeFile(join(outputDir, "step-trace.json"), `${JSON.stringify([], null, 2)}\n`, "utf-8");
  await writeFile(join(outputDir, "step-trace.md"), renderStepTrace(result, []), "utf-8");
  await writeFile(join(outputDir, "tool-calls.json"), "[]\n", "utf-8");
  await writeFile(join(outputDir, "provider-usage.json"), "{}\n", "utf-8");
  await writeFile(join(outputDir, "prompt-metrics.json"), "{}\n", "utf-8");
  await writeFile(join(outputDir, "context-growth.json"), "{}\n", "utf-8");
}

async function runCase(input: RunCaseInput): Promise<BenchmarkCaseResult> {
  const outputDir = join(input.outputRoot, input.caseId);
  await mkdir(outputDir, { recursive: true });
  if (input.workspacePath && input.snapshotWorkspace) {
    await snapshotDirectory(input.workspacePath, join(outputDir, "fixture-before"));
  }

  const providerStats = emptyProviderStats();
  const provider = createBenchmarkProvider(input.providerResponses, providerStats);
  const tools = input.createTools ? input.createTools(provider) : input.tools ?? [];
  const toolExecutor = tools.length > 0 ? createToolExecutor(tools) : undefined;
  const startedAt = Date.now();
  const result = await agentLoop({
    provider,
    ...(toolExecutor ? { toolExecutor } : {}),
    toolDefinitions: toolExecutor?.definitions() ?? [],
    sessionMemory: noopSessionMemory,
    runHandle: { sessionId: "bench-session", runId: input.caseId },
    clientId: "bench-client",
    initialUserMessage: input.userMessage,
    dataDir: outputDir,
    systemContext: "Benchmark run. Follow the agent decision schema exactly.",
    ...(input.attachedDocuments ? { attachedDocuments: input.attachedDocuments } : {}),
    ...(input.documentStore ? { documentStore: input.documentStore } : {}),
    ...(input.preparedAttachmentRegistry ? { preparedAttachmentRegistry: input.preparedAttachmentRegistry } : {}),
  });
  const latencyMs = Date.now() - startedAt;
  const metrics = await readOptimizationSummary(result.runPath);
  metrics["benchmarkProvider"] = providerStats;
  const checks = await input.checks({ result, metrics, outputDir, workspacePath: input.workspacePath, providerStats });
  const llmCalls = readMetricNumber(metrics, ["llmCalls"]);
  const totalTokens = readMetricNumber(metrics, ["optimization", "providerUsage", "agent_decision", "totalTokens"]);
  const estimatedCostUsd = readMetricNumber(metrics, ["optimization", "providerUsage", "agent_decision", "estimatedCostUsd"]);
  const contextGrowth = readAgentDecisionContextGrowth(metrics);
  const budgetResults = evaluateBudgets(input.budgets, {
    llmCalls,
    toolCalls: result.totalToolCalls,
    totalTokens,
    latencyMs,
  });
  const caseResult: BenchmarkCaseResult = {
    caseId: input.caseId,
    title: input.title,
    tier: input.tier,
    category: input.category,
    success: checks.every((entry) => entry.passed),
    latencyMs,
    outputDir,
    runPath: result.runPath,
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    status: result.status,
    runClass: result.runClass,
    totalIterations: result.totalIterations,
    totalToolCalls: result.totalToolCalls,
    llmCalls,
    totalTokens,
    estimatedCostUsd,
    totalContextGrowthTokens: contextGrowth.totalPositiveDeltaEstimatedTokens,
    maxContextDeltaTokens: contextGrowth.maxDeltaEstimatedTokens,
    maxPromptEstimatedTokens: contextGrowth.maxEstimatedTokens,
    checks,
    budgetResults,
    metrics,
  };

  if (input.workspacePath && input.snapshotWorkspace) {
    await snapshotDirectory(input.workspacePath, join(outputDir, "fixture-after"));
    await writeDiffPatch(join(outputDir, "fixture-before"), join(outputDir, "fixture-after"), join(outputDir, "diff.patch"));
  }
  await writeCaseReports(outputDir, caseResult, metrics, result.runPath);
  await input.writeExtraReports?.({ outputDir, result: caseResult, metrics, providerStats });
  return caseResult;
}

function createBenchmarkProvider(responses: QueuedDecision[], stats: BenchmarkProviderStats): LlmProvider {
  const queue = [...responses];
  return {
    name: "benchmark",
    version: "1.0.0",
    capabilities: {
      nativeToolCalling: false,
      structuredOutput: {
        jsonObject: true,
        jsonSchema: false,
      },
    },
    start() {},
    stop() {},
    async generateTurn(input: LlmTurnInput) {
      stats.totalCalls++;
      if (isRetrievalEvidencePrompt(input)) {
        stats.retrievalEvidenceCalls++;
        stats.retrievalEvidenceEstimatedTokens += estimateTextTokens(extractInputText(input));
        return {
          type: "assistant",
          content: JSON.stringify({
            items: [],
            dropped_noise_count: 0,
            insufficient_evidence: true,
          }),
        };
      }
      stats.agentDecisionCalls++;
      const next = queue.shift();
      if (!next) {
        throw new Error("Benchmark provider has no queued decision.");
      }
      return {
        type: "assistant",
        content: JSON.stringify(next.decision),
        ...(next.usage ? {
          usage: {
            provider: "benchmark",
            model: BENCHMARK_MODEL,
            inputTokens: next.usage.inputTokens,
            outputTokens: next.usage.outputTokens,
            totalTokens: next.usage.totalTokens,
            ...(next.usage.cachedInputTokens !== undefined ? { cachedInputTokens: next.usage.cachedInputTokens } : {}),
            exact: true,
          },
        } : {}),
      };
    },
  };
}

function emptyProviderStats(): BenchmarkProviderStats {
  return {
    totalCalls: 0,
    agentDecisionCalls: 0,
    retrievalEvidenceCalls: 0,
    retrievalEvidenceEstimatedTokens: 0,
  };
}

function isRetrievalEvidencePrompt(input: LlmTurnInput): boolean {
  return extractInputText(input).includes("You are a retrieval sub-agent.");
}

function extractInputText(input: LlmTurnInput): string {
  return input.messages.map((message) => {
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => part.type === "text" ? part.text : "")
        .join("\n");
    }
    return "";
  }).join("\n");
}

async function writeCaseReports(
  outputDir: string,
  result: BenchmarkCaseResult,
  metrics: Record<string, unknown>,
  runPath: string,
): Promise<void> {
  await writeFile(join(outputDir, "benchmark-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf-8");
  await writeFile(join(outputDir, "prompt-metrics.json"), `${JSON.stringify(readRecord(metrics, ["optimization", "prompts"]), null, 2)}\n`, "utf-8");
  await writeFile(join(outputDir, "provider-usage.json"), `${JSON.stringify(readRecord(metrics, ["optimization", "providerUsage"]), null, 2)}\n`, "utf-8");
  await writeFile(join(outputDir, "context-growth.json"), `${JSON.stringify(readRecord(metrics, ["optimization", "contextGrowth"]), null, 2)}\n`, "utf-8");
  const trace = await buildStepTrace(runPath, metrics);
  await writeFile(join(outputDir, "step-trace.json"), `${JSON.stringify(trace, null, 2)}\n`, "utf-8");
  await writeFile(join(outputDir, "step-trace.md"), renderStepTrace(result, trace), "utf-8");
  await writeFile(join(outputDir, "tool-calls.json"), `${JSON.stringify(trace.filter((entry) => entry.type === "tool"), null, 2)}\n`, "utf-8");
}

async function buildStepTrace(runPath: string, metrics: Record<string, unknown>): Promise<StepTraceEntry[]> {
  const stepsDir = join(runPath, "steps");
  const entries: StepTraceEntry[] = [];
  try {
    const files = (await readdir(stepsDir)).filter((file) => file.endsWith(".md")).sort();
    for (const file of files) {
      const text = await readFile(join(stepsDir, file), "utf-8");
      const step = Number(file.slice(0, 3)) || entries.length + 1;
      if (file.endsWith("-act.md")) {
        entries.push(...parseActMarkdown(step, text));
      } else if (file.endsWith("-verify.md")) {
        entries.push(parseVerifyMarkdown(step, text));
      }
    }
  } catch {
    entries.push({ step: 0, type: "event", summary: "No step markdown files were available." });
  }
  entries.unshift({
    step: 0,
    type: "event",
    summary: `llmCalls=${readMetricNumber(metrics, ["llmCalls"])} toolCalls=${readMetricNumber(metrics, ["toolCalls"])} totalTokens=${readMetricNumber(metrics, ["optimization", "providerUsage", "agent_decision", "totalTokens"])}`,
  });
  return entries;
}

function parseActMarkdown(step: number, text: string): StepTraceEntry[] {
  const toolNames = [...text.matchAll(/^###\s+Call\s+\d+:\s+([a-zA-Z0-9_.:-]+)/gm)].map((match) => match[1]).filter(Boolean);
  if (toolNames.length === 0) {
    const fallback = text.match(/tool["`]?:?\s*["`]?\b([a-zA-Z0-9_.:-]+)/i)?.[1];
    return [{
      step,
      type: "tool",
      ...(fallback ? { tool: fallback } : {}),
      outputPreview: truncate(text, 1_000),
    }];
  }
  return toolNames.map((tool) => ({
    step,
    type: "tool",
    tool,
    outputPreview: truncate(text, 1_000),
  }));
}

function parseVerifyMarkdown(step: number, text: string): StepTraceEntry {
  const passed = /\bpassed\b/i.test(text) && !/\bfailed\b/i.test(text);
  return {
    step,
    type: "verification",
    status: passed ? "success" : /\bfailed\b/i.test(text) ? "failed" : "unknown",
    verificationMethod: text.match(/method[:=]\s*([a-z_]+)/i)?.[1],
    validationStatus: text.match(/validationStatus[:=]\s*([a-z_]+)/i)?.[1],
    summary: truncate(text, 1_000),
  };
}

async function createSlugifyFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ayati-bench-slugify-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2), "utf-8");
  await writeFile(join(root, "src", "string-utils.mjs"), [
    "export function slugify(value) {",
    "  return value.toLowerCase().replace(\" \", \"-\");",
    "}",
    "",
  ].join("\n"), "utf-8");
  await writeFile(join(root, "tests", "string-utils.test.mjs"), [
    "import assert from \"node:assert/strict\";",
    "import { slugify } from \"../src/string-utils.mjs\";",
    "",
    "assert.equal(slugify(\"Hello, Ayati Agent!\"), \"hello-ayati-agent\");",
    "assert.equal(slugify(\"  Multiple   Spaces  \"), \"multiple-spaces\");",
    "console.log(\"slugify tests passed\");",
    "",
  ].join("\n"), "utf-8");
  return root;
}

async function createCalculatorFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ayati-bench-average-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2), "utf-8");
  await writeFile(join(root, "src", "calculator.mjs"), [
    "export function add(left, right) {",
    "  return left + right;",
    "}",
    "",
    "export function subtract(left, right) {",
    "  return left - right;",
    "}",
    "",
  ].join("\n"), "utf-8");
  await writeFile(join(root, "tests", "calculator.test.mjs"), [
    "import assert from \"node:assert/strict\";",
    "import { add, subtract } from \"../src/calculator.mjs\";",
    "",
    "assert.equal(add(2, 3), 5);",
    "assert.equal(subtract(7, 2), 5);",
    "console.log(\"calculator tests passed\");",
    "",
  ].join("\n"), "utf-8");
  return root;
}

async function createLargeContextFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ayati-bench-context-"));
  await mkdir(join(root, "docs", "runtime"), { recursive: true });
  await mkdir(join(root, "src", "modules"), { recursive: true });
  for (let i = 0; i < 30; i++) {
    await writeFile(join(root, "docs", `topic-${i}.md`), `# Topic ${i}\n\nThis unrelated document discusses topic ${i} and not the runtime context.\n`, "utf-8");
    await writeFile(join(root, "src", "modules", `module-${i}.mjs`), `export const module${i} = ${i};\n`, "utf-8");
  }
  await writeFile(join(root, "docs", "runtime", "context-pack.md"), [
    "# Context Pack Limits",
    "",
    "The context pack keeps recent conversation, active focus, session focus cards, and the attention shelf bounded.",
    "",
    "- recentConversation is capped at 5 completed exchanges.",
    "- sessionFocusCards and attentionShelf are each capped at 5 compact cards.",
    "",
  ].join("\n"), "utf-8");
  await writeFile(join(root, "docs", "runtime", "verification.md"), "# Verification\n\nDeterministic verification checks tool-owned contracts.\n", "utf-8");
  return root;
}

async function createCacheFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ayati-bench-followup-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }, null, 2), "utf-8");
  await writeFile(join(root, "src", "sync-cache.mjs"), [
    "export class SyncCache {",
    "  constructor() {",
    "    this.values = new Map();",
    "  }",
    "  set(key, value) {",
    "    this.values.set(key, { value });",
    "  }",
    "  get(key) {",
    "    return this.values.get(key)?.value;",
    "  }",
    "}",
    "",
  ].join("\n"), "utf-8");
  await writeFile(join(root, "src", "async-cache.mjs"), [
    "export class AsyncCache {",
    "  constructor() {",
    "    this.values = new Map();",
    "  }",
    "  async set(key, value) {",
    "    this.values.set(key, { value });",
    "  }",
    "  async get(key) {",
    "    return this.values.get(key)?.value;",
    "  }",
    "}",
    "",
  ].join("\n"), "utf-8");
  await writeFile(join(root, "tests", "cache.test.mjs"), [
    "import assert from \"node:assert/strict\";",
    "import { AsyncCache } from \"../src/async-cache.mjs\";",
    "import { SyncCache } from \"../src/sync-cache.mjs\";",
    "",
    "const sync = new SyncCache();",
    "sync.set(\"a\", 1, 1000);",
    "assert.equal(sync.get(\"a\"), 1);",
    "",
    "const asyncCache = new AsyncCache();",
    "await asyncCache.set(\"a\", 1, 1000);",
    "assert.equal(await asyncCache.get(\"a\"), 1);",
    "console.log(\"cache tests passed\");",
    "",
  ].join("\n"), "utf-8");
  return root;
}

function syncCacheWithTtlSource(): string {
  return [
    "export class SyncCache {",
    "  constructor(now = () => Date.now()) {",
    "    this.values = new Map();",
    "    this.now = now;",
    "  }",
    "  set(key, value, ttlMs = Infinity) {",
    "    const expiresAt = Number.isFinite(ttlMs) ? this.now() + ttlMs : Infinity;",
    "    this.values.set(key, { value, expiresAt });",
    "  }",
    "  get(key) {",
    "    const entry = this.values.get(key);",
    "    if (!entry) return undefined;",
    "    if (entry.expiresAt <= this.now()) {",
    "      this.values.delete(key);",
    "      return undefined;",
    "    }",
    "    return entry.value;",
    "  }",
    "}",
    "",
  ].join("\n");
}

function asyncCacheWithTtlSource(): string {
  return [
    "export class AsyncCache {",
    "  constructor(now = () => Date.now()) {",
    "    this.values = new Map();",
    "    this.now = now;",
    "  }",
    "  async set(key, value, ttlMs = Infinity) {",
    "    const expiresAt = Number.isFinite(ttlMs) ? this.now() + ttlMs : Infinity;",
    "    this.values.set(key, { value, expiresAt });",
    "  }",
    "  async get(key) {",
    "    const entry = this.values.get(key);",
    "    if (!entry) return undefined;",
    "    if (entry.expiresAt <= this.now()) {",
    "      this.values.delete(key);",
    "      return undefined;",
    "    }",
    "    return entry.value;",
    "  }",
    "}",
    "",
  ].join("\n");
}

async function hashFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

function expandHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function sanitizeBenchmarkFileName(value: string): string {
  return value
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "attachment.pdf";
}

function preparedInputIdForDocument(document: ManagedDocumentManifest, index: number): string {
  return `att_${index + 1}_${document.documentId.slice(0, 8)}`;
}

function maxPreparedSectionCount(reports: DocumentPreparationReport[]): number {
  return reports.reduce((max, report) => Math.max(max, report.sectionCount ?? 0), 0);
}

async function hasToolOutputContaining(runPath: string, toolName: string, expectedText: string): Promise<boolean> {
  try {
    const stepsDir = join(runPath, "steps");
    const files = (await readdir(stepsDir)).filter((file) => file.endsWith("-act.md"));
    for (const file of files) {
      const text = await readFile(join(stepsDir, file), "utf-8");
      if (text.includes(toolName) && text.includes(expectedText)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function snapshotDirectory(source: string, destination: string): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
}

async function writeDiffPatch(beforeDir: string, afterDir: string, outPath: string): Promise<void> {
  const before = await readTextFiles(beforeDir);
  const after = await readTextFiles(afterDir);
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const chunks: string[] = [];
  for (const path of paths) {
    if (before[path] === after[path]) {
      continue;
    }
    chunks.push(`diff --git a/${path} b/${path}`);
    if (before[path] === undefined) {
      chunks.push(`new file mode 100644`, `--- /dev/null`, `+++ b/${path}`);
      chunks.push(...(after[path] ?? "").split("\n").map((line) => `+${line}`));
    } else if (after[path] === undefined) {
      chunks.push(`deleted file mode 100644`, `--- a/${path}`, `+++ /dev/null`);
      chunks.push(...before[path].split("\n").map((line) => `-${line}`));
    } else {
      chunks.push(`--- a/${path}`, `+++ b/${path}`);
      chunks.push(...simpleLineDiff(before[path], after[path]));
    }
  }
  await writeFile(outPath, chunks.length > 0 ? `${chunks.join("\n")}\n` : "", "utf-8");
}

async function readTextFiles(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const rel = relative(root, fullPath);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const info = await stat(fullPath);
        if (info.size <= 2_000_000) {
          out[rel] = await readFile(fullPath, "utf-8");
        }
      }
    }
  }
  await walk(root);
  return out;
}

function simpleLineDiff(before: string, after: string): string[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  return [
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ];
}

function evaluateBudgets(budgets: BenchmarkBudget | undefined, actual: {
  llmCalls: number;
  toolCalls: number;
  totalTokens: number;
  latencyMs: number;
}): BenchmarkCheck[] {
  if (!budgets) return [];
  return [
    budgets.maxLlmCalls !== undefined ? check("budget maxLlmCalls", actual.llmCalls <= budgets.maxLlmCalls, `${actual.llmCalls}/${budgets.maxLlmCalls}`) : undefined,
    budgets.maxToolCalls !== undefined ? check("budget maxToolCalls", actual.toolCalls <= budgets.maxToolCalls, `${actual.toolCalls}/${budgets.maxToolCalls}`) : undefined,
    budgets.maxTotalTokens !== undefined ? check("budget maxTotalTokens", actual.totalTokens <= budgets.maxTotalTokens, `${actual.totalTokens}/${budgets.maxTotalTokens}`) : undefined,
    budgets.maxLatencyMs !== undefined ? check("budget maxLatencyMs", actual.latencyMs <= budgets.maxLatencyMs, `${actual.latencyMs}/${budgets.maxLatencyMs}`) : undefined,
  ].filter((entry): entry is BenchmarkCheck => entry !== undefined);
}

async function hasSuccessfulShellStep(runPath: string, expectedText: string): Promise<boolean> {
  try {
    const stepsDir = join(runPath, "steps");
    const files = (await readdir(stepsDir)).filter((file) => file.endsWith("-act.md"));
    for (const file of files) {
      const text = await readFile(join(stepsDir, file), "utf-8");
      if (text.includes(expectedText)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function readOptimizationSummary(runPath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(runPath, "optimization-summary.json"), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function readRecord(value: unknown, path: string[]): Record<string, unknown> {
  let current: unknown = value;
  for (const part of path) {
    if (!isRecord(current)) {
      return {};
    }
    current = current[part];
  }
  return isRecord(current) ? current : {};
}

function readAgentDecisionContextGrowth(metrics: Record<string, unknown>): {
  totalPositiveDeltaEstimatedTokens: number;
  maxDeltaEstimatedTokens: number;
  maxEstimatedTokens: number;
} {
  const growth = readRecord(metrics, ["optimization", "contextGrowth", "agent_decision"]);
  return {
    totalPositiveDeltaEstimatedTokens: readMetricNumber(growth, ["totalPositiveDeltaEstimatedTokens"]),
    maxDeltaEstimatedTokens: readMetricNumber(growth, ["maxDeltaEstimatedTokens"]),
    maxEstimatedTokens: readMetricNumber(growth, ["maxEstimatedTokens"]),
  };
}

function readMetricNumber(value: unknown, path: string[]): number {
  let current: unknown = value;
  for (const part of path) {
    if (!isRecord(current)) {
      return 0;
    }
    current = current[part];
  }
  return typeof current === "number" ? current : 0;
}

function check(name: string, passed: boolean, details?: string): BenchmarkCheck {
  return {
    name,
    passed,
    ...(details ? { details } : {}),
  };
}

function containsInternalHarnessWords(value: string): boolean {
  return /\b(tool call|deterministic verification|workState|reducer|evidence contract|harness step)\b/i.test(value);
}

function renderBenchmarkSummary(summary: BenchmarkRunSummary): string {
  return [
    "# Agent Harness Benchmark Summary",
    "",
    `Output: ${summary.outputRoot}`,
    `Cases: ${summary.passedCases}/${summary.totalCases} passed`,
    `Total latency: ${summary.totalLatencyMs}ms`,
    `Average latency: ${summary.averageLatencyMs}ms`,
    `LLM calls: ${summary.totalLlmCalls}`,
    `Tool calls: ${summary.totalToolCalls}`,
    `Total tokens: ${summary.totalTokens}`,
    `Estimated cost: $${summary.totalEstimatedCostUsd}`,
    "",
    "| Case | Tier | Category | Result | LLM | Tools | Tokens | Max Prompt | Max Context Delta | Latency |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summary.results.map((result) => `| ${result.caseId} | ${result.tier} | ${result.category} | ${result.success ? "PASS" : "FAIL"} | ${result.llmCalls} | ${result.totalToolCalls} | ${result.totalTokens} | ${result.maxPromptEstimatedTokens} | ${result.maxContextDeltaTokens} | ${result.latencyMs}ms |`),
    "",
  ].join("\n");
}

function renderHumanReview(summary: BenchmarkRunSummary): string {
  const lines = [
    "# Agent Harness Benchmark Human Review",
    "",
    `Started: ${summary.startedAt}`,
    `Finished: ${summary.finishedAt}`,
    `Cases: ${summary.passedCases}/${summary.totalCases} passed`,
    "",
  ];

  for (const result of summary.results) {
    lines.push(
      `## ${result.caseId}`,
      "",
      `Title: ${result.title}`,
      `Tier: ${result.tier}`,
      `Category: ${result.category}`,
      `Status: ${result.status}`,
      `Run class: ${result.runClass}`,
      `Latency: ${result.latencyMs}ms`,
      `Iterations: ${result.totalIterations}`,
      `LLM calls: ${result.llmCalls}`,
      `Tool calls: ${result.totalToolCalls}`,
      `Tokens: ${result.totalTokens}`,
      `Max prompt estimated tokens: ${result.maxPromptEstimatedTokens}`,
      `Max context delta tokens: ${result.maxContextDeltaTokens}`,
      `Total positive context growth tokens: ${result.totalContextGrowthTokens}`,
      `Run path: ${result.runPath}`,
      result.workspacePath ? `Workspace: ${result.workspacePath}` : "",
      "",
      "Checks:",
      ...result.checks.map((entry) => `- ${entry.passed ? "PASS" : "FAIL"} ${entry.name}${entry.details ? `: ${truncate(entry.details, 220)}` : ""}`),
      "",
      "Budget checks:",
      ...(result.budgetResults.length > 0 ? result.budgetResults.map((entry) => `- ${entry.passed ? "PASS" : "WARN"} ${entry.name}${entry.details ? `: ${entry.details}` : ""}`) : ["- No budgets configured"]),
      "",
      "Review files:",
      `- ${join(result.outputDir, "step-trace.md")}`,
      `- ${join(result.outputDir, "diff.patch")}`,
      `- ${join(result.outputDir, "provider-usage.json")}`,
      `- ${join(result.outputDir, "prompt-metrics.json")}`,
      `- ${join(result.outputDir, "context-growth.json")}`,
      "",
      "Human rubric:",
      "- Correctness: _/5",
      "- Minimality: _/5",
      "- Verification quality: _/5",
      "- Context efficiency: _/5",
      "- Tool discipline: _/5",
      "- Final answer quality: _/5",
      "- Risk: low / medium / high",
      "",
    );
  }

  return `${lines.filter((line) => line !== "").join("\n")}\n`;
}

function renderStepTrace(result: BenchmarkCaseResult, trace: StepTraceEntry[]): string {
  const lines = [
    `# Step Trace: ${result.caseId}`,
    "",
    `Status: ${result.status}`,
    `Success: ${result.success}`,
    `Run path: ${result.runPath}`,
    "",
  ];
  for (const entry of trace) {
    lines.push(`## Step ${entry.step}: ${entry.type}`);
    if (entry.tool) lines.push(`Tool: ${entry.tool}`);
    if (entry.status) lines.push(`Status: ${entry.status}`);
    if (entry.verificationMethod) lines.push(`Verification: ${entry.verificationMethod}`);
    if (entry.validationStatus) lines.push(`Validation: ${entry.validationStatus}`);
    if (entry.summary) lines.push("", entry.summary);
    if (entry.outputPreview) lines.push("", "Output preview:", "```text", entry.outputPreview, "```");
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function filterCases(cases: BenchmarkCase[], options: {
  caseId?: string;
  tier?: BenchmarkTier;
  category?: BenchmarkCategory;
}): BenchmarkCase[] {
  return cases.filter((entry) => {
    if (options.caseId && entry.id !== options.caseId) return false;
    if (options.tier && entry.tier !== options.tier) return false;
    if (options.category && entry.category !== options.category) return false;
    return true;
  });
}

function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = { list: false, pdfPaths: [], maxPdfs: 2, requirePdf: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg || arg === "--") {
      continue;
    }
    if (arg === "--list") {
      options.list = true;
    } else if (arg === "--output") {
      const value = args[index + 1];
      if (value) {
        options.outputRoot = resolve(value);
        index++;
      }
    } else if (arg.startsWith("--output=")) {
      options.outputRoot = resolve(arg.slice("--output=".length));
    } else if (arg === "--case") {
      const value = args[index + 1];
      if (value) {
        options.caseId = value;
        index++;
      }
    } else if (arg.startsWith("--case=")) {
      options.caseId = arg.slice("--case=".length);
    } else if (arg === "--tier") {
      const value = args[index + 1];
      if (value) {
        options.tier = value as BenchmarkTier;
        index++;
      }
    } else if (arg.startsWith("--tier=")) {
      options.tier = arg.slice("--tier=".length) as BenchmarkTier;
    } else if (arg === "--category") {
      const value = args[index + 1];
      if (value) {
        options.category = value as BenchmarkCategory;
        index++;
      }
    } else if (arg.startsWith("--category=")) {
      options.category = arg.slice("--category=".length) as BenchmarkCategory;
    } else if (arg === "--pdf") {
      const value = args[index + 1];
      if (value) {
        options.pdfPaths.push(resolve(expandHomePath(value)));
        index++;
      }
    } else if (arg.startsWith("--pdf=")) {
      options.pdfPaths.push(resolve(expandHomePath(arg.slice("--pdf=".length))));
    } else if (arg === "--pdf-dir") {
      const value = args[index + 1];
      if (value) {
        options.pdfDir = resolve(expandHomePath(value));
        index++;
      }
    } else if (arg.startsWith("--pdf-dir=")) {
      options.pdfDir = resolve(expandHomePath(arg.slice("--pdf-dir=".length)));
    } else if (arg === "--max-pdfs") {
      const value = args[index + 1];
      if (value) {
        options.maxPdfs = parsePositiveInt(value, options.maxPdfs);
        index++;
      }
    } else if (arg.startsWith("--max-pdfs=")) {
      options.maxPdfs = parsePositiveInt(arg.slice("--max-pdfs=".length), options.maxPdfs);
    } else if (arg === "--require-pdf") {
      options.requirePdf = true;
    }
  }
  return options;
}

function printCaseList(cases: BenchmarkCase[]): void {
  for (const entry of cases) {
    console.log(`${entry.id}\t${entry.tier}\t${entry.category}\t${entry.estimatedRuntime}\t${entry.title}`);
  }
}

function toRunStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function truncate(value: string, maxChars: number): string {
  const compact = value.trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const cases = buildCases();
  if (options.list) {
    printCaseList(filterCases(cases, options));
    return;
  }
  const summary = await runAgentHarnessBenchmarks(options);
  const summaryPath = join(summary.outputRoot, "benchmark-summary.json");

  console.log(`Agent harness benchmark: ${summary.passedCases}/${summary.totalCases} passed`);
  console.log(`Average latency: ${summary.averageLatencyMs}ms`);
  console.log(`Summary: ${summaryPath}`);
  if (summary.failedCases > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
