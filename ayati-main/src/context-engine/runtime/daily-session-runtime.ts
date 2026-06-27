import type { ContextEngineRuntime } from "../contracts.js";
import { DailySessionGitStore } from "../daily-session/git-store.js";
import { DailySessionRuntimeBridge } from "../daily-session/runtime.js";

export interface CreateDailySessionContextEngineRuntimeOptions {
  contextStoreDir: string;
  timezone: string;
  now?: () => Date;
}

export function createDailySessionContextEngineRuntime(
  options: CreateDailySessionContextEngineRuntimeOptions,
): ContextEngineRuntime {
  return new DailySessionRuntimeBridge({
    store: new DailySessionGitStore({
      contextStoreDir: options.contextStoreDir,
    }),
    timezone: options.timezone,
    ...(options.now ? { now: options.now } : {}),
  });
}
