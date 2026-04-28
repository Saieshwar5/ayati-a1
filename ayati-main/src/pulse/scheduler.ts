import { randomUUID } from "node:crypto";
import { devWarn } from "../shared/index.js";
import type { PulseLeasedOccurrence, PulseReminderDueEvent } from "./types.js";
import { PulseStore } from "./store.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_LEASE_MS = 5 * 60_000;

function inferEffectLevel(requestedAction: string | undefined, instruction: string): "act" | "act_external" {
  const text = `${requestedAction ?? ""} ${instruction}`.toLowerCase();
  return /\b(send|reply|email|mail|message|notify|post|share|forward|invite|publish|dispatch)\b/.test(text)
    ? "act_external"
    : "act";
}

export interface PulseSchedulerOptions {
  clientId: string;
  store: PulseStore;
  onReminderDue: (event: PulseReminderDueEvent) => Promise<void>;
  pollIntervalMs?: number;
  leaseMs?: number;
  now?: () => Date;
}

export class PulseScheduler {
  private readonly clientId: string;
  private readonly store: PulseStore;
  private readonly onReminderDue: (event: PulseReminderDueEvent) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly nowProvider: () => Date;
  private readonly leaseOwner: string;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: PulseSchedulerOptions) {
    this.clientId = options.clientId;
    this.store = options.store;
    this.onReminderDue = options.onReminderDue;
    this.pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.leaseMs = Math.max(5_000, options.leaseMs ?? DEFAULT_LEASE_MS);
    this.nowProvider = options.now ?? (() => new Date());
    this.leaseOwner = `pulse-scheduler:${randomUUID()}`;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.pollIntervalMs);
    await this.runOnce();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const now = this.nowProvider();
      const leased = await this.store.leaseDueOccurrences({
        clientId: this.clientId,
        leaseOwner: this.leaseOwner,
        leaseMs: this.leaseMs,
        now,
      });
      for (const entry of leased) {
        await this.dispatchOccurrence(entry);
      }
    } catch (error) {
      devWarn("Pulse scheduler tick failed:", error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
    }
  }

  private async dispatchOccurrence(entry: PulseLeasedOccurrence): Promise<void> {
    const event = this.buildEvent(entry);
    await this.store.recordOccurrenceDispatched({
      occurrenceId: entry.occurrence.id,
      eventId: event.eventId ?? "",
      now: this.nowProvider(),
    });

    try {
      await this.onReminderDue(event);
    } catch (error) {
      await this.store.markOccurrenceDispatchFailure({
        occurrenceId: entry.occurrence.id,
        errorMessage: error instanceof Error ? error.message : String(error),
        now: this.nowProvider(),
      });
      devWarn(
        `Pulse occurrence dispatch failed for ${entry.occurrence.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private buildEvent(entry: PulseLeasedOccurrence): PulseReminderDueEvent {
    const eventId = randomUUID();
    const triggeredAt = this.nowProvider().toISOString();
    const item = entry.item;
    const occurrence = entry.occurrence;
    const isTask = item.kind === "task";
    const requestedAction = item.payload.task?.requestedAction ?? item.payload.requestedAction;
    const intentKind = isTask ? "task" : item.kind === "notification" ? "notification" : "reminder";
    const dedupeKey = occurrence.attemptCount > 1
      ? `pulse:occurrence:${occurrence.id}:attempt:${occurrence.attemptCount}`
      : `pulse:occurrence:${occurrence.id}`;

    return {
      source: "pulse",
      eventName: isTask ? "task_due" : "reminder_due",
      eventId,
      receivedAt: triggeredAt,
      summary: `${isTask ? "Scheduled task due" : "Reminder due"}: ${item.title}`,
      intent: {
        kind: intentKind,
        eventClass: "trigger_fired",
        trustTier: "internal",
        effectLevel: inferEffectLevel(requestedAction, item.instruction),
        createdBy: "user",
        ...(requestedAction ? { requestedAction } : {}),
      },
      payload: {
        occurrenceId: occurrence.id,
        dedupeKey,
        dispatchAttempt: occurrence.attemptCount,
        scheduledItemId: item.id,
        ...(isTask ? { taskId: item.id } : { reminderId: item.id }),
        title: item.title,
        instruction: item.instruction,
        scheduledFor: occurrence.scheduledFor,
        triggeredAt,
        timezone: item.timezone,
        intentKind,
        executionMode: item.executionMode,
        ...(requestedAction ? { requestedAction } : {}),
        ...(item.payload.task ? { task: item.payload.task } : {}),
        metadata: item.metadata,
        payload: item.payload,
      },
    };
  }
}
