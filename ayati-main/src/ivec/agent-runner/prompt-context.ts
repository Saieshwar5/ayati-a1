import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import type { AgentContextPack } from "./context-pack.js";
import type { AgentStateView } from "./state-view.js";

export interface PromptPersonalContext {
  memorySnapshot: string;
}

export interface PromptGitContext {
  session: PromptGitSessionContext;
  current: PromptGitCurrentContext;
}

export interface PromptGitSessionContext {
  meta: {
    sessionId: string;
    assetCount: number;
  };
  summary?: ContextEngineMachineContext["session"]["summary"];
  attachments?: unknown;
  activity: {
    recent: ContextEngineMachineContext["session"]["activityTail"];
  };
}

type ContextEngineTaskContext = NonNullable<ContextEngineMachineContext["task"]> & {
  branch?: string;
  summary?: string;
  taskId?: string;
};

export type PromptGitCurrentContext = Omit<ContextEngineMachineContext, "session" | "task"> & {
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
  activity: {
    recentRuns: ContextEngineTaskContext["recentRuns"];
    recentEvidence: ContextEngineTaskContext["recentEvidence"];
  };
};

export interface PromptScratchContext {
  progress?: unknown;
  feedback?: unknown;
  toolLoad?: unknown;
  observations?: unknown;
  trace?: unknown;
  attachments?: unknown;
  systemEvent?: unknown;
}

export interface PromptToolsContext {
  active: string[];
  lastLoad?: unknown;
}

export interface AgentPromptContext extends AgentContextPack {
  personal?: PromptPersonalContext;
  git?: PromptGitContext;
  tools?: PromptToolsContext;
  scratch?: PromptScratchContext;
}

export interface ProjectAgentPromptContextInput {
  context: AgentContextPack;
  sessionAttachments?: unknown;
  tools?: PromptToolsContext;
  scratch?: PromptScratchContext;
}

export interface AgentPromptStateView {
  context: AgentPromptContext;
}

export function projectAgentPromptContext(input: ProjectAgentPromptContextInput): AgentPromptContext {
  const personalMemorySnapshot = input.context.personalMemorySnapshot?.trim();
  const scratch = compactScratchContext(input.scratch);
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
    ...(scratch ? { scratch } : {}),
  };
}

export function projectAgentStateViewForPrompt(stateView: AgentStateView): AgentPromptStateView {
  return {
    context: compactAgentPromptContext(stateView.context),
  };
}

function projectGitSessionForPrompt(
  session: ContextEngineMachineContext["session"],
  attachments: unknown,
): PromptGitSessionContext {
  return {
    meta: {
      sessionId: session.sessionId,
      assetCount: session.assetCount,
    },
    ...(session.summary ? { summary: session.summary } : {}),
    ...(attachments ?? session.attachments ? { attachments: attachments ?? session.attachments } : {}),
    activity: {
      recent: session.activityTail,
    },
  };
}

function projectGitCurrentForPrompt(gitContext: ContextEngineMachineContext): PromptGitCurrentContext {
  const { session: _session, task, ...current } = gitContext;
  return {
    ...current,
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
    activity: {
      recentRuns: task.recentRuns,
      recentEvidence: task.recentEvidence,
    },
  };
}

function compactAgentPromptContext(context: AgentPromptContext): AgentPromptContext {
  return {
    timeline: context.timeline,
    ...(context.git ? { git: context.git } : {}),
    ...(context.tools ? { tools: context.tools } : {}),
    ...(context.scratch ? { scratch: context.scratch } : {}),
    ...(context.personal ? { personal: context.personal } : {}),
  };
}

function compactScratchContext(scratch: PromptScratchContext | undefined): PromptScratchContext | undefined {
  if (!scratch) {
    return undefined;
  }
  const compacted: PromptScratchContext = {
    ...(scratch.progress ? { progress: scratch.progress } : {}),
    ...(scratch.feedback ? { feedback: scratch.feedback } : {}),
    ...(scratch.toolLoad ? { toolLoad: scratch.toolLoad } : {}),
    ...(scratch.observations ? { observations: scratch.observations } : {}),
    ...(scratch.trace ? { trace: scratch.trace } : {}),
    ...(scratch.attachments ? { attachments: scratch.attachments } : {}),
    ...(scratch.systemEvent ? { systemEvent: scratch.systemEvent } : {}),
  };
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}
