import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { buildAgentStateView } from "../ivec/agent-runner/state-view.js";
import { selectToolsForDecision } from "../ivec/agent-runner/tool-selector.js";
import type { LoopState } from "../ivec/types.js";
import { createToolExecutor } from "../skills/tool-executor.js";
import type { ToolDefinition, ToolResult } from "../skills/types.js";
import type { ActivityUpsertInput, ConversationExchange } from "../memory/types.js";
import { ActivityStore } from "../memory/activity/activity-store.js";
import { PersonalMemoryStore } from "../memory/personal/personal-memory-store.js";
import { DEFAULT_MEMORY_POLICY } from "../memory/personal/memory-policy.js";
import type { MemoryProposal } from "../memory/personal/types.js";
import { LanceDocumentVectorStore } from "../documents/document-vector-store.js";
import type { DocumentChunkVectorRecord } from "../documents/document-vector-types.js";
import { findFilesTool } from "../skills/builtins/filesystem/find-files.js";
import { searchInFilesTool } from "../skills/builtins/filesystem/search-in-files.js";
import { InboundQueueStore } from "../core/runtime/inbound-queue-store.js";
import type { CanonicalInboundEvent } from "../core/contracts/system-ingress.js";
import { PulseStore } from "../pulse/store.js";
import { UploadServer } from "../server/upload-server.js";

type RuntimeScale = "smoke" | "standard" | "stress";

type RuntimeBenchmarkCaseId =
  | "context_tool_selection"
  | "activity_store"
  | "personal_memory"
  | "document_vector_fallback"
  | "filesystem_tools"
  | "inbound_queue"
  | "pulse_scheduler"
  | "http_server";

interface RuntimeScaleConfig {
  stateExchanges: number;
  toolCount: number;
  activityThreads: number;
  personalCards: number;
  vectorRecords: number;
  filesystemFiles: number;
  queueEvents: number;
  pulseItems: number;
  shortIterations: number;
  mediumIterations: number;
  longIterations: number;
  concurrency: number;
}

interface RuntimeBenchmarkOptions {
  scale: RuntimeScale;
  caseId?: RuntimeBenchmarkCaseId;
  outputRoot?: string;
}

interface OperationDurationStats {
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  totalMs: number;
}

interface OperationResult {
  operation: string;
  description: string;
  fixture: Record<string, number | string | boolean>;
  iterations: number;
  itemsPerIteration: number;
  itemLabel: string;
  totalItems: number;
  opsPerSecond: number;
  duration: OperationDurationStats;
  heapBeforeBytes: number;
  heapAfterBytes: number;
  heapDeltaBytes: number;
  warning?: string;
}

interface CaseResult {
  caseId: RuntimeBenchmarkCaseId;
  title: string;
  whyItMatters: string;
  operations: OperationResult[];
  fixture: Record<string, number | string | boolean>;
  warnings: string[];
  durationMs: number;
}

interface RuntimeBenchmarkSummary {
  name: string;
  startedAt: string;
  finishedAt: string;
  scale: RuntimeScale;
  outputRoot: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  totalCases: number;
  totalOperations: number;
  totalWarnings: number;
  totalDurationMs: number;
  cases: CaseResult[];
}

interface MeasureOptions {
  description: string;
  fixture: Record<string, number | string | boolean>;
  iterations: number;
  itemsPerIteration?: number;
  itemLabel?: string;
  warmupIterations?: number;
  warnIfP95MsAbove?: number;
}

const SCALE_CONFIGS: Record<RuntimeScale, RuntimeScaleConfig> = {
  smoke: {
    stateExchanges: 80,
    toolCount: 120,
    activityThreads: 80,
    personalCards: 120,
    vectorRecords: 300,
    filesystemFiles: 120,
    queueEvents: 200,
    pulseItems: 40,
    shortIterations: 3,
    mediumIterations: 12,
    longIterations: 30,
    concurrency: 4,
  },
  standard: {
    stateExchanges: 800,
    toolCount: 800,
    activityThreads: 700,
    personalCards: 1_000,
    vectorRecords: 2_500,
    filesystemFiles: 800,
    queueEvents: 2_000,
    pulseItems: 250,
    shortIterations: 8,
    mediumIterations: 50,
    longIterations: 150,
    concurrency: 8,
  },
  stress: {
    stateExchanges: 3_000,
    toolCount: 3_000,
    activityThreads: 5_000,
    personalCards: 10_000,
    vectorRecords: 25_000,
    filesystemFiles: 5_000,
    queueEvents: 20_000,
    pulseItems: 2_000,
    shortIterations: 10,
    mediumIterations: 75,
    longIterations: 200,
    concurrency: 16,
  },
};

const CASES: Array<{
  caseId: RuntimeBenchmarkCaseId;
  title: string;
  run: (config: RuntimeScaleConfig) => Promise<CaseResult>;
}> = [
  {
    caseId: "context_tool_selection",
    title: "Context Pack, State View, And Tool Selection",
    run: runContextToolSelectionCase,
  },
  {
    caseId: "activity_store",
    title: "Activity Store Retrieval",
    run: runActivityStoreCase,
  },
  {
    caseId: "personal_memory",
    title: "Personal Memory Retrieval",
    run: runPersonalMemoryCase,
  },
  {
    caseId: "document_vector_fallback",
    title: "Document Vector Fallback Retrieval",
    run: runDocumentVectorFallbackCase,
  },
  {
    caseId: "filesystem_tools",
    title: "Filesystem Search Tools",
    run: runFilesystemToolsCase,
  },
  {
    caseId: "inbound_queue",
    title: "Inbound Queue Throughput",
    run: runInboundQueueCase,
  },
  {
    caseId: "pulse_scheduler",
    title: "Pulse Scheduler And Due Occurrence Leasing",
    run: runPulseSchedulerCase,
  },
  {
    caseId: "http_server",
    title: "HTTP Upload And Artifact Load",
    run: runHttpServerCase,
  },
];

const thisFile = fileURLToPath(import.meta.url);
const thisDir = dirname(thisFile);
const packageRoot = resolve(thisDir, "..", "..");
const defaultOutputBase = resolve(packageRoot, "data", "benchmarks", "runtime-performance");

export async function runRuntimePerformanceBenchmarks(
  options: RuntimeBenchmarkOptions = { scale: "standard" },
): Promise<RuntimeBenchmarkSummary> {
  const scale = options.scale ?? "standard";
  const config = SCALE_CONFIGS[scale];
  const startedAt = new Date();
  const outputRoot = resolve(options.outputRoot ?? join(defaultOutputBase, toRunStamp(startedAt)));
  await mkdir(outputRoot, { recursive: true });

  const selectedCases = options.caseId
    ? CASES.filter((entry) => entry.caseId === options.caseId)
    : CASES;
  if (selectedCases.length === 0) {
    throw new Error(`Unknown runtime benchmark case: ${String(options.caseId)}`);
  }

  const cases: CaseResult[] = [];
  for (const benchmarkCase of selectedCases) {
    console.log(`runtime benchmark: ${benchmarkCase.caseId} (${scale})`);
    cases.push(await benchmarkCase.run(config));
  }

  const finishedAt = new Date();
  const totalDurationMs = finishedAt.getTime() - startedAt.getTime();
  const summary: RuntimeBenchmarkSummary = {
    name: "Runtime Performance Benchmark",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    scale,
    outputRoot,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    totalCases: cases.length,
    totalOperations: sum(cases.map((entry) => entry.operations.length)),
    totalWarnings: sum(cases.map((entry) => entry.warnings.length)),
    totalDurationMs,
    cases,
  };

  await writeFile(join(outputRoot, "runtime-performance-results.json"), `${JSON.stringify(cases, null, 2)}\n`, "utf-8");
  await writeFile(join(outputRoot, "runtime-performance-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
  await writeFile(join(outputRoot, "runtime-performance-summary.md"), renderSummary(summary), "utf-8");
  return summary;
}

async function runContextToolSelectionCase(config: RuntimeScaleConfig): Promise<CaseResult> {
  const startedAt = performance.now();
  const state = buildLoopStateFixture(config.stateExchanges);
  const tools = buildToolFixture(config.toolCount);
  const executor = createToolExecutor(tools.slice(0, Math.max(1, Math.floor(config.toolCount / 2))));
  for (let group = 0; group < 4; group++) {
    const start = Math.floor(config.toolCount / 2) + (group * 25);
    const mounted = tools.slice(start, start + 25);
    executor.mount?.(`bench:group:${group}`, mounted, {
      scope: "run",
      runId: state.runId,
      sessionId: "bench-session",
      skillId: `bench-skill-${group}`,
      toolIds: mounted.map((tool) => tool.name),
    });
  }

  const fixture = {
    stateExchanges: config.stateExchanges,
    toolCount: config.toolCount,
    mountedGroups: 4,
  };
  const operations = [
    await measureOperation("build_state_view", async () => {
      const view = buildAgentStateView(state);
      if (view.context.currentInput.length === 0) {
        throw new Error("state view fixture was empty.");
      }
    }, {
      description: "Build bounded model-facing state from large recent activity and continuity context.",
      fixture,
      iterations: config.longIterations,
      warnIfP95MsAbove: 20,
    }),
    await measureOperation("select_tools_for_decision", async () => {
      const selected = selectToolsForDecision(state, tools, 24);
      if (selected.length === 0) {
        throw new Error("tool selection returned no tools.");
      }
    }, {
      description: "Score many tool definitions against the current state and pick the decision subset.",
      fixture,
      iterations: config.mediumIterations,
      warnIfP95MsAbove: 50,
    }),
    await measureOperation("tool_executor_visible_index_validate", async () => {
      const definitions = executor.definitions({ runId: state.runId, sessionId: "bench-session", stepNumber: 2 });
      const target = definitions[definitions.length - 1];
      if (!target) {
        throw new Error("tool executor fixture was empty.");
      }
      const validation = executor.validate(target.name, { value: "alpha" }, {
        runId: state.runId,
        sessionId: "bench-session",
        stepNumber: 2,
      });
      if (!validation.valid) {
        throw new Error(validation.error);
      }
    }, {
      description: "Rebuild visible dynamic tool index and validate a selected tool input.",
      fixture,
      iterations: config.mediumIterations,
      warnIfP95MsAbove: 30,
    }),
  ];

  return buildCaseResult({
    caseId: "context_tool_selection",
    title: "Context Pack, State View, And Tool Selection",
    whyItMatters: "This path runs before decisions. If it grows with history or tools, every agent turn slows before the LLM is called.",
    fixture,
    operations,
    startedAt,
  });
}

async function runActivityStoreCase(config: RuntimeScaleConfig): Promise<CaseResult> {
  return withTempDir("ayati-runtime-activity-", async (root) => {
    const startedAt = performance.now();
    const store = new ActivityStore({ dbPath: join(root, "memory.sqlite"), now: fixedNow });
    store.start();
    try {
      const clientId = "bench-client";
      const sessionId = "bench-session";
      seedActivityStore(store, clientId, sessionId, config.activityThreads);
      const fixture = { activityThreads: config.activityThreads, clientCount: 1 };
      let upsertIndex = 0;
      const operations = [
        await measureOperation("activity_recent_list", async () => {
          const recent = store.listRecent(clientId, 5);
          if (recent.length === 0) {
            throw new Error("recent activity list returned no threads.");
          }
        }, {
          description: "Read the deterministic recent activity list used as a fallback for follow-up phrasing.",
          fixture,
          iterations: config.mediumIterations,
          warnIfP95MsAbove: 40,
        }),
        await measureOperation("activity_identity_lookup", async () => {
          const activity = store.getActivityByIdentity(clientId, "file_path", "src/module-1.ts");
          if (!activity) {
            throw new Error("activity identity lookup returned no thread.");
          }
        }, {
          description: "Resolve an activity thread by an exact durable identity anchor.",
          fixture,
          iterations: config.mediumIterations,
          warnIfP95MsAbove: 40,
        }),
        await measureOperation("activity_search", async () => {
          const matches = store.search(clientId, "project artifact module", { limit: 5 });
          if (matches.length === 0) {
            throw new Error("activity search returned no matches.");
          }
        }, {
          description: "Search activity threads through SQLite text filtering and deterministic token scoring.",
          fixture,
          iterations: config.mediumIterations,
          warnIfP95MsAbove: 50,
        }),
        await measureOperation("activity_identity_upsert", async () => {
          const index = upsertIndex % Math.max(1, config.activityThreads);
          upsertIndex++;
          store.upsertFromTaskSummary(makeActivityInput(clientId, sessionId, index, {
            runId: `activity-upsert-${randomUUID()}`,
            summary: `Follow-up on project-${index} artifact src/module-${index}.ts with more verified context.`,
            currentFocus: `project-${index}`,
          }));
        }, {
          description: "Upsert follow-up task summaries and find existing identity matches.",
          fixture,
          iterations: config.shortIterations,
          warnIfP95MsAbove: 80,
        }),
      ];
      return buildCaseResult({
        caseId: "activity_store",
        title: "Activity Store Retrieval",
        whyItMatters: "Activity threads are the agent's continuation surface. Slow search or identity lookup makes follow-up tasks slower and less likely to recover the right task state.",
        fixture,
        operations,
        startedAt,
      });
    } finally {
      store.stop();
    }
  });
}

async function runPersonalMemoryCase(config: RuntimeScaleConfig): Promise<CaseResult> {
  return withTempDir("ayati-runtime-personal-", async (root) => {
    const startedAt = performance.now();
    const store = new PersonalMemoryStore({ dbPath: join(root, "personal.sqlite"), now: fixedNow });
    store.start(DEFAULT_MEMORY_POLICY);
    try {
      const userId = "bench-client";
      seedPersonalMemoryStore(store, userId, config.personalCards);
      const fixture = { memoryCards: config.personalCards, userCount: 1 };
      const proposal: MemoryProposal = {
        text: "The user prefers project artifact memory retrieval reports.",
        kind: "preference",
        slot: "project_artifact_memory",
        value: "prefers runtime benchmark reports",
        confidence: 0.91,
        importance: 0.75,
        sourceType: "explicit_user_statement",
        sourceReliability: 0.95,
        evidence: "User asked for runtime performance reports for the agent.",
      };
      const operations = [
        await measureOperation("personal_memory_fts_search", async () => {
          const results = store.searchMemories(userId, {
            query: "project artifact memory",
            limit: 10,
          });
          if (results.length === 0) {
            throw new Error("personal memory FTS returned no matches.");
          }
        }, {
          description: "Search durable personal memories through FTS5.",
          fixture,
          iterations: config.mediumIterations,
          warnIfP95MsAbove: 40,
        }),
        await measureOperation("personal_memory_evolution_candidates", async () => {
          const candidates = store.findEvolutionCandidates(userId, proposal, 20);
          if (candidates.length === 0) {
            throw new Error("candidate lookup returned no matches.");
          }
        }, {
          description: "Combine exact address, aliases, same-slot, FTS, and recent memory candidates.",
          fixture,
          iterations: config.mediumIterations,
          warnIfP95MsAbove: 70,
        }),
        await measureOperation("personal_memory_snapshot_get", async () => {
          const snapshot = store.getSnapshot(userId);
          if (snapshot.length === 0) {
            throw new Error("snapshot fixture was empty.");
          }
        }, {
          description: "Read the compact personal memory snapshot used for prompt injection.",
          fixture,
          iterations: config.longIterations,
          warnIfP95MsAbove: 10,
        }),
      ];
      return buildCaseResult({
        caseId: "personal_memory",
        title: "Personal Memory Retrieval",
        whyItMatters: "Personal memory retrieval decides what user facts reach the context pack. Slow lookup increases turn latency and may force lower memory budgets.",
        fixture,
        operations,
        startedAt,
      });
    } finally {
      store.stop();
    }
  });
}

async function runDocumentVectorFallbackCase(config: RuntimeScaleConfig): Promise<CaseResult> {
  return withTempDir("ayati-runtime-doc-vector-", async (root) => {
    const startedAt = performance.now();
    const store = new LanceDocumentVectorStore({ dataDir: root, fallbackFileName: "document-chunks.json" });
    (store as unknown as { lanceDisabled: boolean }).lanceDisabled = true;
    const records = buildVectorRecords(config.vectorRecords);
    await store.upsertDocumentChunks(records);
    const documentIds = uniqueStrings(records.map((record) => record.documentId)).slice(0, 20);
    const fixture = {
      vectorRecords: config.vectorRecords,
      documentIds: documentIds.length,
      dimensions: records[0]?.embedding.length ?? 0,
      lanceForcedOff: true,
    };
    const operations = [
      await measureOperation("document_vector_fallback_search", async () => {
        const matches = await store.search({
          documentIds,
          vector: vectorForSeed(7),
          embeddingModel: "bench-embedding",
          limit: 8,
        });
        if (matches.length === 0) {
          throw new Error("document vector fallback returned no matches.");
        }
      }, {
        description: "Read fallback JSON records, compute cosine similarity, sort, and return top chunks.",
        fixture,
        iterations: config.shortIterations,
        warnIfP95MsAbove: 150,
      }),
    ];
    return buildCaseResult({
      caseId: "document_vector_fallback",
      title: "Document Vector Fallback Retrieval",
      whyItMatters: "When LanceDB is unavailable, document retrieval falls back to JSON-file vector search. This test shows when that fallback becomes too expensive.",
      fixture,
      operations,
      startedAt,
    });
  });
}

async function runFilesystemToolsCase(config: RuntimeScaleConfig): Promise<CaseResult> {
  return withTempDir("ayati-runtime-fs-", async (root) => {
    const startedAt = performance.now();
    await seedFilesystemFixture(root, config.filesystemFiles);
    const fixture = {
      files: config.filesystemFiles,
      roots: 1,
      maxDepth: 8,
    };
    const operations = [
      await measureOperation("find_files_name_scan", async () => {
        const result = await findFilesTool.execute({
          query: "target",
          roots: [root],
          maxDepth: 8,
          maxResults: 50,
        });
        assertToolOk(result, "find_files");
      }, {
        description: "Run the custom BFS filename search over a synthetic workspace tree.",
        fixture,
        iterations: config.shortIterations,
        warnIfP95MsAbove: 250,
      }),
      await measureOperation("search_in_files_content_scan", async () => {
        const result = await searchInFilesTool.execute({
          query: "needle-runtime-performance",
          roots: [root],
          maxDepth: 8,
          maxResults: 50,
          caseSensitive: false,
        });
        assertToolOk(result, "search_in_files");
      }, {
        description: "Run recursive text search with stat/read filtering and result caps.",
        fixture,
        iterations: config.shortIterations,
        warnIfP95MsAbove: 500,
      }),
    ];
    return buildCaseResult({
      caseId: "filesystem_tools",
      title: "Filesystem Search Tools",
      whyItMatters: "Coding-agent work depends on local file search. These scans reveal when custom traversal should be replaced or optimized.",
      fixture,
      operations,
      startedAt,
    });
  });
}

async function runInboundQueueCase(config: RuntimeScaleConfig): Promise<CaseResult> {
  return withTempDir("ayati-runtime-queue-", async (root) => {
    const startedAt = performance.now();
    const store = new InboundQueueStore({ dbPath: join(root, "memory.sqlite") });
    store.start();
    try {
      const fixture = { queueEvents: config.queueEvents };
      const operations = [
        await measureOperation("inbound_queue_enqueue_batch", async () => {
          for (let i = 0; i < config.queueEvents; i++) {
            store.enqueue({
              clientId: "bench-client",
              source: "bench",
              event: makeInboundEvent(i),
              dedupeKey: `bench:event:${i}`,
              createdAt: isoFromOffset(i),
            });
          }
        }, {
          description: "Insert many canonical system events with dedupe keys.",
          fixture,
          iterations: 1,
          itemsPerIteration: config.queueEvents,
          itemLabel: "events",
          warmupIterations: 0,
          warnIfP95MsAbove: 1_500,
        }),
        await measureOperation("inbound_queue_duplicate_enqueue_batch", async () => {
          for (let i = 0; i < config.queueEvents; i++) {
            store.enqueue({
              clientId: "bench-client",
              source: "bench",
              event: makeInboundEvent(i),
              dedupeKey: `bench:event:${i}`,
              createdAt: isoFromOffset(i),
            });
          }
        }, {
          description: "Exercise duplicate rejection through the unique dedupe index.",
          fixture,
          iterations: 1,
          itemsPerIteration: config.queueEvents,
          itemLabel: "duplicates",
          warmupIterations: 0,
          warnIfP95MsAbove: 1_000,
        }),
        await measureOperation("inbound_queue_claim_batch", async () => {
          let claimed = 0;
          while (store.claimNext("2099-01-01T00:00:00.000Z")) {
            claimed++;
          }
          if (claimed !== config.queueEvents) {
            throw new Error(`expected ${config.queueEvents} claims, got ${claimed}`);
          }
        }, {
          description: "Claim queued events in order under backlog.",
          fixture,
          iterations: 1,
          itemsPerIteration: config.queueEvents,
          itemLabel: "claims",
          warmupIterations: 0,
          warnIfP95MsAbove: 2_000,
        }),
      ];
      return buildCaseResult({
        caseId: "inbound_queue",
        title: "Inbound Queue Throughput",
        whyItMatters: "System events and integrations enter through this queue. Slow enqueue or claim paths make reminders and external events lag.",
        fixture,
        operations,
        startedAt,
      });
    } finally {
      store.stop();
    }
  });
}

async function runPulseSchedulerCase(config: RuntimeScaleConfig): Promise<CaseResult> {
  return withTempDir("ayati-runtime-pulse-", async (root) => {
    const startedAt = performance.now();
    const now = new Date("2026-06-17T00:00:00.000Z");
    const store = new PulseStore({ dbPath: join(root, "memory.sqlite"), legacyFilePath: join(root, "legacy.json"), now: () => now });
    const clientId = "bench-client";
    for (let i = 0; i < config.pulseItems; i++) {
      const dueAt = new Date(now.getTime() - ((i + 1) * 60_000)).toISOString();
      await store.createItem({
        clientId,
        kind: i % 5 === 0 ? "task" : "reminder",
        title: `Runtime item ${i}`,
        instruction: `Handle runtime performance item ${i}`,
        timezone: "UTC",
        schedule: { kind: "once", at: dueAt },
        nextDueAt: dueAt,
        payload: i % 5 === 0
          ? { task: { objective: `Benchmark task ${i}`, requestedAction: "analyze" } }
          : { requestedAction: "notify" },
      });
    }

    const fixture = { pulseItems: config.pulseItems, clientCount: 1 };
    const operations = [
      await measureOperation("pulse_get_due_reminders", async () => {
        const due = await store.getDueReminders(clientId, now);
        if (due.length === 0) {
          throw new Error("expected due pulse reminders.");
        }
      }, {
        description: "List active due reminders before dispatch materialization.",
        fixture,
        iterations: config.shortIterations,
        warnIfP95MsAbove: 120,
      }),
      await measureOperation("pulse_lease_due_occurrences", async () => {
        let leased = 0;
        while (true) {
          const batch = await store.leaseDueOccurrences({
            clientId,
            leaseOwner: "runtime-benchmark",
            leaseMs: 300_000,
            now,
            limit: 20,
          });
          leased += batch.length;
          if (batch.length === 0) {
            break;
          }
        }
        if (leased === 0) {
          throw new Error("expected leased pulse occurrences.");
        }
      }, {
        description: "Reconcile, materialize, and lease due occurrences for dispatch.",
        fixture,
        iterations: 1,
        itemsPerIteration: config.pulseItems,
        itemLabel: "occurrences",
        warmupIterations: 0,
        warnIfP95MsAbove: 2_000,
      }),
    ];
    store.close();
    return buildCaseResult({
      caseId: "pulse_scheduler",
      title: "Pulse Scheduler And Due Occurrence Leasing",
      whyItMatters: "Pulse drives reminders and scheduled tasks. Leasing must stay fast with many pending schedules so the daemon remains responsive.",
      fixture,
      operations,
      startedAt,
    });
  });
}

async function runHttpServerCase(config: RuntimeScaleConfig): Promise<CaseResult> {
  return withTempDir("ayati-runtime-http-", async (root) => {
    const startedAt = performance.now();
    const uploadsDir = join(root, "uploads");
    const runsDir = join(root, "runs");
    const runId = "runtime-run";
    await mkdir(join(runsDir, runId), { recursive: true });
    await writeFile(join(runsDir, runId, "artifact.txt"), "runtime artifact\n".repeat(8_000), "utf-8");
    const port = await allocatePort();
    const server = new UploadServer({
      uploadsDir,
      runsDir,
      host: "127.0.0.1",
      port,
      maxUploadBytes: 2 * 1024 * 1024,
    });
    await server.start();
    try {
      const fixture = {
        concurrency: config.concurrency,
        uploadBytes: 64 * 1024,
        artifactBytes: 136_000,
      };
      const operations = [
        await measureOperation("http_artifact_download_concurrent", async () => {
          await Promise.all(Array.from({ length: config.concurrency }, async () => {
            const response = await fetch(`http://127.0.0.1:${port}/api/artifacts/${runId}/artifact.txt`);
            if (!response.ok) {
              throw new Error(`artifact download failed with ${response.status}`);
            }
            await response.arrayBuffer();
          }));
        }, {
          description: "Download artifacts through the HTTP server with concurrent local clients.",
          fixture,
          iterations: config.shortIterations,
          itemsPerIteration: config.concurrency,
          itemLabel: "downloads",
          warnIfP95MsAbove: 500,
        }),
        await measureOperation("http_upload_concurrent", async () => {
          await Promise.all(Array.from({ length: config.concurrency }, async (_, index) => {
            const form = new FormData();
            const payload = new Uint8Array(64 * 1024);
            payload.fill(65 + (index % 20));
            form.append("file", new Blob([payload], { type: "text/plain" }), `upload-${index}.txt`);
            const response = await fetch(`http://127.0.0.1:${port}/api/uploads`, {
              method: "POST",
              body: form,
            });
            if (!response.ok) {
              throw new Error(`upload failed with ${response.status}: ${await response.text()}`);
            }
            await response.json();
          }));
        }, {
          description: "Upload multipart files through request buffering and managed persistence.",
          fixture,
          iterations: config.shortIterations,
          itemsPerIteration: config.concurrency,
          itemLabel: "uploads",
          warnIfP95MsAbove: 800,
        }),
      ];
      return buildCaseResult({
        caseId: "http_server",
        title: "HTTP Upload And Artifact Load",
        whyItMatters: "Uploads and artifacts feed the agent's document/file context. Server load tests reveal body buffering, streaming, and event-loop pressure.",
        fixture,
        operations,
        startedAt,
      });
    } finally {
      await server.stop();
    }
  });
}

async function measureOperation(
  operation: string,
  fn: () => Promise<void> | void,
  options: MeasureOptions,
): Promise<OperationResult> {
  const warmupIterations = options.warmupIterations ?? Math.min(3, options.iterations);
  for (let i = 0; i < warmupIterations; i++) {
    await fn();
  }

  const heapBeforeBytes = process.memoryUsage().heapUsed;
  const durations: number[] = [];
  for (let i = 0; i < options.iterations; i++) {
    const startedAt = performance.now();
    await fn();
    durations.push(performance.now() - startedAt);
  }
  const heapAfterBytes = process.memoryUsage().heapUsed;
  const duration = summarizeDurations(durations);
  const itemsPerIteration = options.itemsPerIteration ?? 1;
  const totalItems = options.iterations * itemsPerIteration;
  const opsPerSecond = duration.totalMs > 0 ? totalItems / (duration.totalMs / 1_000) : 0;
  const warning = options.warnIfP95MsAbove !== undefined && duration.p95Ms > options.warnIfP95MsAbove
    ? `p95 ${formatMs(duration.p95Ms)} exceeded warning threshold ${formatMs(options.warnIfP95MsAbove)}`
    : undefined;

  return {
    operation,
    description: options.description,
    fixture: options.fixture,
    iterations: options.iterations,
    itemsPerIteration,
    itemLabel: options.itemLabel ?? "operations",
    totalItems,
    opsPerSecond: round(opsPerSecond, 2),
    duration,
    heapBeforeBytes,
    heapAfterBytes,
    heapDeltaBytes: heapAfterBytes - heapBeforeBytes,
    ...(warning ? { warning } : {}),
  };
}

function buildCaseResult(input: {
  caseId: RuntimeBenchmarkCaseId;
  title: string;
  whyItMatters: string;
  fixture: Record<string, number | string | boolean>;
  operations: OperationResult[];
  startedAt: number;
}): CaseResult {
  const warnings = input.operations
    .map((operation) => operation.warning)
    .filter((warning): warning is string => warning !== undefined);
  return {
    caseId: input.caseId,
    title: input.title,
    whyItMatters: input.whyItMatters,
    operations: input.operations,
    fixture: input.fixture,
    warnings,
    durationMs: round(performance.now() - input.startedAt, 2),
  };
}

function summarizeDurations(values: number[]): OperationDurationStats {
  const sorted = [...values].sort((left, right) => left - right);
  const totalMs = sum(values);
  return {
    minMs: round(sorted[0] ?? 0, 3),
    meanMs: round(values.length > 0 ? totalMs / values.length : 0, 3),
    p50Ms: round(percentile(sorted, 50), 3),
    p95Ms: round(percentile(sorted, 95), 3),
    p99Ms: round(percentile(sorted, 99), 3),
    maxMs: round(sorted[sorted.length - 1] ?? 0, 3),
    totalMs: round(totalMs, 3),
  };
}

function percentile(sorted: number[], percentileValue: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function buildLoopStateFixture(exchangeCount: number): LoopState {
  const now = "2026-06-17T00:00:00.000Z";
  return {
    runId: "runtime-state-view",
    runClass: "task",
    inputKind: "user_message",
    userMessage: "Find the project artifact memory report and continue the performance analysis.",
    workState: {
      status: "not_done",
      summary: "Runtime performance benchmark in progress.",
      openWork: ["Measure memory retrieval", "Measure filesystem scan"],
      blockers: [],
      verifiedFacts: ["Benchmark uses deterministic local fixtures."],
      evidence: ["Synthetic activity and memory stores are seeded."],
      nextStep: "Run non-LLM performance measurements.",
    },
    latestObservation: {
      id: "obs-latest",
      step: 1,
      callId: "call-1",
      tool: "search_in_files",
      status: "success",
      mode: "summary",
      content: "Found runtime benchmark targets in memory and document modules.",
      hasMore: false,
    },
    toolContext: {
      recent: Array.from({ length: 5 }, (_, index) => ({
        id: `obs-${index}`,
        step: index,
        callId: `call-${index}`,
        tool: index % 2 === 0 ? "find_files" : "search_in_files",
        status: "success",
        mode: "summary",
        content: `Observation ${index} about activity threads and project artifacts.`,
        hasMore: false,
      })),
    },
    status: "running",
    finalOutput: "",
    iteration: 2,
    maxIterations: 15,
    consecutiveFailures: 0,
    completedSteps: [
      {
        step: 1,
        outcome: "success",
        summary: "Located benchmark targets.",
        newFacts: ["Activity store search is a target."],
        artifacts: [],
        toolsUsed: ["search_in_files"],
        toolSuccessCount: 1,
        toolFailureCount: 0,
      },
    ],
    runPath: "/tmp/runtime-state-view",
    failureHistory: [],
    activeLearningContext: "Learning context: runtime performance analysis.",
    personalMemorySnapshot: "User prefers detailed reports about agent runtime performance.",
    continuity: {
      mode: "continue",
      confidence: 0.91,
      reasons: ["benchmark fixture exact activity anchor"],
      current: {
        activityId: "activity-runtime-benchmark",
        kind: "project",
        title: "runtime performance analysis",
        openWork: ["Measure memory retrieval", "Measure filesystem scan"],
        nextStep: "Run non-LLM performance measurements.",
        verifiedFacts: ["Benchmark uses deterministic local fixtures."],
        topAssets: ["reports/runtime-performance.md"],
        lastTouchedAt: now,
      },
    },
    recentExchanges: buildExchangeFixture(exchangeCount, now),
  };
}

function buildExchangeFixture(count: number, timestamp: string): ConversationExchange[] {
  return Array.from({ length: count }, (_, index) => ({
    runId: `exchange-${index}`,
    user: {
      timestamp,
      content: `User message ${index} asking about runtime performance, project artifacts, and memory retrieval.`,
    },
    assistant: {
      timestamp,
      content: `Assistant response ${index} describing non-LLM agent performance checks.`,
      responseKind: "reply",
    },
  }));
}

function buildToolFixture(count: number): ToolDefinition[] {
  return Array.from({ length: count }, (_, index) => {
    const domain = index % 5 === 0
      ? "filesystem"
      : index % 5 === 1
        ? "documents"
        : index % 5 === 2
          ? "memory"
          : index % 5 === 3
            ? "database"
            : "general";
    return {
      name: `bench_tool_${index}`,
      description: `Benchmark tool ${index} for ${domain} runtime performance project artifact analysis.`,
      inputSchema: {
        type: "object",
        required: ["value"],
        properties: {
          value: { type: "string" },
        },
      },
      annotations: {
        domain,
        readOnly: true,
        mutatesWorkspace: false,
        mutatesExternalWorld: false,
        destructive: false,
        idempotent: true,
        retrySafe: true,
        longRunning: false,
      },
      selectionHints: {
        domain,
        tags: ["runtime", "performance", domain],
        aliases: [`bench-${domain}-${index}`],
        examples: [`analyze ${domain} benchmark`],
        priority: index % 17 === 0 ? 5 : 0,
      },
      async execute(): Promise<ToolResult> {
        return { ok: true, output: "ok" };
      },
    };
  });
}

function seedActivityStore(store: ActivityStore, clientId: string, sessionId: string, count: number): void {
  for (let index = 0; index < count; index++) {
    store.upsertFromTaskSummary(makeActivityInput(clientId, sessionId, index));
  }
}

function makeActivityInput(
  clientId: string,
  sessionId: string,
  index: number,
  overrides: Partial<ActivityUpsertInput> = {},
): ActivityUpsertInput {
  const createdAt = isoFromOffset(index);
  return {
    clientId,
    sessionId,
    runId: `activity-run-${index}`,
    runPath: `/tmp/runtime-activity/run-${index}`,
    status: "completed",
    taskStatus: index % 4 === 0 ? "not_done" : "done",
    objective: `Improve runtime performance for project-${index}`,
    summary: `Updated project-${index} artifact src/module-${index}.ts and recorded performance evidence.`,
    progressSummary: `Measured activity thread ${index}.`,
    currentFocus: `project-${index}`,
    completedMilestones: [`Seeded activity thread ${index}`],
    openWork: index % 4 === 0 ? [`Follow up on module ${index}`] : [],
    blockers: [],
    keyFacts: [`project-${index} uses artifact src/module-${index}.ts`],
    evidence: [`src/module-${index}.ts verified`],
    userMessage: `Continue project-${index}`,
    assistantResponse: `Recorded project-${index}.`,
    actionType: "runtime_benchmark",
    entityHints: [`project-${index}`, `module-${index}`],
    toolsUsed: ["search_in_files", "read_file"],
    nextAction: `Check project-${index} retrieval speed.`,
    attachmentNames: [`artifact-${index}.txt`],
    activityAssets: [{
      assetId: `asset-module-${index}`,
      kind: "file",
      origin: "agent_modified",
      role: "working_artifact",
      displayName: `module-${index}.ts`,
      path: `src/module-${index}.ts`,
      restore: { filePath: `src/module-${index}.ts` },
      sourceRunId: `activity-run-${index}`,
      sourceRunPath: `/tmp/runtime-activity/run-${index}`,
      lastUsedRunId: `activity-run-${index}`,
      lastUsedAt: createdAt,
    }],
    createdAt,
    ...overrides,
  };
}

function seedPersonalMemoryStore(store: PersonalMemoryStore, userId: string, count: number): void {
  for (let index = 0; index < count; index++) {
    const sectionId = index % 5 === 0 ? "evolving_memory" : index % 7 === 0 ? "time_based" : "user_facts";
    store.createCard({
      userId,
      sectionId,
      kind: index % 3 === 0 ? "preference" : "project",
      slot: index % 10 === 0 ? "project_artifact_memory" : `runtime_slot_${index % 50}`,
      text: `Memory ${index}: user cares about project artifact memory retrieval and runtime benchmark reports.`,
      value: `runtime-value-${index}`,
      ...(sectionId === "time_based" ? { expiresAt: "2099-01-01T00:00:00.000Z" } : {}),
      state: index % 4 === 0 ? "candidate" : "active",
      confidence: 0.82 + ((index % 10) * 0.01),
      importance: 0.5 + ((index % 7) * 0.03),
      sourceType: "explicit_user_statement",
      sourceReliability: 0.95,
      createdAt: isoFromOffset(index),
    });
    if (index % 40 === 0) {
      store.upsertMemoryAlias({
        userId,
        sectionId,
        aliasKind: "preference",
        aliasSlot: `artifact_alias_${index}`,
        targetKind: index % 3 === 0 ? "preference" : "project",
        targetSlot: index % 10 === 0 ? "project_artifact_memory" : `runtime_slot_${index % 50}`,
        confidence: 0.9,
        createdAt: isoFromOffset(index),
      });
    }
  }
  store.updateSnapshot(
    userId,
    [
      "- User prefers detailed runtime performance benchmark reports.",
      "- User wants non-LLM agent data-structure and algorithm evidence.",
      "- Project artifact memory retrieval is important.",
    ].join("\n"),
    [],
    "2026-06-17T00:00:00.000Z",
  );
}

function buildVectorRecords(count: number): DocumentChunkVectorRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const documentIndex = index % 100;
    return {
      id: `bench-embedding:doc-${documentIndex}:chunk-${index}`,
      documentId: `doc-${documentIndex}`,
      checksum: `checksum-${documentIndex}`,
      sourceId: `doc-${documentIndex}:segment-1:chunk-${index}`,
      documentName: `Document ${documentIndex}`,
      documentPath: `/tmp/document-${documentIndex}.txt`,
      location: `section:${index % 12}`,
      text: `Runtime performance document chunk ${index} about memory retrieval, project artifacts, and non LLM agent benchmarks.`,
      tokens: 80 + (index % 40),
      embedding: vectorForSeed(index),
      embeddingModel: "bench-embedding",
      indexedAt: isoFromOffset(index),
    };
  });
}

function vectorForSeed(seed: number): number[] {
  return Array.from({ length: 32 }, (_, index) => {
    const value = ((seed + 3) * (index + 11)) % 97;
    return value / 97;
  });
}

async function seedFilesystemFixture(root: string, fileCount: number): Promise<void> {
  for (let index = 0; index < fileCount; index++) {
    const dir = join(root, `dir-${index % 20}`, `nested-${index % 7}`);
    await mkdir(dir, { recursive: true });
    const isTarget = index % 37 === 0;
    const name = isTarget ? `target-runtime-${index}.txt` : `file-${index}.txt`;
    const content = [
      `file=${index}`,
      isTarget ? "needle-runtime-performance appears here" : "ordinary benchmark fixture content",
      "runtime performance filesystem scan fixture",
    ].join("\n");
    await writeFile(join(dir, name), content, "utf-8");
  }
}

function makeInboundEvent(index: number): CanonicalInboundEvent {
  return {
    type: "system_event",
    eventId: `evt-${index}`,
    source: "bench",
    eventName: "runtime_event",
    receivedAt: isoFromOffset(index),
    summary: `Runtime benchmark event ${index}`,
    payload: {
      index,
      dedupeKey: `bench:event:${index}`,
    },
    intent: {
      kind: "notification",
      eventClass: "state_changed",
      trustTier: "internal",
      effectLevel: "observe",
      createdBy: "system",
    },
  };
}

function assertToolOk(result: ToolResult, toolName: string): void {
  if (!result.ok) {
    throw new Error(`${toolName} failed: ${result.error ?? "unknown error"}`);
  }
}

function fixedNow(): Date {
  return new Date("2026-06-17T00:00:00.000Z");
}

function isoFromOffset(offset: number): string {
  return new Date(Date.UTC(2026, 5, 17, 0, 0, 0, 0) + offset * 1_000).toISOString();
}

function toRunStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function renderSummary(summary: RuntimeBenchmarkSummary): string {
  const lines = [
    "# Runtime Performance Benchmark Summary",
    "",
    `Started: ${summary.startedAt}`,
    `Finished: ${summary.finishedAt}`,
    `Scale: ${summary.scale}`,
    `Node: ${summary.nodeVersion} (${summary.platform}/${summary.arch})`,
    `Total duration: ${formatMs(summary.totalDurationMs)}`,
    `Cases: ${summary.totalCases}`,
    `Operations: ${summary.totalOperations}`,
    `Warnings: ${summary.totalWarnings}`,
    "",
    "## Case Overview",
    "",
    "| Case | Operations | Duration | Warnings | Why it matters |",
    "|------|------------|----------|----------|----------------|",
    ...summary.cases.map((entry) => [
      entry.caseId,
      String(entry.operations.length),
      formatMs(entry.durationMs),
      String(entry.warnings.length),
      entry.whyItMatters.replace(/\|/g, "\\|"),
    ].join(" | ")).map((row) => `| ${row} |`),
    "",
    "## Operation Results",
    "",
    "| Case | Operation | Items | p50 | p95 | p99 | Mean | Ops/sec | Heap Delta | Warning |",
    "|------|-----------|-------|-----|-----|-----|------|---------|------------|---------|",
  ];

  for (const benchmarkCase of summary.cases) {
    for (const operation of benchmarkCase.operations) {
      lines.push(`| ${benchmarkCase.caseId} | ${operation.operation} | ${operation.totalItems} ${operation.itemLabel} | ${formatMs(operation.duration.p50Ms)} | ${formatMs(operation.duration.p95Ms)} | ${formatMs(operation.duration.p99Ms)} | ${formatMs(operation.duration.meanMs)} | ${operation.opsPerSecond} | ${formatBytes(operation.heapDeltaBytes)} | ${operation.warning ?? ""} |`);
    }
  }

  lines.push(
    "",
    "## Reading The Report",
    "",
    "Use p95 and p99 to spot tail latency. Use fixture size with ops/sec to compare algorithmic scaling across smoke, standard, and stress runs. Warnings are intentionally soft until stable baselines exist.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function formatMs(value: number): string {
  return `${round(value, 2)}ms`;
}

function formatBytes(value: number): string {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute < 1024) {
    return `${value} B`;
  }
  if (absolute < 1024 * 1024) {
    return `${sign}${round(absolute / 1024, 2)} KiB`;
  }
  return `${sign}${round(absolute / (1024 * 1024), 2)} MiB`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
  return address.port;
}

function parseArgs(argv: string[]): RuntimeBenchmarkOptions & { list: boolean } {
  const options: RuntimeBenchmarkOptions & { list: boolean } = {
    scale: "standard",
    list: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      continue;
    }
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    if (arg === "--scale") {
      options.scale = parseScale(argv[++index]);
      continue;
    }
    if (arg.startsWith("--scale=")) {
      options.scale = parseScale(arg.slice("--scale=".length));
      continue;
    }
    if (arg === "--case") {
      options.caseId = parseCaseId(argv[++index]);
      continue;
    }
    if (arg.startsWith("--case=")) {
      options.caseId = parseCaseId(arg.slice("--case=".length));
      continue;
    }
    if (arg === "--output") {
      options.outputRoot = argv[++index];
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.outputRoot = arg.slice("--output=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parseScale(value: string | undefined): RuntimeScale {
  if (value === "smoke" || value === "standard" || value === "stress") {
    return value;
  }
  throw new Error(`Invalid scale "${String(value)}". Expected smoke, standard, or stress.`);
}

function parseCaseId(value: string | undefined): RuntimeBenchmarkCaseId {
  const ids = new Set(CASES.map((entry) => entry.caseId));
  if (value && ids.has(value as RuntimeBenchmarkCaseId)) {
    return value as RuntimeBenchmarkCaseId;
  }
  throw new Error(`Invalid case "${String(value)}". Run with --list to see cases.`);
}

function printCaseList(): void {
  for (const entry of CASES) {
    console.log(`${entry.caseId}\t${entry.title}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    printCaseList();
    return;
  }

  const summary = await runRuntimePerformanceBenchmarks(options);
  console.log(`Runtime performance benchmark: ${summary.totalOperations} operation(s), ${summary.totalWarnings} warning(s)`);
  console.log(`Summary: ${join(summary.outputRoot, "runtime-performance-summary.md")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
