import type {
  ActiveContext,
} from "ayati-git-context";
import { isAbsolute, resolve } from "node:path";
import type {
  ContextCommitSummary,
  ContextConversationRecord,
  ContextEngineMachineContext,
} from "./contracts.js";

export function buildContextEngineProjection(
  active: ActiveContext,
): ContextEngineMachineContext {
  if (!active.session) return emptyProjection();

  const activeWorkstream = active.activeWorkstream;
  const run = active.run?.run;
  const workstreamBound = Boolean(
    activeWorkstream
      && run?.workstreamBinding?.workstreamId === activeWorkstream.workstream.workstreamId,
  );

  return {
    session: {
      meta: {
        sessionId: active.session.session.sessionId,
        date: active.session.session.date,
        timezone: active.session.session.timezone,
        repoKind: "daily_session",
        resourceCount: active.session.resources?.count ?? 0,
      },
      conversationTail: conversationRecords(active),
      summary: { text: active.session.summary },
      activityTail: [],
      recentCommits: active.session.recentCommits.map(commitSummary),
    },
    focus: workstreamBound && activeWorkstream
      ? {
          status: "active",
          ref: "refs/heads/" + activeWorkstream.workstream.branch,
          workstreamId: activeWorkstream.workstream.workstreamId,
        }
      : { status: "none" },
    ...(active.readContext ? { readContext: active.readContext } : {}),
    workstreamCandidates: active.workstreamCandidates ?? [],
    ingressResources: active.ingressResources ?? [],
    ...(workstreamBound && activeWorkstream
      ? {
          pendingTurn: {
            fromSeq: currentConversationSequence(active),
            toSeq: currentConversationSequence(active),
            text: latestInputText(active),
            at: latestInputAt(active),
            routingStatus: "bound" as const,
            workstreamId: activeWorkstream.workstream.workstreamId,
            branch: activeWorkstream.workstream.branch,
            runId: run!.runId,
          },
          workstream: {
            contextRepositoryPath: activeWorkstream.workstream.contextRepositoryPath,
            ref: "refs/heads/" + activeWorkstream.workstream.branch,
            workstreamId: activeWorkstream.workstream.workstreamId,
            title: activeWorkstream.title,
            objective: activeWorkstream.objective,
            summary: activeWorkstream.summary,
            workstreamStatus: activeWorkstream.workstreamStatus
              ?? (activeWorkstream.latestOutcome === "done"
                ? "done"
                : activeWorkstream.latestOutcome === "blocked"
                  ? "blocked"
                  : "in_progress"),
            lifecycleStatus: activeWorkstream.lifecycleStatus ?? "active",
            repositoryHealth: activeWorkstream.repositoryHealth ?? "ready",
            ...(activeWorkstream.currentFocus ? { currentFocus: activeWorkstream.currentFocus } : {}),
            blockers: activeWorkstream.blockers ?? [],
            ...(activeWorkstream.next ? { next: activeWorkstream.next } : {}),
            ...(activeWorkstream.currentRequest ? { currentRequest: activeWorkstream.currentRequest } : {}),
            resources: activeWorkstream.resources ?? [],
            recentCommits: activeWorkstream.recentCommits.map(commitSummary),
          },
        }
      : {}),
  };
}

function emptyProjection(): ContextEngineMachineContext {
  return {
    session: {
      meta: { sessionId: "unavailable", resourceCount: 0 },
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
    })),
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

function commitSummary(
  commit: NonNullable<ActiveContext["session"]>["recentCommits"][number],
): ContextCommitSummary {
  const resources = (commit.assets ?? []).flatMap((asset) => {
    if (isAbsolute(asset.path)) return [{ ...asset, path: resolve(asset.path) }];
    return [];
  });
  return {
    commit: commit.commit,
    subject: commit.subject,
    ...(commit.conversationSummary ? { conversationSummary: commit.conversationSummary } : {}),
    ...(commit.workSummary ? { workSummary: commit.workSummary } : {}),
    ...(resources.length > 0 ? { resources } : {}),
    ...(commit.outcome ? { outcome: commit.outcome } : {}),
    ...(commit.validation ? { validation: commit.validation } : {}),
    ...(commit.committedAt ? { at: commit.committedAt } : {}),
    ...(commit.workstreamId ? { workstreamId: commit.workstreamId } : {}),
    ...(commit.runId ? { runId: commit.runId } : {}),
  };
}
