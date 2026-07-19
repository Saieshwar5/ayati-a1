import type {
  ContextCommitSummary,
  ContextEngineMachineContext,
  ContextPendingTurn,
  ContextReadContext,
  ContextReadEntry,
  ContextSessionActivityRecord,
  ContextSessionTaskRunCheckpoint,
  ContextTaskArtifactRecord,
  ContextTaskEvidenceSummary,
  ContextTaskRunSummary,
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
  recentTaskRuns?: PromptSessionRunCheckpoint[];
  attachments?: unknown;
  activity: {
    recent: PromptSessionActivityRecord[];
  };
}

type ContextEngineTaskContext = NonNullable<ContextEngineMachineContext["task"]> & {
  branch?: string;
  summary?: string;
  taskId?: string;
};

type PromptGitCurrentBase = Omit<
  ContextEngineMachineContext,
  "session" | "task" | "pendingTurn" | "readContext"
>;

export type PromptGitCurrentContext = PromptGitCurrentBase & {
  pendingTurn?: PromptPendingTurn;
  readContext?: PromptReadContext;
  task?: PromptGitTaskContext;
};

export interface PromptGitTaskContext {
  identity: {
    ref: string;
    title: string;
    objective: string;
    branch?: string;
    taskId?: string;
    workId?: string;
    workingDirectory?: string;
  };
  state: {
    status: string;
    completed: string[];
    open: string[];
    blockers: string[];
    facts: ContextEngineTaskContext["facts"];
    next?: string;
    summary?: string;
  };
  assets: ContextEngineTaskContext["assets"];
  artifacts?: PromptTaskArtifact[];
  activity: {
    recentRuns: PromptTaskRunSummary[];
    recentEvidence: PromptTaskEvidenceSummary[];
  };
};

type PromptCommitSummary = Omit<ContextCommitSummary, "runId">;
type PromptSessionRunCheckpoint = Omit<ContextSessionTaskRunCheckpoint, "runId">;
type WithoutRunId<Value> = Value extends unknown ? Omit<Value, "runId"> : never;
type PromptSessionActivityRecord = WithoutRunId<ContextSessionActivityRecord>;
type PromptPendingTurn = Omit<ContextPendingTurn, "runId">;
type PromptReadEntry = Omit<ContextReadEntry, "runId">;
type PromptTaskRunSummary = Omit<ContextTaskRunSummary, "runId">;
type PromptTaskEvidenceSummary = Omit<ContextTaskEvidenceSummary, "runId">;
type PromptTaskArtifact = Omit<
  ContextTaskArtifactRecord,
  "createdByRunId" | "lastTouchedRunId" | "sourceRunId"
>;

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
    ...(session.recentTaskRuns ? {
      recentTaskRuns: session.recentTaskRuns.map(withoutRunId),
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
    task,
    pendingTurn,
    readContext,
    ...current
  } = gitContext;
  return {
    ...current,
    ...(pendingTurn ? { pendingTurn: withoutRunId(pendingTurn) } : {}),
    ...(readContext ? { readContext: projectReadContextForPrompt(readContext) } : {}),
    ...(task ? {
      task: projectGitTaskForPrompt(task),
    } : {}),
  };
}

function projectGitTaskForPrompt(
  task: ContextEngineTaskContext,
): PromptGitTaskContext {
  return {
    identity: {
      ref: task.ref,
      title: task.title,
      objective: task.objective,
      ...(task.branch ? { branch: task.branch } : {}),
      ...(task.taskId ? { taskId: task.taskId } : {}),
      ...(task.workId ? { workId: task.workId } : {}),
      ...(task.workingDirectory ? { workingDirectory: task.workingDirectory } : {}),
    },
    state: {
      status: task.status,
      completed: task.completed,
      open: task.open,
      blockers: task.blockers,
      facts: task.facts,
      ...(task.next ? { next: task.next } : {}),
      ...(task.summary ? { summary: task.summary } : {}),
    },
    assets: task.assets,
    ...(task.artifacts ? {
      artifacts: task.artifacts.map(projectTaskArtifactForPrompt),
    } : {}),
    activity: {
      recentRuns: task.recentRuns.map(withoutRunId),
      recentEvidence: task.recentEvidence.map(withoutRunId),
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

function projectTaskArtifactForPrompt(
  artifact: ContextTaskArtifactRecord | PromptTaskArtifact,
): PromptTaskArtifact {
  const {
    createdByRunId: _createdByRunId,
    lastTouchedRunId: _lastTouchedRunId,
    sourceRunId: _sourceRunId,
    ...projected
  } = artifact as ContextTaskArtifactRecord;
  return projected;
}

function withoutRunId<Value extends object>(value: Value): WithoutRunId<Value> {
  const { runId: _runId, ...projected } = value as Value & { runId?: unknown };
  return projected as WithoutRunId<Value>;
}

const INTERNAL_STORAGE_PATH_KEYS = new Set([
  "artifactPath",
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
      ...(git.session.recentTaskRuns ? {
        recentTaskRuns: git.session.recentTaskRuns.map(withoutRunId),
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
  const { pendingTurn, readContext, task, ...rest } = current;
  return {
    ...rest,
    ...(pendingTurn ? { pendingTurn: withoutRunId(pendingTurn) } : {}),
    ...(readContext ? { readContext: projectReadContextForPrompt(readContext) } : {}),
    ...(task ? { task: compactPromptGitTask(task) } : {}),
  };
}

function compactPromptGitTask(task: PromptGitTaskContext): PromptGitTaskContext {
  return {
    ...task,
    ...(task.artifacts ? {
      artifacts: task.artifacts.map(projectTaskArtifactForPrompt),
    } : {}),
    activity: {
      recentRuns: task.activity.recentRuns.map(withoutRunId),
      recentEvidence: task.activity.recentEvidence.map(withoutRunId),
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
