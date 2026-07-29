import type { LlmMessage, LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import { estimateTextTokens, estimateTurnInputTokens } from "../../prompt/token-estimator.js";
import type { AgentPromptStateView } from "../agent-runner/prompt-context.js";
import {
  CONTEXT_PREPARATION_POLICY_VERSION,
  type ContextLane,
  type ContextRetention,
  type PromptContextManifest,
  type PromptContextPart,
} from "./types.js";

export function buildPromptContextManifest(input: {
  stateView: AgentPromptStateView;
  turnInput: LlmTurnInput;
}): PromptContextManifest {
  const parts: PromptContextPart[] = [];
  const context = input.stateView.context;

  addSystemMessages(parts, input.turnInput.messages);
  addPart(parts, "system.tool_schemas", "system", "exact", input.turnInput.tools ?? [], []);
  addCoreCapsuleParts(parts, context.core);
  addPart(
    parts,
    "session.hot.available",
    "session",
    "referenceable",
    {
      available: context.hot.available,
      budget: context.hot.budget,
    },
    context.hot.available.flatMap((entry) => entry.sourceRefs),
  );
  if (context.hot.loaded.length > 0) {
    addPart(
      parts,
      "session.hot.loaded",
      "session",
      "hot",
      context.hot.loaded,
      context.hot.loaded.flatMap((entry) => entry.sourceRefs),
    );
  }
  if (context.tools) addPart(parts, "work.tool_state", "work", "exact", context.tools, []);
  if (context.harness) addPart(parts, "work.harness", "work", "hot", context.harness, []);
  if (context.run?.boundWorkstream) {
    addPart(
      parts,
      "work.run.bound_workstream",
      "work",
      "exact",
      context.run.boundWorkstream,
      boundWorkstreamRefs(context.run.boundWorkstream),
    );
  }
  if (context.run?.workState) {
    addPart(parts, "work.run.work_state", "work", "exact", context.run.workState, workStateRefs(context.run.workState));
  }
  if (context.run?.toolCalls) {
    addPart(parts, "work.run.tool_calls", "work", "hot", context.run.toolCalls, toolCallRefs(context.run.toolCalls));
  }
  if (context.run?.verifiedOutcomes) {
    addPart(
      parts,
      "work.run.verified_outcomes",
      "work",
      "exact",
      context.run.verifiedOutcomes,
      verifiedOutcomeRefs(context.run.verifiedOutcomes),
    );
  }
  if (context.run?.focus) {
    addPart(parts, "work.run.focus", "work", "summarizable", context.run.focus, focusRefs(context.run.focus));
  }
  if (context.run?.contextPressure) {
    addPart(parts, "work.run.context_pressure", "work", "hot", context.run.contextPressure, []);
  }
  if (input.stateView.attachments) {
    addPart(parts, "work.attachments", "work", "exact", input.stateView.attachments, []);
  }
  addRepairMessages(parts, input.turnInput.messages);

  const estimate = estimateTurnInputTokens(input.turnInput);
  const laneEstimates: Record<ContextLane, number> = { system: 0, session: 0, work: 0 };
  for (const part of parts) laneEstimates[part.lane] += part.localEstimatedTokens;

  return {
    policyVersion: CONTEXT_PREPARATION_POLICY_VERSION,
    parts,
    laneEstimates,
    toolSchemaTokens: estimate.toolSchemaTokens,
    totalLocalEstimate: estimate.totalTokens,
  };
}

function addSystemMessages(parts: PromptContextPart[], messages: LlmMessage[]): void {
  for (const [index, message] of messages.entries()) {
    if (message.role !== "system") continue;
    addPart(parts, `system.message.${index}`, "system", "exact", message.content, []);
  }
}

function addRepairMessages(parts: PromptContextPart[], messages: LlmMessage[]): void {
  const firstUserIndex = messages.findIndex((message) => message.role === "user");
  if (firstUserIndex < 0) return;
  for (let index = firstUserIndex + 1; index < messages.length; index++) {
    const message = messages[index];
    if (!message) continue;
    addPart(parts, `work.repair_message.${index}`, "work", "hot", message, []);
  }
}

function addPart(
  parts: PromptContextPart[],
  id: string,
  lane: ContextLane,
  retention: ContextRetention,
  content: unknown,
  sourceRefs: string[],
): void {
  parts.push({
    id,
    lane,
    retention,
    content,
    sourceRefs: [...new Set(sourceRefs)].sort(),
    localEstimatedTokens: estimateTextTokens(JSON.stringify(content)),
  });
}

function addCoreCapsuleParts(
  parts: PromptContextPart[],
  core: AgentPromptStateView["context"]["core"],
): void {
  addPart(
    parts,
    "session.core.metadata",
    "session",
    "referenceable",
    {
      schemaVersion: core.schemaVersion,
      revision: core.revision,
      maintenanceRequired: core.continuity.maintenanceRequired,
      budget: core.budget,
    },
    [],
  );
  addPart(
    parts,
    "work.core.current",
    "work",
    "exact",
    core.current,
    currentRefs(core.current),
  );
  if (core.continuity.checkpoint) {
    addPart(
      parts,
      "session.core.checkpoint",
      "session",
      "referenceable",
      core.continuity.checkpoint,
      core.continuity.checkpoint.exactAnchors.map((seq) => `seq:${seq}`),
    );
  }
  for (const event of core.continuity.recentExact) {
    addPart(
      parts,
      `session.core.seq.${event.seq}`,
      "session",
      "summarizable",
      event,
      [`seq:${event.seq}`],
    );
  }
  if (core.continuity.unloadedRanges.length > 0) {
    addPart(
      parts,
      "session.core.unloaded_ranges",
      "session",
      "referenceable",
      core.continuity.unloadedRanges,
      core.continuity.unloadedRanges.map((range) => range.sourceRef),
    );
  }
}

function currentRefs(current: AgentPromptStateView["context"]["core"]["current"]): string[] {
  return [
    `seq:${current.input.seq}`,
    `run:${current.runId}`,
    ...(current.routing?.workstreamId ? [`workstream:${current.routing.workstreamId}`] : []),
    ...(current.routing?.requestId ? [`request:${current.routing.requestId}`] : []),
    ...(current.activeDocuments ?? []).map((document) => document.evidenceRef),
  ];
}

function workStateRefs(
  workState: NonNullable<NonNullable<AgentPromptStateView["context"]["run"]>["workState"]>,
): string[] {
  return workState.importantContext?.flatMap((item) => [
    ...(item.ref ? [item.ref] : []),
    ...(item.kind === "artifact" && !item.ref
      ? [`artifact:${item.value}`]
      : []),
  ]) ?? [];
}

function boundWorkstreamRefs(
  workstream: NonNullable<
    NonNullable<AgentPromptStateView["context"]["run"]>["boundWorkstream"]
  >,
): string[] {
  return [
    `workstream:${workstream.id}`,
    `request:${workstream.request.id}`,
    ...(workstream.activeRequest
      ? [`request:${workstream.activeRequest.id}`]
      : []),
    ...workstream.recentProgress.map((progress) => `run:${progress.runId}`),
  ];
}

function toolCallRefs(
  calls: NonNullable<NonNullable<AgentPromptStateView["context"]["run"]>["toolCalls"]>,
): string[] {
  return [
    ...calls.flatMap((call) => [
      `step:${call.step}`,
      ...(call.callId ? [`call:${call.callId}`] : []),
      ...(call.evidenceRef ? [call.evidenceRef] : []),
      ...(call.artifacts ?? []).map((artifact) => `artifact:${JSON.stringify(artifact)}`),
    ]),
  ];
}

function verifiedOutcomeRefs(
  outcomes: NonNullable<NonNullable<AgentPromptStateView["context"]["run"]>["verifiedOutcomes"]>,
): string[] {
  return outcomes.flatMap((outcome) => [
    `step:${outcome.source.step}`,
    ...(outcome.source.callId ? [`call:${outcome.source.callId}`] : []),
  ]);
}

function focusRefs(
  focus: NonNullable<NonNullable<AgentPromptStateView["context"]["run"]>["focus"]>,
): string[] {
  return [
    ...focus.references,
    ...focus.constraints.flatMap((statement) => statement.refs),
    ...focus.decisions.flatMap((statement) => statement.refs),
    ...focus.completedWork.flatMap((statement) => statement.refs),
    ...focus.importantFindings.flatMap((statement) => statement.refs),
    ...focus.artifacts.flatMap((statement) => statement.refs),
    ...focus.unresolvedQuestions.flatMap((statement) => statement.refs),
  ];
}
