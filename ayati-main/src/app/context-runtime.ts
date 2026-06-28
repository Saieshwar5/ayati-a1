import type { AyatiRuntimeConfig } from "../config/runtime-config.js";
import {
  createDailySessionContextEngineRuntime,
  type ContextEngineRuntime,
} from "../context-engine/index.js";

export interface ContextRuntimeOptions {
  config: AyatiRuntimeConfig;
}

export function createContextEngineRuntime(options: ContextRuntimeOptions): ContextEngineRuntime {
  const gitContext = options.config.gitContext;
  return createDailySessionContextEngineRuntime({
    contextStoreDir: gitContext.storeDir,
    timezone: gitContext.timezone,
  });
}
