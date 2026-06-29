import type {
  ContextCommitSummary,
  ContextConversationRecord,
  ContextEngineMachineContext,
  ContextSessionEventRecord,
  ContextTaskFact,
  ContextTaskEvidenceSummary,
  ContextTaskRunSummary,
  TaskAssetRecord,
} from "../contracts.js";
import type {
  GitMemoryConversationRecord,
  GitMemoryEvidenceManifestRecord,
  GitMemoryRunFile,
  GitMemorySessionEventRecord,
  GitMemoryTaskId,
} from "./schema.js";
import type {
  CompactGitMemoryCommitSummary,
  GitMemoryFocusContext,
  GitMemoryMachineContextPack,
} from "./context-pack.js";
import type { GitContextMemoryState } from "./memory-state.js";

export function buildGitMemoryHarnessContextPack(
  context: GitMemoryMachineContextPack,
): ContextEngineMachineContext {
  return {
    session: {
      sessionId: context.session.sessionId,
      conversationTail: context.session.conversationTail.map(toConversationRecord),
      ...(context.session.conversationMarkdownTail ? { conversationMarkdownTail: context.session.conversationMarkdownTail } : {}),
      eventTail: context.session.eventTail
        .map((event) => toSessionEventRecord(context.session.sessionId, event))
        .filter(isSessionEventRecord),
      assetCount: 0,
    },
    focus: toFocusContext(context.focus),
    ...(context.task ? {
      task: {
        ref: context.task.ref,
        workId: context.task.taskId,
        title: context.task.title,
        objective: context.task.objective,
        status: context.task.status,
        completed: context.task.completed,
        open: context.task.open,
        blockers: context.task.blockers,
        facts: context.task.facts.map(toTaskFact),
        next: context.task.next,
        ...(context.task.conversationMarkdownTail ? { conversationMarkdownTail: context.task.conversationMarkdownTail } : {}),
        assets: [] satisfies TaskAssetRecord[],
        recentRuns: context.task.recentRuns.map((run) => toTaskRunSummary(run, context.task!.taskId)),
        recentCommits: context.task.recentCommits.map(toCompactCommitSummary),
        recentEvidence: [],
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
      eventTail: state.session.eventTail
        .map((event) => toSessionEventRecord(state.session.sessionId, event))
        .filter(isSessionEventRecord),
      assetCount: 0,
    },
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
        assets: [] satisfies TaskAssetRecord[],
        recentRuns: state.activeTask.recentRuns.map((run) => toTaskRunSummary(run, state.activeTask!.taskId)),
        recentCommits: state.activeTask.recentCommits.map(toCompactCommitSummary),
        recentEvidence: state.activeTask.recentEvidence.map(toEvidenceSummary),
      },
    } : {}),
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

function toSessionEventRecord(
  sessionId: string,
  event: GitMemorySessionEventRecord,
): ContextSessionEventRecord | null {
  if (event.type === "session_initialized") {
    return {
      seq: event.seq,
      type: "session_started",
      at: event.at,
      sessionId,
    };
  }
  if (event.type === "task_created" && event.taskId && event.branch) {
    return {
      seq: event.seq,
      type: "task_branch_created",
      at: event.at,
      workId: event.taskId,
      branch: event.branch,
      ref: branchRef(event.branch),
    };
  }
  if (event.type === "focus_changed" && event.branch) {
    return {
      seq: event.seq,
      type: "focus_changed",
      at: event.at,
      to: branchRef(event.branch),
    };
  }
  if (event.type === "run_started" && event.runId && event.taskId) {
    return {
      seq: event.seq,
      type: "run_started",
      at: event.at,
      runId: event.runId,
      workId: event.taskId,
    };
  }
  if ((event.type === "run_completed" || event.type === "run_failed") && event.runId && event.taskId) {
    return {
      seq: event.seq,
      type: "run_committed",
      at: event.at,
      runId: event.runId,
      workId: event.taskId,
      commit: event.commit ?? "",
    };
  }
  if (event.type === "session_closed") {
    return {
      seq: event.seq,
      type: "session_closed",
      at: event.at,
      reason: event.reason,
    };
  }
  return null;
}

function isSessionEventRecord(event: ContextSessionEventRecord | null): event is ContextSessionEventRecord {
  return event !== null;
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

function toCompactCommitSummary(commit: CompactGitMemoryCommitSummary): ContextCommitSummary {
  return {
    commit: commit.commit,
    subject: commit.subject,
    ...(commit.summary ? { summary: commit.summary } : {}),
    trailers: commit.trailers,
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
  };
}

function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}
