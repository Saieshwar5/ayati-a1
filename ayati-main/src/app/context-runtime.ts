import type { AyatiRuntimeConfig } from "../config/runtime-config.js";
import {
  DailySessionGitStore,
  DailySessionRuntimeBridge,
  type ContextEngineRuntime,
} from "../context-engine/index.js";

export interface ContextRuntimeOptions {
  config: AyatiRuntimeConfig;
}

export function createContextEngineRuntime(options: ContextRuntimeOptions): ContextEngineRuntime | undefined {
  const gitContext = options.config.gitContext;
  if (!gitContext.enabled) {
    return undefined;
  }

  return new DailySessionRuntimeBridge({
    store: new DailySessionGitStore({
      contextStoreDir: gitContext.storeDir,
    }),
    timezone: gitContext.timezone,
  });
}
