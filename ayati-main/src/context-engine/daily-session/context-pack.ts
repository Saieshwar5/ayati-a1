import type { ConversationRecord, SessionEventRecord } from "./session-files.js";
import type { TaskAssetRecord, TaskRunSummaryFile } from "./task-files.js";
import type { DailySessionContext, FocusContext } from "./context-reader.js";
import { compactCommit, type CompactCommitSummary } from "./context-reader.js";

export interface DailySessionMachineContextPack {
  session: {
    sessionId: string;
    conversationTail: ConversationRecord[];
    eventTail: SessionEventRecord[];
    assetCount: number;
  };
  focus: FocusContext;
  task?: {
    ref: string;
    workId: string;
    title: string;
    objective: string;
    status: string;
    completed: string[];
    open: string[];
    blockers: string[];
    facts: Array<{ text: string; source: string }>;
    next?: string;
    assets: TaskAssetRecord[];
    recentRuns: TaskRunSummaryFile[];
    recentCommits: CompactCommitSummary[];
  };
}

export function buildDailySessionMachineContextPack(context: DailySessionContext): DailySessionMachineContextPack {
  return {
    session: {
      sessionId: context.session.sessionId,
      conversationTail: context.session.conversationTail,
      eventTail: context.session.eventTail,
      assetCount: context.session.assets.length,
    },
    focus: context.focus,
    ...(context.task ? {
      task: {
        ref: context.task.ref,
        workId: context.task.task.workId,
        title: context.task.task.title,
        objective: context.task.task.objective,
        status: context.task.state.status,
        completed: context.task.state.completed,
        open: context.task.state.open,
        blockers: context.task.state.blockers ?? [],
        facts: context.task.state.facts,
        ...(context.task.state.next ? { next: context.task.state.next } : {}),
        assets: context.task.assets,
        recentRuns: context.task.recentRuns,
        recentCommits: context.task.recentCommits.map(compactCommit),
      },
    } : {}),
  };
}
