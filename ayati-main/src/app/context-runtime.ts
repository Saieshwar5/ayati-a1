import type { AyatiRuntimeConfig } from "../config/runtime-config.js";
import {
  createDailySessionContextEngineRuntime,
  createGitMemoryRuntime,
  type ContextEngineRuntime,
  type GitMemoryRuntime,
} from "../context-engine/index.js";

export interface ContextRuntimeOptions {
  config: AyatiRuntimeConfig;
}

export type AppContextRuntime =
  | {
      kind: "daily_session";
      contextEngineRuntime: ContextEngineRuntime;
    }
  | {
      kind: "git_memory";
      gitMemoryRuntime: GitMemoryRuntime;
    };

export function createContextEngineRuntime(options: ContextRuntimeOptions): ContextEngineRuntime {
  const gitContext = options.config.gitContext;
  return createDailySessionContextEngineRuntime({
    contextStoreDir: gitContext.storeDir,
    timezone: gitContext.timezone,
  });
}

export function createAppContextRuntime(options: ContextRuntimeOptions): AppContextRuntime {
  const gitContext = options.config.gitContext;
  if (gitContext.engine === "git_memory") {
    return {
      kind: "git_memory",
      gitMemoryRuntime: createGitMemoryRuntime({
        contextStoreDir: gitContext.storeDir,
        timezone: gitContext.timezone,
        agentId: gitContext.agentId,
      }),
    };
  }

  return {
    kind: "daily_session",
    contextEngineRuntime: createContextEngineRuntime(options),
  };
}
