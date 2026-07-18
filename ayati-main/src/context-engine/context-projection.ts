import type { ActiveContext } from "ayati-git-context";
import { basename, isAbsolute, resolve } from "node:path";
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
  const taskWorkingDirectories = new Map(
    (active.taskCandidates ?? []).map((task) => [task.taskId, task.workingDirectory]),
  );
  if (activeTask) taskWorkingDirectories.set(activeTask.task.taskId, activeTask.workingDirectory);
  return {
    session: {
      meta: {
        sessionId: active.session.session.sessionId,
        date: active.session.session.date,
        timezone: active.session.session.timezone,
        repoKind: "daily_session",
        assetCount: active.session.attachments?.count ?? 0,
      },
      conversationTail,
      summary: {
        text: active.session.summary,
      },
      activityTail: [],
      recentCommits: active.session.recentCommits.map((commit) =>
        commitSummary(commit, commit.taskId ? taskWorkingDirectories.get(commit.taskId) : undefined)),
      ...(active.session.attachments ? { attachments: active.session.attachments } : {}),
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
      status: task.status,
      ...(task.lifecycleStatus ? { lifecycleStatus: task.lifecycleStatus } : {}),
      ...(task.repositoryHealth ? { repositoryHealth: task.repositoryHealth } : {}),
      ...(task.currentRequest ? { currentRequest: task.currentRequest } : {}),
      head: task.head,
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
            recentCommits: activeTask.recentCommits.map((commit) =>
              commitSummary(commit, activeTask.workingDirectory)),
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
  : never, workingDirectory?: string): ContextCommitSummary {
  const assets = (commit.assets ?? []).flatMap((asset) => {
    if (isAbsolute(asset.path)) return [{ ...asset, path: resolve(asset.path) }];
    if (workingDirectory) return [{ ...asset, path: resolve(workingDirectory, asset.path) }];
    return [];
  });
  return {
    commit: commit.commit,
    subject: commit.subject,
    ...(commit.conversationSummary ? { conversationSummary: commit.conversationSummary } : {}),
    ...(commit.workSummary ? { workSummary: commit.workSummary } : {}),
    ...(assets.length > 0 ? { assets } : {}),
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
    assetId: task.task.taskId + ":" + resolve(task.workingDirectory, path),
    role: "output",
    kind: path === "." ? "directory" : "file",
    name: path === "." ? basename(task.workingDirectory) : basename(path),
    description: path === "." ? "Task repository checkout" : "Task-owned file",
    path: resolve(task.workingDirectory, path),
  }));
}
