import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import type { AgentContextPack } from "./context-pack.js";

export interface PromptPersonalContext {
  memorySnapshot: string;
}

export interface PromptGitContext {
  current: ContextEngineMachineContext;
}

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
        current: input.context.gitContext,
      },
    } : {}),
    ...(scratch ? { scratch } : {}),
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
