import type {
  ConversationRecord,
  SessionAssetRecord,
  SessionEventRecord,
} from "./session-files.js";
import type {
  TaskAssetRecord,
  TaskFile,
  TaskRunSummaryFile,
  TaskStateFile,
} from "./task-files.js";
import type { ParsedAyatiTrailers } from "./commit-message.js";
import type {
  DailySessionGitStore,
  TaskCommitLogEntry,
} from "./git-store.js";
import type { SessionId, WorkId } from "./ids.js";
import { parseWorkBranchRef, type GitRef } from "./refs.js";

export interface DailySessionContextLimits {
  conversationTailLimit: number;
  eventTailLimit: number;
  runSummaryLimit: number;
  commitLogLimit: number;
}

export const DEFAULT_DAILY_SESSION_CONTEXT_LIMITS: DailySessionContextLimits = {
  conversationTailLimit: 20,
  eventTailLimit: 30,
  runSummaryLimit: 5,
  commitLogLimit: 10,
};

export type FocusContext =
  | {
      status: "none";
    }
  | {
      status: "active";
      ref: GitRef;
      workId: WorkId;
    }
  | {
      status: "missing";
      ref: GitRef;
      workId?: WorkId;
      reason: string;
    }
  | {
      status: "unresolved";
      ref: GitRef;
      reason: string;
    };

export interface DailySessionTaskContext {
  ref: GitRef;
  task: TaskFile;
  state: TaskStateFile;
  assets: TaskAssetRecord[];
  recentRuns: TaskRunSummaryFile[];
  recentCommits: TaskCommitLogEntry[];
}

export interface DailySessionContext {
  session: {
    sessionId: SessionId;
    conversationTail: ConversationRecord[];
    eventTail: SessionEventRecord[];
    assets: SessionAssetRecord[];
  };
  focus: FocusContext;
  task?: DailySessionTaskContext;
}

export class DailySessionContextReader {
  constructor(private readonly store: DailySessionGitStore) {}

  async buildActiveContext(input: {
    sessionId: SessionId;
    limits?: Partial<DailySessionContextLimits>;
  }): Promise<DailySessionContext> {
    const limits = normalizeLimits(input.limits);
    const base = await this.readSessionBase(input.sessionId, limits);
    const focusRef = await this.store.readFocus(input.sessionId);
    if (!focusRef) {
      return {
        session: base,
        focus: { status: "none" },
      };
    }
    const parsed = parseWorkBranchRef(focusRef);
    if (!parsed) {
      return {
        session: base,
        focus: {
          status: "unresolved",
          ref: focusRef,
          reason: "focus ref is not a work branch ref",
        },
      };
    }
    return await this.buildResolvedTaskContext({
      sessionId: input.sessionId,
      workId: parsed.workId,
      expectedRef: focusRef,
      limits,
      base,
    });
  }

  async buildTaskContext(input: {
    sessionId: SessionId;
    workId: WorkId;
    limits?: Partial<DailySessionContextLimits>;
  }): Promise<DailySessionContext> {
    const limits = normalizeLimits(input.limits);
    const base = await this.readSessionBase(input.sessionId, limits);
    return await this.buildResolvedTaskContext({
      sessionId: input.sessionId,
      workId: input.workId,
      limits,
      base,
    });
  }

  private async buildResolvedTaskContext(input: {
    sessionId: SessionId;
    workId: WorkId;
    expectedRef?: GitRef;
    limits: DailySessionContextLimits;
    base: DailySessionContext["session"];
  }): Promise<DailySessionContext> {
    const branch = (await this.store.listTaskBranches(input.sessionId))
      .find((candidate) => candidate.workId === input.workId);
    if (!branch) {
      return {
        session: input.base,
        focus: {
          status: "missing",
          ref: input.expectedRef ?? "",
          workId: input.workId,
          reason: "task branch is missing",
        },
      };
    }
    const [task, state, assets, recentRuns, recentCommits] = await Promise.all([
      this.store.readTaskFile(input.sessionId, input.workId),
      this.store.readTaskState(input.sessionId, input.workId),
      this.store.readTaskAssets(input.sessionId, input.workId),
      this.store.readTaskRunSummaries(input.sessionId, input.workId, input.limits.runSummaryLimit),
      this.store.readTaskCommitLog(input.sessionId, input.workId, input.limits.commitLogLimit),
    ]);
    if (!task || !state) {
      return {
        session: input.base,
        focus: {
          status: "missing",
          ref: branch.ref,
          workId: input.workId,
          reason: "task branch is missing task.json or state.json",
        },
      };
    }
    return {
      session: input.base,
      focus: {
        status: "active",
        ref: branch.ref,
        workId: input.workId,
      },
      task: {
        ref: branch.ref,
        task,
        state,
        assets,
        recentRuns,
        recentCommits,
      },
    };
  }

  private async readSessionBase(
    sessionId: SessionId,
    limits: DailySessionContextLimits,
  ): Promise<DailySessionContext["session"]> {
    const [conversationTail, eventTail, assets] = await Promise.all([
      this.store.readSessionConversationTail(sessionId, limits.conversationTailLimit),
      this.store.readSessionEventsTail(sessionId, limits.eventTailLimit),
      this.store.readSessionAssets(sessionId),
    ]);
    return {
      sessionId,
      conversationTail,
      eventTail,
      assets,
    };
  }
}

export interface CompactCommitSummary {
  commit: string;
  subject: string;
  summary?: string;
  trailers: ParsedAyatiTrailers;
}

export function compactCommit(entry: TaskCommitLogEntry): CompactCommitSummary {
  const lines = entry.message.split(/\r?\n/);
  const subject = lines[0]?.trim() ?? "";
  const body = lines
    .slice(1)
    .join("\n")
    .split(/^Ayati-/m)[0]
    ?.trim();
  return {
    commit: entry.commit,
    subject,
    ...(body ? { summary: body } : {}),
    trailers: entry.trailers,
  };
}

function normalizeLimits(input: Partial<DailySessionContextLimits> | undefined): DailySessionContextLimits {
  return {
    conversationTailLimit: positiveLimit(input?.conversationTailLimit, DEFAULT_DAILY_SESSION_CONTEXT_LIMITS.conversationTailLimit),
    eventTailLimit: positiveLimit(input?.eventTailLimit, DEFAULT_DAILY_SESSION_CONTEXT_LIMITS.eventTailLimit),
    runSummaryLimit: positiveLimit(input?.runSummaryLimit, DEFAULT_DAILY_SESSION_CONTEXT_LIMITS.runSummaryLimit),
    commitLogLimit: positiveLimit(input?.commitLogLimit, DEFAULT_DAILY_SESSION_CONTEXT_LIMITS.commitLogLimit),
  };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return fallback;
  }
  return value;
}
