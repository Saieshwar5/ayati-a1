import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GoalContract, LoopState, StepSummary } from "../../ivec/types.js";
import { devWarn } from "../../shared/index.js";
import { MemoryGraphStore } from "./memory-graph-store.js";
import type {
  HandoffSummaryMemoryInput,
  MemoryEdgeRecord,
  MemoryJobRecord,
  MemoryNodeRecord,
  RecallMemoryRecord,
  SummaryEmbeddingProvider,
  SummaryVectorStore,
  TaskSummaryMemoryInput,
} from "./types.js";

export interface MemoryIndexerOptions {
  embedder: SummaryEmbeddingProvider;
  store: SummaryVectorStore;
  graphStore: MemoryGraphStore;
}

interface RunDerivedMemory {
  summaryText: string;
  retrievalText: string;
  metadataJson: string;
}

interface RunStateSnapshot {
  goal?: GoalContract;
  approach?: string;
  workMode?: string;
  completedSteps?: StepSummary[];
  progressLedger?: {
    lastSuccessfulStepSummary?: string;
  };
}

const MAX_SUMMARY_CHARS = 700;
const MAX_RETRIEVAL_CHARS = 2_000;

export class MemoryIndexer {
  private readonly embedder: SummaryEmbeddingProvider;
  private readonly store: SummaryVectorStore;
  private readonly graphStore: MemoryGraphStore;
  private processingPromise: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(options: MemoryIndexerOptions) {
    this.embedder = options.embedder;
    this.store = options.store;
    this.graphStore = options.graphStore;
  }

  start(): void {
    this.graphStore.start();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    try {
      await this.processingPromise;
    } finally {
      this.graphStore.stop();
    }
  }

  async indexTaskSummary(input: TaskSummaryMemoryInput): Promise<void> {
    if (looksLikeRotationSummary(input.summary)) {
      return;
    }

    this.graphStore.enqueueJob("index_run", input.clientId, input, input.timestamp);
    this.scheduleProcessing();
  }

  async indexHandoffSummary(input: HandoffSummaryMemoryInput): Promise<void> {
    this.graphStore.enqueueJob("index_handoff", input.clientId, input, input.timestamp);
    this.scheduleProcessing();
  }

  private scheduleProcessing(): void {
    if (this.processingPromise) {
      return;
    }

    this.processingPromise = this.processJobs()
      .catch((err) => devWarn("Memory indexing worker failed:", err instanceof Error ? err.message : String(err)))
      .finally(() => {
        this.processingPromise = null;
        if (!this.shuttingDown && this.graphStore.hasPendingJobs()) {
          this.scheduleProcessing();
        }
      });
  }

  private async processJobs(): Promise<void> {
    while (true) {
      const job = this.graphStore.claimNextJob();
      if (!job) {
        return;
      }

      try {
        if (job.jobType === "index_handoff") {
          await this.processHandoffJob(job);
        } else {
          await this.processRunJob(job);
        }
        this.graphStore.markJobDone(job.jobId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.graphStore.markJobFailed(job.jobId, message);
      }
    }
  }

  private async processRunJob(job: MemoryJobRecord): Promise<void> {
    const input = JSON.parse(job.payloadJson) as TaskSummaryMemoryInput;
    const summaryText = normalizeSummary(input.summary || input.assistantResponse || input.userMessage || "");
    if (!summaryText) {
      return;
    }

    const sessionNodeId = this.graphStore.getSessionNodeId(input.sessionId);
    const nodeId = `run:${input.sessionId}:${input.runId}`;
    const sessionFilePath = this.graphStore.resolveSessionFilePath(input.sessionPath);
    const runStatePath = resolve(input.runPath, "state.json");
    const runState = loadRunState(runStatePath);
    const derived = buildRunDerivedMemory(input, runState);
    const embedding = await this.embedder.embed(derived.retrievalText);

    const sessionNode: MemoryNodeRecord = {
      nodeId: sessionNodeId,
      clientId: input.clientId,
      nodeType: "session",
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      sessionFilePath,
      createdAt: input.timestamp,
      summaryText: `Session ${input.sessionId}`,
      metadataJson: JSON.stringify({ sessionId: input.sessionId }),
    };

    const runNode: MemoryNodeRecord = {
      nodeId,
      clientId: input.clientId,
      nodeType: "run",
      sourceType: "run",
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      sessionFilePath,
      runId: input.runId,
      runPath: input.runPath,
      runStatePath,
      createdAt: input.timestamp,
      status: input.status,
      summaryText: derived.summaryText,
      retrievalText: derived.retrievalText,
      userMessage: normalizeOptionalText(input.userMessage),
      assistantResponse: normalizeOptionalText(input.assistantResponse ?? input.summary),
      metadataJson: derived.metadataJson,
    };

    this.graphStore.upsertNode(sessionNode);
    this.graphStore.upsertNode(runNode);

    const previousRun = this.graphStore.getLatestRunNode(input.sessionId, input.timestamp, nodeId);
    const edges: MemoryEdgeRecord[] = [
      edge(input.clientId, sessionNodeId, "session_contains_run", nodeId, input.timestamp),
    ];
    if (previousRun?.nodeId) {
      edges.push(edge(input.clientId, previousRun.nodeId, "run_followed_by_run", nodeId, input.timestamp));
    }
    this.graphStore.upsertEdges(edges);

    const record: RecallMemoryRecord = {
      id: nodeId,
      clientId: input.clientId,
      nodeType: "run",
      sourceType: "run",
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      sessionFilePath,
      runId: input.runId,
      runPath: input.runPath,
      runStatePath,
      createdAt: input.timestamp,
      status: input.status,
      summaryText: derived.summaryText,
      retrievalText: derived.retrievalText,
      userMessage: normalizeOptionalText(input.userMessage),
      assistantResponse: normalizeOptionalText(input.assistantResponse ?? input.summary),
      metadataJson: derived.metadataJson,
      embeddingModel: this.embedder.modelName,
      embedding,
    };

    await this.store.upsert(record);
  }

  private async processHandoffJob(job: MemoryJobRecord): Promise<void> {
    const input = JSON.parse(job.payloadJson) as HandoffSummaryMemoryInput;
    const summaryText = normalizeSummary(input.summary);
    if (!summaryText) {
      return;
    }

    const sessionNodeId = this.graphStore.getSessionNodeId(input.sessionId);
    const nextSessionNodeId = input.nextSessionId ? this.graphStore.getSessionNodeId(input.nextSessionId) : undefined;
    const nodeId = `handoff:${input.sessionId}:${input.timestamp}`;
    const sessionFilePath = this.graphStore.resolveSessionFilePath(input.sessionPath);
    const nextSessionFilePath = input.nextSessionPath
      ? this.graphStore.resolveSessionFilePath(input.nextSessionPath)
      : undefined;
    const retrievalText = truncateText([
      "Source: session handoff",
      `Handoff summary: ${summaryText}`,
      input.reason ? `Rotation reason: ${normalizeSummary(input.reason)}` : "",
      `Source session: ${input.sessionId}`,
      input.nextSessionId ? `Next session: ${input.nextSessionId}` : "",
    ].filter(Boolean).join("\n"), MAX_RETRIEVAL_CHARS);
    const metadataJson = JSON.stringify({
      reason: normalizeOptionalText(input.reason),
      nextSessionId: input.nextSessionId,
      nextSessionPath: input.nextSessionPath,
    });
    const embedding = await this.embedder.embed(retrievalText);

    this.graphStore.upsertNode({
      nodeId: sessionNodeId,
      clientId: input.clientId,
      nodeType: "session",
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      sessionFilePath,
      createdAt: input.timestamp,
      summaryText: `Session ${input.sessionId}`,
      metadataJson: JSON.stringify({ sessionId: input.sessionId }),
    });

    if (nextSessionNodeId && input.nextSessionId && input.nextSessionPath && nextSessionFilePath) {
      this.graphStore.upsertNode({
        nodeId: nextSessionNodeId,
        clientId: input.clientId,
        nodeType: "session",
        sessionId: input.nextSessionId,
        sessionPath: input.nextSessionPath,
        sessionFilePath: nextSessionFilePath,
        createdAt: input.timestamp,
        summaryText: `Session ${input.nextSessionId}`,
        metadataJson: JSON.stringify({ sessionId: input.nextSessionId }),
      });
    }

    this.graphStore.upsertNode({
      nodeId,
      clientId: input.clientId,
      nodeType: "handoff",
      sourceType: "handoff",
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      sessionFilePath,
      createdAt: input.timestamp,
      summaryText,
      retrievalText,
      metadataJson,
    });

    const edges: MemoryEdgeRecord[] = [
      edge(input.clientId, sessionNodeId, "session_has_handoff", nodeId, input.timestamp),
    ];
    if (nextSessionNodeId) {
      edges.push(edge(input.clientId, sessionNodeId, "session_rotates_to_session", nextSessionNodeId, input.timestamp));
      edges.push(edge(input.clientId, nodeId, "handoff_opens_session", nextSessionNodeId, input.timestamp));
    }

    const previousRun = this.graphStore.getLatestRunNode(input.sessionId, input.timestamp);
    if (previousRun?.nodeId) {
      edges.push(edge(input.clientId, previousRun.nodeId, "run_precedes_handoff", nodeId, input.timestamp));
    }
    this.graphStore.upsertEdges(edges);

    await this.store.upsert({
      id: nodeId,
      clientId: input.clientId,
      nodeType: "handoff",
      sourceType: "handoff",
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      sessionFilePath,
      createdAt: input.timestamp,
      summaryText,
      retrievalText,
      metadataJson,
      embeddingModel: this.embedder.modelName,
      embedding,
    });
  }
}

function buildRunDerivedMemory(input: TaskSummaryMemoryInput, state: RunStateSnapshot | null): RunDerivedMemory {
  const goal = normalizeOptionalText(state?.goal?.objective);
  const approach = normalizeOptionalText(state?.approach);
  const latestSuccessful = normalizeOptionalText(state?.progressLedger?.lastSuccessfulStepSummary);
  const recentSteps = [...(state?.completedSteps ?? [])].slice(-2);
  const recentStepLines = recentSteps
    .map((step) => normalizeOptionalText(step.summary))
    .filter((value): value is string => Boolean(value))
    .map((value, index) => `Recent step ${index + 1}: ${value}`);
  const facts = uniqueStrings(recentSteps.flatMap((step) => step.newFacts ?? [])).slice(0, 6);
  const artifacts = uniqueStrings(recentSteps.flatMap((step) => step.artifacts ?? [])).slice(0, 4);
  const userMessage = normalizeOptionalText(input.userMessage);
  const assistantResponse = normalizeOptionalText(input.assistantResponse ?? input.summary);
  const summaryText = normalizeSummary(input.summary || assistantResponse || userMessage || goal || "");
  const retrievalText = truncateText([
    "Source: run memory",
    userMessage ? `User asked: ${userMessage}` : "",
    goal ? `Goal: ${goal}` : "",
    approach ? `Approach: ${approach}` : "",
    `Run status: ${input.status}`,
    assistantResponse ? `Assistant outcome: ${assistantResponse}` : "",
    latestSuccessful ? `Latest successful step: ${latestSuccessful}` : "",
    ...recentStepLines,
    facts.length > 0 ? `Key facts: ${facts.join(" | ")}` : "",
    artifacts.length > 0 ? `Artifacts: ${artifacts.join(" | ")}` : "",
    state?.workMode ? `Work mode: ${state.workMode}` : "",
  ].filter(Boolean).join("\n"), MAX_RETRIEVAL_CHARS);

  return {
    summaryText,
    retrievalText,
    metadataJson: JSON.stringify({
      goal,
      approach,
      latestSuccessful,
      facts,
      artifacts,
      workMode: state?.workMode,
    }),
  };
}

function loadRunState(runStatePath: string): RunStateSnapshot | null {
  if (!existsSync(runStatePath)) {
    return null;
  }

  try {
    const raw = readFileSync(runStatePath, "utf8");
    return JSON.parse(raw) as RunStateSnapshot;
  } catch {
    return null;
  }
}

function edge(
  clientId: string,
  fromNodeId: string,
  edgeType: MemoryEdgeRecord["edgeType"],
  toNodeId: string,
  createdAt: string,
): MemoryEdgeRecord {
  return {
    edgeId: `${fromNodeId}:${edgeType}:${toNodeId}`,
    clientId,
    fromNodeId,
    edgeType,
    toNodeId,
    createdAt,
  };
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeOptionalText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeSummary(value: string): string {
  return truncateText(value.replace(/\s+/g, " ").trim(), MAX_SUMMARY_CHARS);
}

function normalizeOptionalText(value: string | undefined | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > 0 ? clean : undefined;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

function looksLikeRotationSummary(value: string): boolean {
  return /^session rotated:/i.test(value.trim());
}
