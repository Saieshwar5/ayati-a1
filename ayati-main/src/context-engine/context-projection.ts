import type { ActiveContext } from "ayati-git-context";
import type {
  ContextCommitSummary,
  ContextEngineMachineContext,
  ContextConversationRecord,
  TaskAssetRecord,
} from "./contracts.js";

export function buildContextEngineProjection(
  active: ActiveContext,
): ContextEngineMachineContext {
  if (!active.session) {
    return emptyProjection();
  }
  const conversationTail = conversationRecords(active);
  const activeTask = active.activeTask;
  const run = active.run?.run;
  const taskBound = Boolean(activeTask && run?.runClass === "task" && run.taskId === activeTask.task.taskId);
  return {
    session: {
      meta: {
        sessionId: active.session.session.sessionId,
        date: active.session.session.date,
        timezone: active.session.session.timezone,
        repoKind: "daily_session",
        assetCount: 0,
      },
      conversationTail,
      summary: {
        text: active.session.summary,
      },
      activityTail: [],
      recentCommits: active.session.recentCommits.map(commitSummary),
    },
    focus: taskBound && activeTask
      ? {
          status: "active",
          ref: "refs/heads/" + activeTask.task.branch,
          workId: activeTask.task.taskId,
        }
      : { status: "none" },
    ...(active.readContext && active.readContext.entries.length > 0
      ? { readContext: active.readContext }
      : {}),
    taskCandidates: (active.taskCandidates ?? []).map((task) => ({
      taskId: task.taskId,
      title: task.title,
      objective: task.objective,
      workingDirectory: task.workingDirectory,
      updatedAt: task.updatedAt,
    })),
    ...(taskBound && activeTask
      ? {
          pendingTurn: {
            fromSeq: currentConversationSequence(active),
            toSeq: currentConversationSequence(active),
            text: latestInputText(active),
            at: latestInputAt(active),
            routingStatus: "bound" as const,
            workId: activeTask.task.taskId,
            branch: activeTask.task.branch,
            runId: run!.runId,
          },
          task: {
            ...(activeTask.checkoutPath ? { checkoutPath: activeTask.checkoutPath } : {}),
            workingDirectory: activeTask.workingDirectory,
            ref: "refs/heads/" + activeTask.task.branch,
            workId: activeTask.task.taskId,
            title: activeTask.title,
            objective: activeTask.objective,
            status: activeTask.latestOutcome ?? "in_progress",
            completed: activeTask.latestOutcome === "done" ? [activeTask.summary] : [],
            open: activeTask.latestOutcome === "done" ? [] : [activeTask.summary],
            blockers: activeTask.latestOutcome === "blocked" ? [activeTask.summary] : [],
            facts: [],
            next: activeTask.latestOutcome === "done" ? undefined : activeTask.summary,
            assets: taskAssets(activeTask),
            recentRuns: [],
            recentCommits: activeTask.recentCommits.map(commitSummary),
            recentEvidence: [],
          },
        }
      : {}),
  };
}

function emptyProjection(): ContextEngineMachineContext {
  return {
    session: {
      meta: { sessionId: "unavailable", assetCount: 0 },
      conversationTail: [],
      activityTail: [],
    },
    focus: { status: "none" },
  };
}

function conversationRecords(active: ActiveContext): ContextConversationRecord[] {
  return (active.session?.pendingConversationContext ?? []).flatMap((context) =>
    context.messages.map((message) => ({
      seq: message.sessionSequence,
      messageId: message.messageId,
      conversationId: message.conversationId,
      conversationSequence: context.conversation.sequence,
      segmentSequence: message.segmentSequence,
      role: message.role === "system_event" ? "system" as const : message.role,
      at: message.at,
      text: message.content,
    }))
  );
}

function currentConversationSequence(active: ActiveContext): number {
  return active.session?.pendingConversation.at(-1)?.sequence ?? 1;
}

function latestInputText(active: ActiveContext): string {
  const messages = active.session?.pendingConversationContext.at(-1)?.messages ?? [];
  return [...messages].reverse().find((message) => message.role !== "assistant")?.content ?? "";
}

function latestInputAt(active: ActiveContext): string {
  const messages = active.session?.pendingConversationContext.at(-1)?.messages ?? [];
  return [...messages].reverse().find((message) => message.role !== "assistant")?.at
    ?? new Date(0).toISOString();
}

function commitSummary(commit: ActiveContext["session"] extends infer _T
  ? NonNullable<ActiveContext["session"]>["recentCommits"][number]
  : never): ContextCommitSummary {
  return {
    commit: commit.commit,
    subject: commit.subject,
    ...(commit.conversationSummary ? { conversationSummary: commit.conversationSummary } : {}),
    ...(commit.workSummary ? { workSummary: commit.workSummary } : {}),
    ...(commit.assets ? { assets: commit.assets } : {}),
    ...(commit.outcome ? { outcome: commit.outcome } : {}),
    ...(commit.validation ? { validation: commit.validation } : {}),
    ...(commit.committedAt ? { at: commit.committedAt } : {}),
    ...(commit.taskId ? { workId: commit.taskId } : {}),
    ...(commit.runId ? { runId: commit.runId } : {}),
  };
}

function taskAssets(task: NonNullable<ActiveContext["activeTask"]>): TaskAssetRecord[] {
  const paths = task.importantPaths.length > 0 ? task.importantPaths : ["."];
  return paths.map((path) => ({
    assetId: task.task.taskId + ":" + path,
    role: "output",
    kind: path === "." ? "directory" : "file",
    name: path,
    description: path === "." ? "Task repository checkout" : "Task-owned file",
    path,
  }));
}
