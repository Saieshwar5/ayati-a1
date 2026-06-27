import {
  type DailySessionMachineContextPack,
} from "./context-pack.js";
import type {
  ContextEngineAmbiguousTurn,
  ContextEngineReadyTurn,
  ContextEngineRuntime,
  PrepareContextUserTurnInput,
  RecordContextAssistantMessageInput,
} from "../contracts.js";
import { GitDriver } from "./git-driver.js";
import type { CompletePreparedRunInput, CompletedPreparedRun } from "./session-coordinator.js";
import {
  DailySessionCoordinator,
  type PreparedUserTurn,
} from "./session-coordinator.js";
import {
  createRunId,
  isRunId,
  type RunId,
  type SessionId,
  type WorkId,
} from "./ids.js";
import type { DailySessionGitStore } from "./git-store.js";

export interface DailySessionRuntimeOptions {
  store: DailySessionGitStore;
  timezone: string;
  now?: () => Date;
  coordinator?: DailySessionCoordinator;
}

export interface PrepareDailySessionUserTurnInput extends PrepareContextUserTurnInput {}

export interface DailySessionRuntimeReadyTurn extends ContextEngineReadyTurn {
  status: "ready";
  sessionId: SessionId;
  runId: RunId;
  workId: WorkId;
  ref: string;
  prepared: Extract<PreparedUserTurn, { status: "ready" }>;
  context: DailySessionMachineContextPack;
}

export interface DailySessionRuntimeAmbiguousTurn extends ContextEngineAmbiguousTurn {
  status: "ambiguous";
  sessionId: SessionId;
  prepared: Extract<PreparedUserTurn, { status: "ambiguous" }>;
  context: DailySessionMachineContextPack;
  message: string;
}

export type DailySessionRuntimePreparedTurn =
  | DailySessionRuntimeReadyTurn
  | DailySessionRuntimeAmbiguousTurn;

export interface RecordDailySessionAssistantMessageInput extends RecordContextAssistantMessageInput {}

export interface DailySessionRuntime extends ContextEngineRuntime {
  prepareUserTurn(input: PrepareDailySessionUserTurnInput): Promise<DailySessionRuntimePreparedTurn>;
  completePreparedRun(input: CompletePreparedRunInput): Promise<CompletedPreparedRun>;
  recordAssistantMessage(input: RecordDailySessionAssistantMessageInput): Promise<void>;
}

export class DailySessionRuntimeBridge implements DailySessionRuntime {
  private readonly store: DailySessionGitStore;
  private readonly timezone: string;
  private readonly nowProvider: () => Date;
  private readonly coordinator: DailySessionCoordinator;

  constructor(options: DailySessionRuntimeOptions) {
    this.store = options.store;
    this.timezone = options.timezone;
    this.nowProvider = options.now ?? (() => new Date());
    this.coordinator = options.coordinator ?? new DailySessionCoordinator({ store: options.store });
  }

  async prepareUserTurn(input: PrepareDailySessionUserTurnInput): Promise<DailySessionRuntimePreparedTurn> {
    const at = input.at ?? this.nowProvider().toISOString();
    const timezone = input.timezone ?? this.timezone;
    const sessionId = input.sessionId ?? dailySessionIdForDate(new Date(at), timezone);
    const prepared = await this.coordinator.prepareUserTurn({
      sessionId,
      timezone,
      userMessage: input.userMessage,
      at,
    });

    if (prepared.status === "ambiguous") {
      return {
        status: "ambiguous",
        sessionId,
        prepared,
        context: prepared.context,
        message: buildAmbiguousWorkMessage(prepared),
        candidateCount: prepared.resolution.candidates.length,
      };
    }

    return {
      status: "ready",
      sessionId,
      runId: await this.nextRunId(sessionId),
      workId: prepared.selected.workId,
      ref: prepared.selected.ref,
      prepared,
      context: prepared.context,
    };
  }

  async completePreparedRun(input: CompletePreparedRunInput): Promise<CompletedPreparedRun> {
    return await this.coordinator.completePreparedRun(input);
  }

  async recordAssistantMessage(input: RecordDailySessionAssistantMessageInput): Promise<void> {
    await this.store.appendConversation({
      sessionId: input.sessionId,
      role: "assistant",
      text: input.text,
      at: input.at,
    });
  }

  private async nextRunId(sessionId: SessionId): Promise<RunId> {
    const driver = new GitDriver(this.store.repoPath(sessionId));
    const runRefs = await driver.listRefs("refs/ayati/runs");
    const maxSequence = runRefs.reduce((max, record) => {
      const runId = record.ref.split("/").at(-1) ?? "";
      if (!isRunId(runId) || runId.slice(2, 10) !== sessionId.replace(/-/g, "")) {
        return max;
      }
      const sequence = Number(runId.split("-")[2] ?? "0");
      return Number.isInteger(sequence) ? Math.max(max, sequence) : max;
    }, 0);
    return createRunId(sessionId, maxSequence + 1);
  }
}

export function dailySessionIdForDate(date: Date, timezone: string): SessionId {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = partValue(parts, "year");
  const month = partValue(parts, "month");
  const day = partValue(parts, "day");
  return `${year}-${month}-${day}`;
}

function buildAmbiguousWorkMessage(turn: Extract<PreparedUserTurn, { status: "ambiguous" }>): string {
  const choices = turn.resolution.candidates
    .slice(0, 5)
    .map((candidate) => `- ${candidate.workId}: ${candidate.title}`)
    .join("\n");
  return [
    "I found multiple matching tasks. Tell me which one to continue.",
    choices,
  ].filter((line) => line.trim().length > 0).join("\n");
}

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) {
    throw new Error(`Could not resolve ${type} for daily session date.`);
  }
  return value;
}
