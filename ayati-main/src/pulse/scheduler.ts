import { randomUUID } from "node:crypto";
import { devWarn } from "../shared/index.js";
import type { PulseReminderDueEvent, PulseReminder } from "./types.js";
import { PulseStore } from "./store.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;

function toRequestedAction(value: string): string | undefined {
  const compact = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return compact.length > 0 ? compact : undefined;
}

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
  now?: () => Date;
}

export class PulseScheduler {
  private readonly clientId: string;
  private readonly store: PulseStore;
  private readonly onReminderDue: (event: PulseReminderDueEvent) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly nowProvider: () => Date;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlightOccurrences = new Set<string>();

  constructor(options: PulseSchedulerOptions) {
    this.clientId = options.clientId;
    this.store = options.store;
    this.onReminderDue = options.onReminderDue;
    this.pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.nowProvider = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    await this.tick();
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

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const now = this.nowProvider();
      const dueReminders = await this.store.getDueReminders(this.clientId, now);
      for (const reminder of dueReminders) {
        await this.deliverReminder(reminder);
      }
    } catch (err) {
      devWarn("Pulse scheduler tick failed:", err instanceof Error ? err.message : String(err));
    } finally {
      this.running = false;
    }
  }

  private async deliverReminder(reminder: PulseReminder): Promise<void> {
    if (!reminder.nextTriggerAt) return;

    const occurrenceId = `${reminder.id}:${reminder.nextTriggerAt}`;
    if (this.inFlightOccurrences.has(occurrenceId)) {
      return;
    }

    this.inFlightOccurrences.add(occurrenceId);

    const triggeredAt = this.nowProvider().toISOString();
    const isTask = reminder.intentKind === "task";
    const requestedAction = reminder.task?.requestedAction ?? reminder.requestedAction ?? toRequestedAction(reminder.instruction);
    const event: PulseReminderDueEvent = {
      source: "pulse",
      eventName: isTask ? "task_due" : "reminder_due",
      eventId: randomUUID(),
      receivedAt: triggeredAt,
      summary: `${isTask ? "Scheduled task due" : "Reminder due"}: ${reminder.title}`,
      intent: {
        kind: reminder.intentKind,
        eventClass: "trigger_fired",
        trustTier: "internal",
        effectLevel: inferEffectLevel(requestedAction, reminder.instruction),
        createdBy: "user",
        ...(requestedAction ? { requestedAction } : {}),
      },
      payload: {
        occurrenceId,
        scheduledItemId: reminder.id,
        ...(isTask ? { taskId: reminder.id } : { reminderId: reminder.id }),
        title: reminder.title,
        instruction: reminder.instruction,
        scheduledFor: reminder.nextTriggerAt,
        triggeredAt,
        timezone: reminder.timezone,
        intentKind: reminder.intentKind,
        ...(requestedAction ? { requestedAction } : {}),
        ...(reminder.task ? { task: reminder.task } : {}),
        metadata: reminder.metadata,
        originRunId: reminder.originRunId,
        originSessionId: reminder.originSessionId,
      },
    };

    try {
      await this.onReminderDue(event);
      await this.store.markDelivered({
        clientId: this.clientId,
        reminderId: reminder.id,
        occurrenceId,
        scheduledFor: reminder.nextTriggerAt,
        triggeredAt,
      });
    } catch (err) {
      devWarn(
        `Pulse reminder delivery failed for ${reminder.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.inFlightOccurrences.delete(occurrenceId);
    }
  }
}
