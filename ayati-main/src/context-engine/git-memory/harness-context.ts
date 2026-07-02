import type {
  ContextCommitSummary,
  ContextConversationRecord,
  ContextEngineMachineContext,
  ContextPendingTurn,
  ContextPendingWrite,
  ContextSessionActivityRecord,
  ContextTaskFact,
  ContextTaskEvidenceSummary,
  ContextTaskRunSummary,
} from "../contracts.js";
import type {
  GitMemoryConversationRecord,
  GitMemoryEvidenceManifestRecord,
  GitMemoryRunFile,
  GitMemoryTaskId,
} from "./schema.js";
import type {
  GitMemoryCommitActivityRecord,
  GitMemoryFocusContext,
  GitMemoryMachineContextPack,
  GitMemoryModelCommitSummary,
  GitMemoryPendingTurnContext,
  GitMemoryPendingWriteContext,
} from "./context-pack.js";
import type { GitContextMemoryState } from "./memory-state.js";

export function buildGitMemoryHarnessContextPack(
  context: GitMemoryMachineContextPack,
): ContextEngineMachineContext {
  return {
    session: {
      sessionId: context.session.sessionId,
      conversationTail: (context.session.conversationTail ?? []).map(toConversationRecord),
      ...(context.session.conversationMarkdownTail ? { conversationMarkdownTail: context.session.conversationMarkdownTail } : {}),
      ...(context.session.summary ? { summary: context.session.summary } : {}),
      ...(context.session.attachments ? { attachments: context.session.attachments } : {}),
      activityTail: (context.session.activityTail ?? [])
        .map((activity) => toSessionActivityRecord(context.session.sessionId, activity))
        .filter(isSessionActivityRecord),
      recentCommits: (context.session.recentCommits ?? []).map(toCompactCommitSummary),
      assetCount: context.session.attachments?.count ?? 0,
    },
    ...(context.pendingWrites && context.pendingWrites.length > 0 ? {
      pendingWrites: context.pendingWrites.map(toPendingWrite),
    } : {}),
    ...(context.pendingTurn ? { pendingTurn: toPendingTurn(context.pendingTurn) } : {}),
    focus: toFocusContext(context.focus),
    ...(context.task ? {
      task: {
        ref: context.task.ref,
        workId: context.task.taskId,
        title: context.task.title,
        objective: context.task.objective,
        status: context.task.status,
        completed: context.task.completed ?? [],
        open: context.task.open ?? [],
        blockers: context.task.blockers ?? [],
        facts: (context.task.facts ?? []).map(toTaskFact),
        next: context.task.next,
        ...(context.task.conversationMarkdownTail ? { conversationMarkdownTail: context.task.conversationMarkdownTail } : {}),
        assets: context.task.assets ?? [],
        recentRuns: (context.task.recentRuns ?? []).map((run) => toTaskRunSummary(run, context.task!.taskId)),
        recentCommits: (context.task.recentCommits ?? []).map(toCompactCommitSummary),
        recentEvidence: (context.task.recentEvidence ?? []).map(toEvidenceSummary),
      },
    } : {}),
  };
}

export function buildGitMemoryHarnessContextFromMemoryState(
  state: GitContextMemoryState,
): ContextEngineMachineContext {
  return {
    session: {
      sessionId: state.session.sessionId,
      conversationTail: state.session.conversationTail.map(toConversationRecord),
      ...(state.session.conversationMarkdownTail ? { conversationMarkdownTail: state.session.conversationMarkdownTail } : {}),
      ...(state.session.summary ? { summary: state.session.summary } : {}),
      ...(state.session.attachments ? { attachments: state.session.attachments } : {}),
      activityTail: state.session.activityTail
        .map((activity) => toSessionActivityRecord(state.session.sessionId, activity))
        .filter(isSessionActivityRecord),
      recentCommits: state.session.recentCommits.map(toCompactCommitSummary),
      assetCount: state.session.attachments?.count ?? 0,
    },
    ...(state.pendingWrites.length > 0 ? {
      pendingWrites: state.pendingWrites.map(toPendingWrite),
    } : {}),
    ...(state.pendingTurn ? { pendingTurn: toPendingTurn(state.pendingTurn) } : {}),
    focus: toFocusContext(state.focus),
    ...(state.activeTask ? {
      task: {
        ref: state.activeTask.ref,
        workId: state.activeTask.taskId,
        title: state.activeTask.title,
        objective: state.activeTask.objective,
        status: state.activeTask.status,
        completed: state.activeTask.completed,
        open: state.activeTask.open,
        blockers: state.activeTask.blockers,
        facts: state.activeTask.facts.map(toTaskFact),
        next: state.activeTask.next,
        ...(state.activeTask.conversationMarkdownTail ? { conversationMarkdownTail: state.activeTask.conversationMarkdownTail } : {}),
        assets: state.activeTask.assets,
        recentRuns: state.activeTask.recentRuns.map((run) => toTaskRunSummary(run, state.activeTask!.taskId)),
        recentCommits: state.activeTask.recentCommits.map(toCompactCommitSummary),
        recentEvidence: state.activeTask.recentEvidence.map(toEvidenceSummary),
      },
    } : {}),
  };
}

function toPendingWrite(write: GitMemoryPendingWriteContext): ContextPendingWrite {
  return {
    id: write.id,
    type: write.type,
    label: write.label,
    status: write.status,
    createdAt: write.createdAt,
    ...(write.startedAt ? { startedAt: write.startedAt } : {}),
    ...(write.failedAt ? { failedAt: write.failedAt } : {}),
    ...(write.error ? { error: write.error } : {}),
  };
}

function toPendingTurn(turn: GitMemoryPendingTurnContext): ContextPendingTurn {
  return {
    fromSeq: turn.fromSeq,
    toSeq: turn.toSeq,
    text: turn.text,
    at: turn.at,
    routingStatus: turn.routingStatus,
    ...(turn.taskId ? { workId: turn.taskId } : {}),
    ...(turn.branch ? { branch: turn.branch } : {}),
    ...(turn.runId ? { runId: turn.runId } : {}),
  };
}

function toConversationRecord(record: GitMemoryConversationRecord): ContextConversationRecord {
  return {
    seq: record.seq,
    role: record.role,
    at: record.at,
    text: record.text ?? "",
  };
}

function toSessionActivityRecord(
  sessionId: string,
  activity: GitMemoryCommitActivityRecord,
): ContextSessionActivityRecord | null {
  if (activity.type === "session_initialized") {
    return {
      seq: activity.seq,
      type: "session_started",
      at: activity.at,
      sessionId,
    };
  }
  if (activity.type === "task_created" && activity.taskId && activity.branch) {
    return {
      seq: activity.seq,
      type: "task_branch_created",
      at: activity.at,
      workId: activity.taskId,
      branch: activity.branch,
      ref: branchRef(activity.branch),
    };
  }
  if (activity.type === "run_started" && activity.runId && activity.taskId) {
    return {
      seq: activity.seq,
      type: "run_started",
      at: activity.at,
      runId: activity.runId,
      workId: activity.taskId,
    };
  }
  if ((activity.type === "run_completed" || activity.type === "run_failed") && activity.runId && activity.taskId) {
    return {
      seq: activity.seq,
      type: "run_committed",
      at: activity.at,
      runId: activity.runId,
      workId: activity.taskId,
      commit: activity.commit ?? "",
    };
  }
  if (activity.type === "session_closed") {
    return {
      seq: activity.seq,
      type: "session_closed",
      at: activity.at,
      reason: activity.reason,
    };
  }
  return null;
}

function isSessionActivityRecord(
  activity: ContextSessionActivityRecord | null,
): activity is ContextSessionActivityRecord {
  return activity !== null;
}

function toFocusContext(focus: GitMemoryFocusContext): ContextEngineMachineContext["focus"] {
  if (focus.status === "none") {
    return { status: "none" };
  }
  if (focus.status === "active") {
    return {
      status: "active",
      ref: focus.ref,
      workId: focus.taskId,
    };
  }
  return {
    status: "missing",
    ref: focus.ref ?? (focus.branch ? branchRef(focus.branch) : "refs/heads/missing"),
    ...(focus.taskId ? { workId: focus.taskId } : {}),
    reason: focus.reason,
  };
}

function toTaskFact(fact: string): ContextTaskFact {
  return {
    text: fact,
    source: "git-memory/task-state",
  };
}

function toTaskRunSummary(run: GitMemoryRunFile, taskId: GitMemoryTaskId): ContextTaskRunSummary {
  return {
    schemaVersion: 1,
    runId: run.runId,
    workId: taskId,
    status: run.status,
    summary: run.summary,
    completed: [],
    open: run.next ? [run.next] : [],
    actions: [],
    createdAt: run.completedAt ?? run.startedAt,
  };
}

function toCompactCommitSummary(commit: GitMemoryModelCommitSummary): ContextCommitSummary {
  return {
    commit: commit.commit,
    subject: commit.subject,
    ...(commit.summary ? { summary: commit.summary } : {}),
    ...(commit.event ? { event: commit.event } : {}),
    ...(commit.status ? { status: commit.status } : {}),
    ...(commit.at ? { at: commit.at } : {}),
    ...(commit.taskId ? { workId: commit.taskId } : {}),
    ...(commit.runId ? { runId: commit.runId } : {}),
    ...(commit.branch ? { branch: commit.branch } : {}),
  };
}

function toEvidenceSummary(record: GitMemoryEvidenceManifestRecord): ContextTaskEvidenceSummary {
  return {
    runId: record.runId,
    workId: record.taskId,
    ...(record.step ? { step: record.step } : {}),
    ...(record.actionId ? { actionId: record.actionId } : {}),
    tool: record.tool,
    ...(record.status ? { status: record.status } : {}),
    summary: record.summary,
    ...(record.evidenceRef ? { evidenceRef: record.evidenceRef } : {}),
    artifacts: record.artifacts,
    facts: record.facts,
    accessModes: record.accessModes,
    ...(record.outputSize !== undefined ? { outputSize: record.outputSize } : {}),
    ...(record.lineCount !== undefined ? { lineCount: record.lineCount } : {}),
    ...(record.truncated !== undefined ? { truncated: record.truncated } : {}),
    ...(record.source ? { source: record.source } : {}),
  };
}

function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}
