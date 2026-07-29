import type { AgentContextPack } from "./context-pack.js";
import type { PromptBoundWorkstreamContext } from "./bound-workstream-prompt-context.js";
import type { PromptToolCalls } from "./run-tool-call-context.js";
import type { PromptVerifiedOutcomes } from "./run-verified-outcome-context.js";
import type { AgentStateView } from "./state-view.js";
import type { RunFocusSummary } from "../context-preparation/types.js";
import type { VirtualModeCard } from "./virtual-mode.js";

export type { PromptBoundWorkstreamContext } from "./bound-workstream-prompt-context.js";

export interface PromptRunContext {
  /** Exact configured workspace location. This is navigation context, not mutation authority. */
  workspaceRoot?: string;
  mode?: VirtualModeCard;
  boundWorkstream?: PromptBoundWorkstreamContext;
  workState?: PromptRunWorkStateContext;
  toolCalls?: PromptToolCalls;
  verifiedOutcomes?: PromptVerifiedOutcomes;
  /** Disposable run-scoped context. It is never verification or completion evidence. */
  focus?: RunFocusSummary;
  contextPressure?: {
    mode: "tool_compact" | "stream_checkpoint" | "step_ledger";
    recommendedMode?: "stream_checkpoint" | "step_ledger";
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
  plan?: import("../types.js").WorkPlanItem[];
  importantContext?: import("../types.js").ImportantContextItem[];
  nextAction?: string;
}

export interface PromptHarnessContext {
  feedback?: unknown;
}

export interface PromptToolsContext {
  active: string[];
  lastSurface?: unknown;
}

export interface AgentPromptContext {
  core: AgentContextPack["core"];
  hot: AgentContextPack["hot"];
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
  const harness = compactHarnessContext(input.harness);
  const run = compactRunContext(input.run, { preserveProjectionMetadata: true });
  return {
    ...input.context,
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

function compactAgentPromptContext(context: AgentPromptContext): AgentPromptContext {
  const run = compactRunContext(context.run);
  return {
    core: context.core,
    hot: context.hot,
    ...(context.tools ? { tools: context.tools } : {}),
    ...(context.harness ? { harness: context.harness } : {}),
    ...(run ? { run } : {}),
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
    ...(run.workspaceRoot ? { workspaceRoot: run.workspaceRoot } : {}),
    ...(run.mode ? { mode: run.mode } : {}),
    ...(run.boundWorkstream ? { boundWorkstream: run.boundWorkstream } : {}),
    ...(run.workState ? { workState: run.workState } : {}),
    ...(run.toolCalls ? {
      toolCalls: options.preserveProjectionMetadata
        ? run.toolCalls
        : run.toolCalls.map(projectToolCallForModel),
    } : {}),
    ...(run.verifiedOutcomes ? { verifiedOutcomes: run.verifiedOutcomes } : {}),
    ...(run.focus ? { focus: run.focus } : {}),
    ...(run.contextPressure ? { contextPressure: run.contextPressure } : {}),
  };
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function projectToolCallForModel(
  call: PromptToolCalls[number],
): PromptToolCalls[number] {
  const {
    retention: _retention,
    projectionMetadata: _projectionMetadata,
    stepRef: _stepRef,
    recoverable: _recoverable,
    compactionReason: _compactionReason,
    ...modelCall
  } = call;
  return modelCall;
}
