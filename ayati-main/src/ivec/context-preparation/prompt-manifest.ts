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
  addTemporalParts(parts, context.temporal);
  addPart(parts, "session.stream", "session", "referenceable", context.stream, workstreamRefs(context.stream.recentWork));
  if (context.personal) {
    addPart(parts, "session.personal", "session", "summarizable", context.personal, []);
  }
  addPart(parts, "work.current", "work", "exact", context.current, currentRefs(context.current));
  addPart(parts, "work.candidates", "work", "referenceable", context.work.candidates, candidateRefs(context.work.candidates));
  if (context.work.active) {
    addPart(parts, "work.active", "work", "exact", context.work.active, activeWorkRefs(context.work.active));
  }
  addPart(parts, "work.resources", "work", "exact", context.resources, resourceRefs(context.resources));
  addPart(parts, "work.observations", "work", "referenceable", context.observations, observationRefs(context.observations));
  if (context.tools) addPart(parts, "work.tool_state", "work", "exact", context.tools, []);
  if (context.harness) addPart(parts, "work.harness", "work", "hot", context.harness, []);
  if (context.run?.workState) {
    addPart(parts, "work.run.work_state", "work", "exact", context.run.workState, workStateRefs(context.run.workState));
  }
  if (context.run?.toolCalls) {
    addPart(parts, "work.run.tool_calls", "work", "hot", context.run.toolCalls, toolCallRefs(context.run.toolCalls));
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

function addTemporalParts(
  parts: PromptContextPart[],
  temporal: AgentPromptStateView["context"]["temporal"],
): void {
  if (temporal.checkpoint) {
    addPart(
      parts,
      "session.temporal.checkpoint",
      "session",
      "referenceable",
      temporal.checkpoint,
      temporal.checkpoint.exactAnchors.map((seq) => `seq:${seq}`),
    );
  }
  for (const event of temporal.recent) {
    addPart(
      parts,
      `session.temporal.seq.${event.seq}`,
      "session",
      event.current ? "exact" : "summarizable",
      event,
      [`seq:${event.seq}`],
    );
  }
}

function currentRefs(current: AgentPromptStateView["context"]["current"]): string[] {
  return [
    `seq:${current.inputSeq}`,
    `run:${current.runId}`,
    ...(current.routing?.workstreamId ? [`workstream:${current.routing.workstreamId}`] : []),
    ...(current.routing?.requestId ? [`request:${current.routing.requestId}`] : []),
  ];
}

function candidateRefs(
  candidates: AgentPromptStateView["context"]["work"]["candidates"],
): string[] {
  return candidates.flatMap((candidate) => {
    const record = candidate as unknown as Record<string, unknown>;
    return typeof record["workstreamId"] === "string"
      ? [`workstream:${record["workstreamId"]}`]
      : [];
  });
}

function activeWorkRefs(
  active: NonNullable<AgentPromptStateView["context"]["work"]["active"]>,
): string[] {
  return [
    `workstream:${active.workstreamId}`,
    ...(active.currentRequest?.id ? [`request:${active.currentRequest.id}`] : []),
  ];
}

function workstreamRefs(values: unknown[]): string[] {
  return values.flatMap((value) => {
    const record = asRecord(value);
    return typeof record?.["workstreamId"] === "string"
      ? [`workstream:${record["workstreamId"]}`]
      : [];
  });
}

function resourceRefs(resources: AgentPromptStateView["context"]["resources"]): string[] {
  return [resources.stream, resources.ingress, resources.activeWorkstream]
    .flat()
    .flatMap((value) => {
      const record = asRecord(value);
      const nested = asRecord(record?.["resource"]);
      const id = record?.["resourceId"] ?? nested?.["resourceId"];
      return typeof id === "string" ? [`resource:${id}`] : [];
    });
}

function observationRefs(observations: AgentPromptStateView["context"]["observations"]): string[] {
  return [observations.inventory, observations.discovery, observations.evidence]
    .flat()
    .flatMap((value) => {
      const record = asRecord(value);
      return [
        typeof record?.["observationId"] === "string" ? `observation:${record["observationId"]}` : undefined,
        typeof record?.["evidenceRef"] === "string" ? record["evidenceRef"] : undefined,
      ].filter((item): item is string => Boolean(item));
    });
}

function workStateRefs(
  workState: NonNullable<NonNullable<AgentPromptStateView["context"]["run"]>["workState"]>,
): string[] {
  return [
    ...(workState.evidence ?? []),
    ...(workState.artifacts ?? []).map((artifact) => `artifact:${artifact}`),
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
