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
  const harness = context.harness;
  const run = context.run;
  return {
    fingerprint: fingerprintPayload(stateView),
    contextKeys: Object.keys(context),
    temporal: {
      count: context.temporal.recent.length,
      currentCount: context.temporal.recent.filter((event) => "current" in event && event.current === true).length,
      hasCheckpoint: Boolean(context.temporal.checkpoint),
      latestUserPreview: previewString(
        [...context.temporal.recent].reverse().find((event) => event.kind === "user" && "content" in event)?.content,
        180,
      ),
    },
    stream: {
      agentId: context.stream.agentId,
      scopeKey: context.stream.scopeKey,
      recentWorkCount: context.stream.recentWork.length,
      routingStatus: context.current.routing?.status,
    },
    work: context.work.active ? {
      workstreamId: context.work.active.workstreamId,
      title: context.work.active.title,
      status: context.work.active.workstreamStatus,
      blockerCount: context.work.active.blockers.length,
      candidateCount: context.work.candidates.length,
    } : { candidateCount: context.work.candidates.length },
    resources: {
      streamCount: context.resources.stream.length,
      ingressCount: context.resources.ingress.length,
      activeWorkstreamCount: context.resources.activeWorkstream.length,
    },
    observations: {
      inventory: context.observations.inventory.length,
      discovery: context.observations.discovery.length,
      evidence: context.observations.evidence.length,
    },
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
      workStatus: run.workState?.status,
      toolCallCount: readArray(run.toolCalls).length,
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
    unavailable: result.unavailable,
    taxonomy: {
      loaded: summarizeToolTaxonomy(result.loaded),
      alreadyActive: summarizeToolTaxonomy(result.alreadyActive),
      evicted: summarizeToolTaxonomy(result.evicted),
      missing: summarizeToolTaxonomy(result.missing),
      unavailable: summarizeToolTaxonomy(result.unavailable.map((entry) => entry.tool)),
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
  if (decision.kind === "workstream_completion") {
    return {
      kind: "workstream_completion",
      summaryPreview: previewString(decision.request.summary, 240),
      resourceCount: decision.request.resources.length,
    };
  }
  if (decision.kind === "resolve_workstream") {
    return {
      kind: "resolve_workstream",
      purposePreview: previewString(decision.request.purpose, 240),
      hintCount: decision.request.hints.length,
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
    artifactCount: workState.artifacts?.length ?? 0,
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
  return {
    streamId: context.agentStream.meta.streamId,
    exactMessageCount: context.agentStream.recentMessages.length,
    hasCheckpoint: Boolean(context.agentStream.checkpoint),
    recentWorkCount: context.agentStream.recentWork.length,
    resourceCount: context.agentStream.meta.resourceCount,
    routingStatus: context.current.routing?.status,
    currentSequence: context.current.inputSeq,
    contextRevisions: {
      context: context.contextRevision,
      stream: context.streamRevision,
      run: context.runRevision,
      observations: context.observationRevision,
    },
    focusStatus: context.focus.status,
    activeWorkstreamId: context.focus.status === "active" ? context.focus.workstreamId : undefined,
    workstream: context.workstream ? {
      workstreamId: context.workstream.workstreamId,
      title: context.workstream.title,
      status: context.workstream.workstreamStatus,
      blockerCount: context.workstream.blockers.length,
      resourceCount: context.workstream.resources.length,
    } : undefined,
    observationCounts: {
      inventory: context.observations.inventory.length,
      discovery: context.observations.discovery.length,
      evidence: context.observations.evidence.length,
    },
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
