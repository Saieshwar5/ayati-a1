import type { AyatiRuntimeConfig } from "../config/runtime-config.js";
import {
  createDailySessionContextEngineRuntime,
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

  return createDailySessionContextEngineRuntime({
    contextStoreDir: gitContext.storeDir,
    timezone: gitContext.timezone,
  });
}
