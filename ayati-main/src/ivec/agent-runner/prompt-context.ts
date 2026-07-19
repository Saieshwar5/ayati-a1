import type {
  ContextCommitSummary,
  ContextEngineMachineContext,
  ContextPendingTurn,
  ContextReadContext,
  ContextReadEntry,
  ContextSessionActivityRecord,
  ContextSessionRunCheckpoint,
} from "../../context-engine/index.js";
import type { AgentContextPack } from "./context-pack.js";
import type { PromptToolCalls } from "./run-tool-call-context.js";
import type { AgentStateView } from "./state-view.js";

export interface PromptPersonalContext {
  memorySnapshot: string;
}

export interface PromptGitContext {
  session: PromptGitSessionContext;
  current: PromptGitCurrentContext;
}

export interface PromptGitSessionContext {
  meta: ContextEngineMachineContext["session"]["meta"];
  summary?: ContextEngineMachineContext["session"]["summary"];
  recentCommits?: PromptCommitSummary[];
  recentRunCheckpoints?: PromptSessionRunCheckpoint[];
  attachments?: unknown;
  activity: {
    recent: PromptSessionActivityRecord[];
  };
}

type ContextEngineWorkstreamContext = NonNullable<ContextEngineMachineContext["workstream"]>;

type PromptGitCurrentBase = Omit<
  ContextEngineMachineContext,
  "session" | "workstream" | "pendingTurn" | "readContext"
>;

export type PromptGitCurrentContext = PromptGitCurrentBase & {
  pendingTurn?: PromptPendingTurn;
  readContext?: PromptReadContext;
  workstream?: PromptGitWorkstreamContext;
};

export interface PromptGitWorkstreamContext {
  identity: {
    ref: string;
    workstreamId: string;
    title: string;
    objective: string;
  };
  state: {
    summary: string;
    workstreamStatus: "in_progress" | "done" | "blocked";
    lifecycleStatus: "active" | "paused" | "archived";
    repositoryHealth: "ready" | "dirty_external";
    currentFocus?: string;
    blockers: string[];
    next?: string;
    currentRequest?: ContextEngineWorkstreamContext["currentRequest"];
  };
  resources: ContextEngineWorkstreamContext["resources"];
  activity: {
    recentCommits: PromptCommitSummary[];
  };
};

type PromptCommitSummary = Omit<ContextCommitSummary, "runId">;
type PromptSessionRunCheckpoint = Omit<ContextSessionRunCheckpoint, "runId">;
type WithoutRunId<Value> = Value extends unknown ? Omit<Value, "runId"> : never;
type PromptSessionActivityRecord = WithoutRunId<ContextSessionActivityRecord>;
type PromptPendingTurn = Omit<ContextPendingTurn, "runId">;
type PromptReadEntry = Omit<ContextReadEntry, "runId">;

interface PromptReadContext extends Omit<ContextReadContext, "afterCommitRunId" | "inventory" | "discovery" | "evidence" | "actions"> {
  inventory: PromptReadEntry[];
  discovery: PromptReadEntry[];
  evidence: PromptReadEntry[];
  actions: PromptReadEntry[];
}

export interface PromptRunContext {
  workState?: PromptRunWorkStateContext;
  toolCalls?: PromptToolCalls;
  contextPressure?: {
    mode: "tool_compact" | "session_shed" | "timeline_checkpoint" | "step_ledger";
    recommendedMode?: "session_shed" | "timeline_checkpoint" | "step_ledger";
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

export interface AgentPromptContext extends AgentContextPack {
  personal?: PromptPersonalContext;
  git?: PromptGitContext;
  tools?: PromptToolsContext;
  harness?: PromptHarnessContext;
  run?: PromptRunContext;
}

export interface ProjectAgentPromptContextInput {
  context: AgentContextPack;
  sessionAttachments?: unknown;
  tools?: PromptToolsContext;
  harness?: PromptHarnessContext;
  run?: PromptRunContext;
}

export interface AgentPromptStateView {
  context: AgentPromptContext;
  attachments?: AgentStateView["attachments"];
}

export function projectAgentPromptContext(input: ProjectAgentPromptContextInput): AgentPromptContext {
  const personalMemorySnapshot = input.context.personalMemorySnapshot?.trim();
  const harness = compactHarnessContext(input.harness);
  const run = compactRunContext(input.run, { preserveProjectionMetadata: true });
  return {
    ...input.context,
    ...(personalMemorySnapshot ? {
      personal: {
        memorySnapshot: personalMemorySnapshot,
      },
    } : {}),
    ...(input.context.gitContext ? {
      git: {
        session: projectGitSessionForPrompt(input.context.gitContext.session, input.sessionAttachments),
        current: projectGitCurrentForPrompt(input.context.gitContext),
      },
    } : {}),
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

function projectGitSessionForPrompt(
  session: ContextEngineMachineContext["session"],
  attachments: unknown,
): PromptGitSessionContext {
  const promptAttachments = attachments ?? session.attachments;
  return {
    meta: readSessionMeta(session),
    ...(session.summary ? { summary: session.summary } : {}),
    ...(session.recentCommits ? {
      recentCommits: session.recentCommits.map(withoutRunId),
    } : {}),
    ...(session.recentRunCheckpoints ? {
      recentRunCheckpoints: session.recentRunCheckpoints.map(withoutRunId),
    } : {}),
    ...(promptAttachments ? {
      attachments: withoutInternalStoragePaths(promptAttachments),
    } : {}),
    activity: {
      recent: session.activityTail.map(withoutRunId),
    },
  };
}

function readSessionMeta(session: ContextEngineMachineContext["session"]): ContextEngineMachineContext["session"]["meta"] {
  if (session.meta) {
    return session.meta;
  }
  throw new Error("Git Context session metadata is required for prompt projection.");
}

function projectGitCurrentForPrompt(gitContext: ContextEngineMachineContext): PromptGitCurrentContext {
  const {
    session: _session,
    workstream,
    pendingTurn,
    readContext,
    ...current
  } = gitContext;
  return {
    ...current,
    ...(pendingTurn ? { pendingTurn: withoutRunId(pendingTurn) } : {}),
    ...(readContext ? { readContext: projectReadContextForPrompt(readContext) } : {}),
    ...(workstream ? {
      workstream: projectGitWorkstreamForPrompt(workstream),
    } : {}),
  };
}

function projectGitWorkstreamForPrompt(
  workstream: ContextEngineWorkstreamContext,
): PromptGitWorkstreamContext {
  return {
    identity: {
      ref: workstream.ref,
      workstreamId: workstream.workstreamId,
      title: workstream.title,
      objective: workstream.objective,
    },
    state: {
      summary: workstream.summary,
      workstreamStatus: workstream.workstreamStatus,
      lifecycleStatus: workstream.lifecycleStatus,
      repositoryHealth: workstream.repositoryHealth,
      ...(workstream.currentFocus ? { currentFocus: workstream.currentFocus } : {}),
      blockers: workstream.blockers,
      ...(workstream.next ? { next: workstream.next } : {}),
      ...(workstream.currentRequest ? { currentRequest: workstream.currentRequest } : {}),
    },
    resources: workstream.resources,
    activity: {
      recentCommits: workstream.recentCommits.map(withoutRunId),
    },
  };
}

function projectReadContextForPrompt(
  readContext: ContextReadContext | PromptReadContext,
): PromptReadContext {
  const { afterCommitRunId: _afterCommitRunId, ...projected } = readContext as ContextReadContext;
  return {
    revision: projected.revision,
    inventory: projected.inventory.map(withoutRunId),
    discovery: projected.discovery.map(withoutRunId),
    evidence: projected.evidence.map(withoutRunId),
    actions: projected.actions.map(withoutRunId),
  };
}

function withoutRunId<Value extends object>(value: Value): WithoutRunId<Value> {
  const { runId: _runId, ...projected } = value as Value & { runId?: unknown };
  return projected as WithoutRunId<Value>;
}

const INTERNAL_STORAGE_PATH_KEYS = new Set([
  "artifactPath",
  "contextRepositoryPath",
  "derivedDir",
  "metadataPath",
  "repositoryPath",
  "runFile",
  "runPath",
  "stepsFile",
  "storagePath",
  "storedPath",
]);

function withoutInternalStoragePaths(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutInternalStoragePaths);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !INTERNAL_STORAGE_PATH_KEYS.has(key))
      .map(([key, item]) => [key, withoutInternalStoragePaths(item)]),
  );
}

function compactAgentPromptContext(context: AgentPromptContext): AgentPromptContext {
  const run = compactRunContext(context.run);
  return {
    timeline: context.timeline,
    ...(context.git ? { git: compactPromptGitContext(context.git) } : {}),
    ...(context.tools ? { tools: context.tools } : {}),
    ...(context.harness ? { harness: context.harness } : {}),
    ...(run ? { run } : {}),
    ...(context.personal ? { personal: context.personal } : {}),
  };
}

function compactPromptGitContext(git: PromptGitContext): PromptGitContext {
  return {
    session: {
      ...git.session,
      ...(git.session.recentCommits ? {
        recentCommits: git.session.recentCommits.map(withoutRunId),
      } : {}),
      ...(git.session.recentRunCheckpoints ? {
        recentRunCheckpoints: git.session.recentRunCheckpoints.map(withoutRunId),
      } : {}),
      ...(git.session.attachments ? {
        attachments: withoutInternalStoragePaths(git.session.attachments),
      } : {}),
      activity: {
        recent: git.session.activity.recent.map(withoutRunId),
      },
    },
    current: compactPromptGitCurrent(git.current),
  };
}

function compactPromptGitCurrent(current: PromptGitCurrentContext): PromptGitCurrentContext {
  const { pendingTurn, readContext, workstream, ...rest } = current;
  return {
    ...rest,
    ...(pendingTurn ? { pendingTurn: withoutRunId(pendingTurn) } : {}),
    ...(readContext ? { readContext: projectReadContextForPrompt(readContext) } : {}),
    ...(workstream ? { workstream: compactPromptGitWorkstream(workstream) } : {}),
  };
}

function compactPromptGitWorkstream(
  workstream: PromptGitWorkstreamContext,
): PromptGitWorkstreamContext {
  return {
    ...workstream,
    activity: {
      recentCommits: workstream.activity.recentCommits.map(withoutRunId),
    },
  };
}

function compactHarnessContext(harness: PromptHarnessContext | undefined): PromptHarnessContext | undefined {
  if (!harness) {
    return undefined;
  }
  const compacted: PromptHarnessContext = {
    ...(harness.feedback ? { feedback: harness.feedback } : {}),
  };
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function compactRunContext(
  run: PromptRunContext | undefined,
  options: { preserveProjectionMetadata?: boolean } = {},
): PromptRunContext | undefined {
  if (!run) {
    return undefined;
  }
  const compacted: PromptRunContext = {
    ...(run.workState ? { workState: run.workState } : {}),
    ...(run.toolCalls ? {
      toolCalls: options.preserveProjectionMetadata
        ? run.toolCalls
        : run.toolCalls.map(({ projectionMetadata: _projectionMetadata, ...call }) => call),
    } : {}),
    ...(run.contextPressure ? { contextPressure: run.contextPressure } : {}),
  };
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}
