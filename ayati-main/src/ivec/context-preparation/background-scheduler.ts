import type { LlmProvider } from "../../core/contracts/provider.js";

export interface BackgroundTaskResult<Value> {
  status: "success" | "failed";
  durationMs: number;
  value?: Value;
  error?: string;
}

export type BackgroundScheduleResult<Value> =
  | {
      status: "started" | "deduplicated";
      key: string;
      promise: Promise<BackgroundTaskResult<Value>>;
    }
  | {
      status: "busy";
      key: string;
      activeKey: string;
    };

interface ActiveBackgroundTask {
  key: string;
  promise: Promise<BackgroundTaskResult<unknown>>;
}

export class ProviderBackgroundSummaryScheduler {
  private active?: ActiveBackgroundTask;

  schedule<Value>(key: string, task: () => Promise<Value>): BackgroundScheduleResult<Value> {
    if (this.active) {
      if (this.active.key === key) {
        return {
          status: "deduplicated",
          key,
          promise: this.active.promise as Promise<BackgroundTaskResult<Value>>,
        };
      }
      return { status: "busy", key, activeKey: this.active.key };
    }

    const startedAt = Date.now();
    const promise = Promise.resolve()
      .then(task)
      .then((value): BackgroundTaskResult<Value> => ({
        status: "success",
        durationMs: Date.now() - startedAt,
        value,
      }))
      .catch((error: unknown): BackgroundTaskResult<Value> => ({
        status: "failed",
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        if (this.active?.key === key) this.active = undefined;
      });
    this.active = {
      key,
      promise: promise as Promise<BackgroundTaskResult<unknown>>,
    };
    return { status: "started", key, promise };
  }

  async runWhenAvailable<Value>(key: string, task: () => Promise<Value>): Promise<BackgroundTaskResult<Value>> {
    const active = this.active;
    if (active && active.key !== key) await active.promise;
    const scheduled = this.schedule(key, task);
    if (scheduled.status === "busy") {
      await this.active?.promise;
      return await this.runWhenAvailable(key, task);
    }
    return await scheduled.promise;
  }

  activeKey(): string | undefined {
    return this.active?.key;
  }

  isBusy(): boolean {
    return Boolean(this.active);
  }
}

const SCHEDULERS = new WeakMap<LlmProvider, ProviderBackgroundSummaryScheduler>();

export function providerBackgroundSummaryScheduler(
  provider: LlmProvider,
): ProviderBackgroundSummaryScheduler {
  const existing = SCHEDULERS.get(provider);
  if (existing) return existing;
  const created = new ProviderBackgroundSummaryScheduler();
  SCHEDULERS.set(provider, created);
  return created;
}
