import type { AgentContextPack } from "./context-pack.js";
import type { PromptToolCalls } from "./run-tool-call-context.js";
import type { AgentStateView } from "./state-view.js";
import type { RunFocusSummary } from "../context-preparation/types.js";

export interface PromptPersonalContext {
  memorySnapshot: string;
}

export interface PromptRunContext {
  workState?: PromptRunWorkStateContext;
  toolCalls?: PromptToolCalls;
  /** Disposable run-scoped context. It is never verification or completion evidence. */
  focus?: RunFocusSummary;
  contextPressure?: {
    mode: "tool_compact" | "stream_project" | "stream_checkpoint" | "step_ledger";
    recommendedMode?: "stream_project" | "stream_checkpoint" | "step_ledger";
    escalationReason?: "near_admission_limit" | "repeated_unresolved_pressure";
    unresolvedPressureStreak: number;
    compactedCalls: number;
    targetReached?: boolean;
    recoverable: true;
  };
}

export interface PromptRunWorkStateContext {
  status: import("../types.js").WorkState["status"];
  summary?: string;
  openWork?: string[];
  blockers?: string[];
  verifiedFacts?: string[];
  evidence?: string[];
  artifacts?: string[];
  nextStep?: string;
  userInputNeeded?: string;
}

export interface PromptHarnessContext {
  feedback?: unknown;
}

export interface PromptToolsContext {
  active: string[];
  lastLoad?: unknown;
}

type PromptCheckpoint = Pick<
  NonNullable<AgentContextPack["temporal"]["checkpoint"]>,
  "coveredFromSeq" | "coveredToSeq" | "summary" | "exactAnchors" | "createdAt"
>;

export interface AgentPromptContext {
  temporal: {
    checkpoint?: PromptCheckpoint;
    recent: AgentContextPack["temporal"]["recent"];
  };
  current: AgentContextPack["current"];
  stream: AgentContextPack["stream"];
  work: AgentContextPack["work"];
  resources: AgentContextPack["resources"];
  observations: AgentContextPack["observations"];
  personal?: PromptPersonalContext;
  tools?: PromptToolsContext;
  harness?: PromptHarnessContext;
  run?: PromptRunContext;
}

export interface ProjectAgentPromptContextInput {
  context: AgentContextPack;
  tools?: PromptToolsContext;
  harness?: PromptHarnessContext;
  run?: PromptRunContext;
}

export interface AgentPromptStateView {
  context: AgentPromptContext;
  attachments?: AgentStateView["attachments"];
}

export function projectAgentPromptContext(input: ProjectAgentPromptContextInput): AgentPromptContext {
  const {
    personalMemorySnapshot,
    temporal,
    observations,
    ...context
  } = input.context;
  const memorySnapshot = personalMemorySnapshot?.trim();
  const harness = compactHarnessContext(input.harness);
  const run = compactRunContext(input.run, { preserveProjectionMetadata: true });
  return {
    ...context,
    temporal: {
      ...(temporal.checkpoint ? { checkpoint: checkpointForPrompt(temporal.checkpoint) } : {}),
      recent: temporal.recent,
    },
    observations: observationsForPrompt(observations),
    ...(memorySnapshot ? { personal: { memorySnapshot } } : {}),
    ...(input.tools ? { tools: input.tools } : {}),
    ...(harness ? { harness } : {}),
    ...(run ? { run } : {}),
  };
}

export function projectAgentStateViewForPrompt(stateView: AgentStateView): AgentPromptStateView {
  return {
    context: compactAgentPromptContext(stateView.context),
    ...(stateView.attachments ? { attachments: stateView.attachments } : {}),
  };
}

function checkpointForPrompt(
  checkpoint: NonNullable<AgentContextPack["temporal"]["checkpoint"]>,
): PromptCheckpoint {
  return {
    coveredFromSeq: checkpoint.coveredFromSeq,
    coveredToSeq: checkpoint.coveredToSeq,
    summary: checkpoint.summary,
    exactAnchors: checkpoint.exactAnchors,
    createdAt: checkpoint.createdAt,
  };
}

function observationsForPrompt(observations: AgentContextPack["observations"]): AgentContextPack["observations"] {
  return {
    revision: observations.revision,
    inventory: observations.inventory.map(stripObservationAuthority),
    discovery: observations.discovery.map(stripObservationAuthority),
    evidence: observations.evidence.map(stripObservationAuthority),
  } as AgentContextPack["observations"];
}

function stripObservationAuthority<Value extends object>(value: Value): Value {
  const {
    streamId: _streamId,
    sourceRunId: _sourceRunId,
    ...promptValue
  } = value as Value & { streamId?: unknown; sourceRunId?: unknown };
  return promptValue as Value;
}

function compactAgentPromptContext(context: AgentPromptContext): AgentPromptContext {
  const run = compactRunContext(context.run);
  return {
    temporal: context.temporal,
    current: context.current,
    stream: context.stream,
    work: context.work,
    resources: context.resources,
    observations: context.observations,
    ...(context.tools ? { tools: context.tools } : {}),
    ...(context.harness ? { harness: context.harness } : {}),
    ...(run ? { run } : {}),
    ...(context.personal ? { personal: context.personal } : {}),
  };
}

function compactHarnessContext(harness: PromptHarnessContext | undefined): PromptHarnessContext | undefined {
  if (!harness) return undefined;
  const compacted: PromptHarnessContext = {
    ...(harness.feedback ? { feedback: harness.feedback } : {}),
  };
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function compactRunContext(
  run: PromptRunContext | undefined,
  options: { preserveProjectionMetadata?: boolean } = {},
): PromptRunContext | undefined {
  if (!run) return undefined;
  const compacted: PromptRunContext = {
    ...(run.workState ? { workState: run.workState } : {}),
    ...(run.toolCalls ? {
      toolCalls: options.preserveProjectionMetadata
        ? run.toolCalls
        : run.toolCalls.map(({ projectionMetadata: _projectionMetadata, ...call }) => call),
    } : {}),
    ...(run.focus ? { focus: run.focus } : {}),
    ...(run.contextPressure ? { contextPressure: run.contextPressure } : {}),
  };
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}
