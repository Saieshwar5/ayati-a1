import { devLog, devWarn } from "../../shared/index.js";
import { InboundQueueStore, type QueuedInboundEventRecord } from "./inbound-queue-store.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 10;

export interface SystemEventWorkerOptions {
  queueStore: InboundQueueStore;
  processEvent: (clientId: string, event: QueuedInboundEventRecord["event"]) => Promise<void>;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  now?: () => Date;
}

export class SystemEventWorker {
  private readonly queueStore: InboundQueueStore;
  private readonly processEvent: (clientId: string, event: QueuedInboundEventRecord["event"]) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly nowProvider: () => Date;

  private running = false;
  private loopPromise: Promise<void> | null = null;

  constructor(options: SystemEventWorkerOptions) {
    this.queueStore = options.queueStore;
    this.processEvent = options.processEvent;
    this.pollIntervalMs = Math.max(100, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.retryDelayMs = Math.max(1_000, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.nowProvider = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.running) {
      return;
    }

    const recovered = this.queueStore.recoverInFlight();
    if (recovered > 0) {
      devWarn(`Recovered ${recovered} in-flight inbound event(s) back to the queue.`);
    }

    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
    this.loopPromise = null;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const next = this.queueStore.claimNext(this.nowProvider().toISOString());
      if (!next) {
        await sleep(this.pollIntervalMs);
        continue;
      }

      await this.processNext(next);
    }
  }

  private async processNext(item: QueuedInboundEventRecord): Promise<void> {
    try {
      await this.processEvent(item.clientId, item.event);
      this.queueStore.markCompleted(item.id, this.nowProvider().toISOString());
      devLog(
        `Inbound event completed: queueId=${item.id} eventId=${item.event.eventId} source=${item.source}`,
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const nextAttempt = item.attemptCount + 1;
      if (nextAttempt >= this.maxAttempts) {
        this.queueStore.markFailed(item.id, errorMessage, this.nowProvider().toISOString());
        devWarn(
          `Inbound event failed permanently: queueId=${item.id} eventId=${item.event.eventId} attempts=${nextAttempt} error=${errorMessage}`,
        );
        return;
      }

      const retryAt = new Date(this.nowProvider().getTime() + this.retryDelayMs).toISOString();
      this.queueStore.reschedule(item.id, errorMessage, retryAt);
      devWarn(
        `Inbound event rescheduled: queueId=${item.id} eventId=${item.event.eventId} attempt=${nextAttempt} retryAt=${retryAt} error=${errorMessage}`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
