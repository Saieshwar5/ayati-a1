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
  const goal = normalizeOptionalText(input.objective) ?? normalizeOptionalText(state?.goal?.objective);
  const completedSteps = [...(state?.completedSteps ?? [])];
  const latestSuccessful = normalizeOptionalText(
    [...completedSteps].reverse().find((step) => step.outcome === "success")?.summary,
  );
  const recentSteps = completedSteps.slice(-2);
  const recentStepLines = recentSteps
    .map((step) => normalizeOptionalText(step.summary))
    .filter((value): value is string => Boolean(value))
    .map((value, index) => `Recent step ${index + 1}: ${value}`);
  const facts = uniqueStrings([
    ...(input.keyFacts ?? []),
    ...recentSteps.flatMap((step) => step.newFacts ?? []),
  ]).slice(0, 6);
  const evidence = uniqueStrings(input.evidence ?? []).slice(0, 6);
  const openWork = uniqueStrings(input.openWork ?? []).slice(0, 4);
  const blockers = uniqueStrings(input.blockers ?? []).slice(0, 4);
  const artifacts = uniqueStrings(recentSteps.flatMap((step) => step.artifacts ?? [])).slice(0, 4);
  const completedMilestones = uniqueStrings(input.completedMilestones ?? []).slice(0, 4);
  const attachmentNames = uniqueStrings(input.attachmentNames ?? []).slice(0, 4);
  const userMessage = normalizeOptionalText(input.userMessage);
  const assistantResponse = normalizeOptionalText(input.assistantResponse ?? input.summary);
  const progressSummary = normalizeOptionalText(input.progressSummary);
  const currentFocus = normalizeOptionalText(input.currentFocus);
  const userInputNeeded = normalizeOptionalText(input.userInputNeeded);
  const taskStatus = normalizeOptionalText(input.taskStatus);
  const approach = normalizeOptionalText(input.approach) ?? normalizeOptionalText(state?.approach);
  const sessionContextSummary = normalizeOptionalText(input.sessionContextSummary);
  const dependentTaskRunId = normalizeOptionalText(input.dependentTaskRunId);
  const assistantResponseKind = normalizeOptionalText(input.assistantResponseKind);
  const feedbackKind = normalizeOptionalText(input.feedbackKind);
  const feedbackLabel = normalizeOptionalText(input.feedbackLabel);
  const actionType = normalizeOptionalText(input.actionType);
  const nextAction = normalizeOptionalText(input.nextAction);
  const stopReason = normalizeOptionalText(input.stopReason);
  const workMode = normalizeOptionalText(input.workMode) ?? normalizeOptionalText(state?.workMode);
  const entityHints = uniqueStrings(input.entityHints ?? []).slice(0, 6);
  const goalDoneWhen = uniqueStrings(input.goalDoneWhen ?? []).slice(0, 4);
  const goalRequiredEvidence = uniqueStrings(input.goalRequiredEvidence ?? []).slice(0, 4);
  const summaryText = normalizeSummary(input.summary || progressSummary || assistantResponse || userMessage || goal || "");
  const retrievalText = truncateText([
    "Source: run memory",
    userMessage ? `User asked: ${userMessage}` : "",
    goal ? `Goal: ${goal}` : "",
    taskStatus ? `Task status: ${taskStatus}` : "",
    approach ? `Approach: ${approach}` : "",
    `Run status: ${input.status}`,
    assistantResponseKind ? `Assistant response kind: ${assistantResponseKind}` : "",
    feedbackKind ? `Feedback kind: ${feedbackKind}` : "",
    feedbackLabel ? `Feedback label: ${feedbackLabel}` : "",
    actionType ? `Action type: ${actionType}` : "",
    progressSummary ? `Progress summary: ${progressSummary}` : "",
    currentFocus ? `Current focus: ${currentFocus}` : "",
    sessionContextSummary ? `Session context summary: ${sessionContextSummary}` : "",
    dependentTaskRunId ? `Depends on run: ${dependentTaskRunId}` : "",
    completedMilestones.length > 0 ? `Completed milestones: ${completedMilestones.join(" | ")}` : "",
    openWork.length > 0 ? `Open work: ${openWork.join(" | ")}` : "",
    blockers.length > 0 ? `Blockers: ${blockers.join(" | ")}` : "",
    userInputNeeded ? `User input needed: ${userInputNeeded}` : "",
    nextAction ? `Next action: ${nextAction}` : "",
    stopReason ? `Stop reason: ${stopReason}` : "",
    assistantResponse ? `Assistant outcome: ${assistantResponse}` : "",
    latestSuccessful ? `Latest successful step: ${latestSuccessful}` : "",
    ...recentStepLines,
    facts.length > 0 ? `Key facts: ${facts.join(" | ")}` : "",
    evidence.length > 0 ? `Evidence: ${evidence.join(" | ")}` : "",
    entityHints.length > 0 ? `Entity hints: ${entityHints.join(" | ")}` : "",
    goalDoneWhen.length > 0 ? `Done when: ${goalDoneWhen.join(" | ")}` : "",
    goalRequiredEvidence.length > 0 ? `Required evidence: ${goalRequiredEvidence.join(" | ")}` : "",
    artifacts.length > 0 ? `Artifacts: ${artifacts.join(" | ")}` : "",
    attachmentNames.length > 0 ? `Attachments: ${attachmentNames.join(" | ")}` : "",
    workMode ? `Work mode: ${workMode}` : "",
  ].filter(Boolean).join("\n"), MAX_RETRIEVAL_CHARS);

  return {
    summaryText,
    retrievalText,
    metadataJson: JSON.stringify({
      goal,
      taskStatus,
      approach,
      progressSummary,
      currentFocus,
      sessionContextSummary,
      dependentTaskRunId,
      assistantResponseKind,
      feedbackKind,
      feedbackLabel,
      actionType,
      completedMilestones,
      openWork,
      blockers,
      evidence,
      userInputNeeded,
      nextAction,
      stopReason,
      latestSuccessful,
      facts,
      entityHints,
      goalDoneWhen,
      goalRequiredEvidence,
      artifacts,
      attachmentNames,
      workMode,
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
