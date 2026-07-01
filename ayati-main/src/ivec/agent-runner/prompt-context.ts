import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import type { AgentContextPack } from "./context-pack.js";

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
  activity: {
    recent: ContextEngineMachineContext["session"]["activityTail"];
  };
}

export type PromptGitCurrentContext = Omit<ContextEngineMachineContext, "session" | "task"> & {
  task?: Omit<NonNullable<ContextEngineMachineContext["task"]>, "conversationMarkdownTail">;
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

export interface AgentPromptContext extends AgentContextPack {
  personal?: PromptPersonalContext;
  git?: PromptGitContext;
  scratch?: PromptScratchContext;
}

export interface ProjectAgentPromptContextInput {
  context: AgentContextPack;
  scratch?: PromptScratchContext;
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
        session: projectGitSessionForPrompt(input.context.gitContext.session),
        current: projectGitCurrentForPrompt(input.context.gitContext),
      },
    } : {}),
    ...(scratch ? { scratch } : {}),
  };
}

function projectGitSessionForPrompt(session: ContextEngineMachineContext["session"]): PromptGitSessionContext {
  return {
    meta: {
      sessionId: session.sessionId,
      assetCount: session.assetCount,
    },
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
  task: NonNullable<ContextEngineMachineContext["task"]>,
): NonNullable<PromptGitCurrentContext["task"]> {
  const {
    conversationMarkdownTail: _conversationMarkdownTail,
    ...projected
  } = task;
  return projected;
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
