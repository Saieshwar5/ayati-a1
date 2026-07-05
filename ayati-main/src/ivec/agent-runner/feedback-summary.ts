import { createHash } from "node:crypto";
import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import type { ToolDefinition } from "../../skills/types.js";
import { summarizeToolTaxonomy } from "../../skills/tool-taxonomy.js";
import type { HarnessContext, HarnessContextInput } from "../harness-context.js";
import type { StepSummary, VerifyOutput, WorkState } from "../types.js";
import type { AgentDecision, AgentAction } from "./decision.js";
import type { AgentPromptStateView } from "./prompt-context.js";
import type { ToolLoadResult } from "./tool-working-set.js";

export interface FeedbackPayloadFingerprint {
  jsonChars: number;
  sha256: string;
}

export function summarizeHarnessContext(
  context: HarnessContext | HarnessContextInput | undefined,
): Record<string, unknown> {
  const contextEngine = context?.contextEngine;
  return {
    fingerprint: fingerprintPayload(context ?? {}),
    personalMemoryChars: context?.personalMemorySnapshot?.length ?? 0,
    contextEngine: summarizeContextEngine(contextEngine),
  };
}

export function summarizePromptStateView(
  stateView: AgentPromptStateView,
): Record<string, unknown> {
  const context = stateView.context;
  const gitCurrent = context.git?.current;
  const harness = context.harness;
  const run = context.run;
  return {
    fingerprint: fingerprintPayload(stateView),
    contextKeys: Object.keys(context),
    timeline: {
      count: context.timeline.length,
      currentCount: context.timeline.filter((event) => "current" in event && event.current === true).length,
      latestUserPreview: previewString(
        [...context.timeline].reverse().find((event) => event.kind === "user" && "content" in event)?.content,
        180,
      ),
    },
    git: context.git ? {
      sessionId: context.git.session.meta.sessionId,
      sessionSummaryChars: context.git.session.summary?.text.length ?? 0,
      sessionActivityCount: context.git.session.activity.recent.length,
      pendingTurnStatus: gitCurrent?.pendingTurn?.routingStatus,
      pendingTurnRange: gitCurrent?.pendingTurn ? {
        fromSeq: gitCurrent.pendingTurn.fromSeq,
        toSeq: gitCurrent.pendingTurn.toSeq,
      } : undefined,
      focusStatus: gitCurrent?.focus.status,
      activeWorkId: gitCurrent?.focus.status === "active" ? gitCurrent.focus.workId : undefined,
      task: gitCurrent?.task ? {
        workId: gitCurrent.task.identity.workId,
        title: gitCurrent.task.identity.title,
        status: gitCurrent.task.state.status,
        openCount: gitCurrent.task.state.open.length,
        blockerCount: gitCurrent.task.state.blockers.length,
        factCount: gitCurrent.task.state.facts.length,
        recentRunCount: gitCurrent.task.activity.recentRuns.length,
        recentEvidenceCount: gitCurrent.task.activity.recentEvidence.length,
        assetCount: gitCurrent.task.assets.length,
      } : undefined,
    } : undefined,
    tools: context.tools ? {
      activeCount: context.tools.active.length,
      active: context.tools.active,
      lastLoadStatus: readRecord(context.tools.lastLoad)?.["status"],
    } : undefined,
    harness: harness ? {
      feedbackCount: readArray(readRecord(harness.feedback)?.["latest"]).length,
    } : undefined,
    run: run ? {
      keys: Object.keys(run),
      status: run.status,
      toolCallCount: readArray(readRecord(run.toolCalls)?.["latest"]).length,
    } : undefined,
    personal: context.personal ? {
      memoryChars: context.personal.memorySnapshot.length,
    } : undefined,
  };
}

export function summarizeToolDefinitions(tools: ToolDefinition[]): Record<string, unknown> {
  const names = tools.map((tool) => tool.name);
  return {
    count: tools.length,
    names,
    taxonomy: summarizeToolTaxonomy(names),
    schemas: tools.map((tool) => ({
      name: tool.name,
      requiredFields: readSchemaRequiredFields(tool.inputSchema),
      hasInputSchema: Boolean(tool.inputSchema),
    })),
  };
}

export function summarizeToolLoadResult(result: ToolLoadResult | undefined): Record<string, unknown> | undefined {
  if (!result) {
    return undefined;
  }
  return {
    status: result.status,
    requested: result.requested,
    loaded: result.loaded,
    alreadyActive: result.alreadyActive,
    evicted: result.evicted,
    missing: result.missing,
    taxonomy: {
      loaded: summarizeToolTaxonomy(result.loaded),
      alreadyActive: summarizeToolTaxonomy(result.alreadyActive),
      evicted: summarizeToolTaxonomy(result.evicted),
      missing: summarizeToolTaxonomy(result.missing),
    },
    message: result.message,
  };
}

export function summarizeDecision(decision: AgentDecision): Record<string, unknown> {
  if (decision.kind === "reply") {
    return {
      kind: "reply",
      status: decision.status,
      messagePreview: previewString(decision.message, 240),
    };
  }
  if (decision.kind === "ask_user") {
    return {
      kind: "ask_user",
      questionPreview: previewString(decision.question, 240),
      reasonPreview: previewString(decision.reason, 240),
    };
  }
  if (decision.kind === "load_tools") {
    return {
      kind: "load_tools",
      request: decision.request,
    };
  }
  return {
    kind: "act",
    action: summarizeAgentAction(decision.action),
  };
}

export function summarizeAgentAction(action: AgentAction): Record<string, unknown> {
  const tools = action.calls.map((call) => call.tool);
  return {
    mode: action.mode,
    allowedTools: action.allowedTools,
    callCount: action.calls.length,
    taxonomy: summarizeToolTaxonomy(tools),
    calls: action.calls.map((call) => ({
      id: call.id,
      tool: call.tool,
      dependsOn: call.dependsOn,
      purpose: call.purpose,
      input: summarizeToolInput(call.input),
    })),
    completionIntent: action.completion?.intent,
  };
}

export function summarizeWorkState(workState: WorkState): Record<string, unknown> {
  return {
    status: workState.status,
    summaryPreview: previewString(workState.summary, 240),
    openWorkCount: workState.openWork?.length ?? 0,
    blockerCount: workState.blockers?.length ?? 0,
    verifiedFactCount: workState.verifiedFacts.length,
    evidenceCount: workState.evidence.length,
    evidenceRefCount: workState.evidenceRefs?.length ?? 0,
    taskNoteCount: workState.taskNotes?.length ?? 0,
    nextStepPreview: previewString(workState.nextStep, 180),
    userInputNeededPreview: previewString(workState.userInputNeeded, 180),
  };
}

export function summarizeVerification(output: VerifyOutput): Record<string, unknown> {
  return {
    passed: output.passed,
    method: output.method,
    executionStatus: output.executionStatus,
    validationStatus: output.validationStatus,
    summaryPreview: previewString(output.summary, 300),
    evidenceItemCount: output.evidenceItems.length,
    newFactCount: output.newFacts.length,
    artifactCount: output.artifacts.length,
    usedRawArtifactCount: output.usedRawArtifacts.length,
  };
}

export function summarizeStep(step: StepSummary): Record<string, unknown> {
  return {
    step: step.step,
    outcome: step.outcome,
    summaryPreview: previewString(step.summary, 300),
    executionContract: step.executionContract,
    toolSuccessCount: step.toolSuccessCount,
    toolFailureCount: step.toolFailureCount,
    verificationMethod: step.verificationMethod,
    executionStatus: step.executionStatus,
    validationStatus: step.validationStatus,
    newFactCount: step.newFacts.length,
    artifactCount: step.artifacts.length,
    stoppedEarlyReason: step.stoppedEarlyReason,
    failureType: step.failureType,
  };
}

export function summarizeContextEngine(
  context: ContextEngineMachineContext | undefined,
): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }
  const sessionMeta = readContextSessionMeta(context.session);
  return {
    sessionId: sessionMeta.sessionId,
    conversationTailCount: context.session.conversationTail.length,
    conversationMarkdownChars: context.session.conversationMarkdownTail?.length ?? 0,
    sessionSummaryChars: context.session.summary?.text.length ?? 0,
    activityCount: context.session.activityTail.length,
    recentCommitCount: context.session.recentCommits?.length ?? 0,
    assetCount: sessionMeta.assetCount,
    pendingWriteCount: context.pendingWrites?.length ?? 0,
    pendingTurnStatus: context.pendingTurn?.routingStatus,
    pendingTurnRange: context.pendingTurn ? {
      fromSeq: context.pendingTurn.fromSeq,
      toSeq: context.pendingTurn.toSeq,
    } : undefined,
    focusStatus: context.focus.status,
    activeWorkId: context.focus.status === "active" ? context.focus.workId : undefined,
    task: context.task ? {
      workId: context.task.workId,
      title: context.task.title,
      status: context.task.status,
      openCount: context.task.open.length,
      blockerCount: context.task.blockers.length,
      factCount: context.task.facts.length,
      recentRunCount: context.task.recentRuns.length,
      recentEvidenceCount: context.task.recentEvidence.length,
      assetCount: context.task.assets.length,
    } : undefined,
  };
}

function readContextSessionMeta(
  session: ContextEngineMachineContext["session"],
): ContextEngineMachineContext["session"]["meta"] {
  if (session.meta) {
    return session.meta;
  }
  const legacy = session as unknown as { sessionId?: string; assetCount?: number };
  return {
    sessionId: legacy.sessionId ?? "unknown",
    assetCount: legacy.assetCount ?? session.attachments?.count ?? 0,
  };
}

export function fingerprintPayload(value: unknown): FeedbackPayloadFingerprint {
  const json = JSON.stringify(value);
  return {
    jsonChars: json.length,
    sha256: createHash("sha256").update(json).digest("hex").slice(0, 16),
  };
}

export function summarizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
  return {
    keys: Object.keys(input),
    empty: Object.keys(input).length === 0,
    fingerprint: fingerprintPayload(input),
  };
}

function readSchemaRequiredFields(schema: Record<string, unknown> | undefined): string[] {
  const required = schema?.["required"];
  return Array.isArray(required) ? required.filter((field): field is string => typeof field === "string") : [];
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function previewString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return value.length <= maxChars ? value : `${value.slice(0, maxChars).trimEnd()}...[truncated ${value.length - maxChars} chars]`;
}
