import type {
  GitMemoryContextLimits,
  GitMemoryCommitActivityRecord,
  GitMemoryFocusContext,
  GitMemoryMachineContextPack,
  GitMemoryModelCommitSummary,
  GitMemoryPendingWriteContext,
} from "./context-pack.js";
import type { TaskAssetRecord } from "../contracts.js";
import { GitMemoryContextReader } from "./context-pack.js";
import type {
  GitMemoryDailySessionStore,
  GitMemoryTaskRoutingSnapshotTask,
} from "./session-store.js";
import type {
  GitMemoryConversationRecord,
  GitMemoryEvidenceManifestRecord,
  GitMemoryRunFile,
  GitMemorySessionId,
} from "./schema.js";
import type { GitMemoryWriteBatchSnapshot } from "./write-queue.js";

export type GitContextMemoryStateLimits = GitMemoryContextLimits;

export interface GitContextMemoryKnownTask {
  taskId: string;
  branch: string;
  ref: string;
  title: string;
  objective: string;
  status: string;
  summary: string;
  open: string[];
  blockers: string[];
  facts: string[];
  next: string;
  missing?: boolean;
}

export interface GitContextMemoryActiveTask extends GitContextMemoryKnownTask {
  completed: string[];
  assets: TaskAssetRecord[];
  conversationMarkdownTail: string;
  recentRuns: GitMemoryRunFile[];
  recentCommits: GitMemoryModelCommitSummary[];
  recentEvidence: GitMemoryEvidenceManifestRecord[];
}

export interface GitContextMemoryState {
  session: {
    sessionId: GitMemorySessionId;
    conversationTail: GitMemoryConversationRecord[];
    conversationMarkdownTail: string;
    activityTail: GitMemoryCommitActivityRecord[];
    recentCommits: GitMemoryModelCommitSummary[];
    taskCount: number;
    currentBranch?: string;
  };
  pendingWrites: GitMemoryPendingWriteContext[];
  focus: GitMemoryFocusContext;
  activeTask?: GitContextMemoryActiveTask;
  knownTasks: GitContextMemoryKnownTask[];
}

export class GitContextMemoryStateHydrator {
  private readonly contextReader: GitMemoryContextReader;

  constructor(private readonly store: GitMemoryDailySessionStore) {
    this.contextReader = new GitMemoryContextReader(store);
  }

  async hydrate(input: {
    sessionId: GitMemorySessionId;
    limits?: Partial<GitContextMemoryStateLimits>;
  }): Promise<GitContextMemoryState> {
    const [context, routing] = await Promise.all([
      this.contextReader.buildActiveContext({
        sessionId: input.sessionId,
        limits: input.limits,
      }),
      this.store.readTaskRoutingSnapshot(input.sessionId),
    ]);

    return {
      session: {
        sessionId: context.session.sessionId,
        conversationTail: context.session.conversationTail,
        conversationMarkdownTail: context.session.conversationMarkdownTail,
        activityTail: context.session.activityTail,
        recentCommits: context.session.recentCommits,
        taskCount: context.session.taskCount,
        ...(context.focus.status === "active" ? { currentBranch: context.focus.branch } : {}),
      },
      pendingWrites: [],
      focus: context.focus,
      ...(context.task ? { activeTask: toActiveTask(context.task) } : {}),
      knownTasks: routing.tasks.map(toKnownTask),
    };
  }
}

export function createGitContextMemoryStateHydrator(
  store: GitMemoryDailySessionStore,
): GitContextMemoryStateHydrator {
  return new GitContextMemoryStateHydrator(store);
}

export function buildGitMemoryContextPackFromMemoryState(
  state: GitContextMemoryState,
): GitMemoryMachineContextPack {
  return {
    session: {
      sessionId: state.session.sessionId,
      conversationTail: state.session.conversationTail,
      conversationMarkdownTail: state.session.conversationMarkdownTail,
      activityTail: state.session.activityTail,
      recentCommits: state.session.recentCommits,
      taskCount: state.session.taskCount,
    },
    ...(state.pendingWrites.length > 0 ? { pendingWrites: state.pendingWrites } : {}),
    focus: state.focus,
    ...(state.activeTask ? {
      task: {
        ref: state.activeTask.ref,
        taskId: state.activeTask.taskId,
        branch: state.activeTask.branch,
        title: state.activeTask.title,
        objective: state.activeTask.objective,
        status: state.activeTask.status,
        summary: state.activeTask.summary,
        completed: state.activeTask.completed,
        open: state.activeTask.open,
        blockers: state.activeTask.blockers,
        facts: state.activeTask.facts,
        next: state.activeTask.next,
        assets: state.activeTask.assets,
        conversationMarkdownTail: state.activeTask.conversationMarkdownTail,
        recentRuns: state.activeTask.recentRuns,
        recentEvidence: state.activeTask.recentEvidence,
        recentCommits: state.activeTask.recentCommits,
      },
    } : {}),
  };
}

export function buildGitContextPendingWrites(
  writes: GitMemoryWriteBatchSnapshot[],
): GitMemoryPendingWriteContext[] {
  return writes
    .filter(isPendingWrite)
    .map((write) => ({
      id: write.id,
      type: write.type,
      label: write.label,
      status: write.status,
      createdAt: write.createdAt,
      ...(write.startedAt ? { startedAt: write.startedAt } : {}),
      ...(write.failedAt ? { failedAt: write.failedAt } : {}),
      ...(write.error ? { error: write.error } : {}),
    }));
}

function isPendingWrite(
  write: GitMemoryWriteBatchSnapshot,
): write is GitMemoryWriteBatchSnapshot & { status: GitMemoryPendingWriteContext["status"] } {
  return write.status !== "committed";
}

function toActiveTask(
  task: NonNullable<Awaited<ReturnType<GitMemoryContextReader["buildActiveContext"]>>["task"]>,
): GitContextMemoryActiveTask {
  return {
    taskId: task.taskId,
    branch: task.branch,
    ref: task.ref,
    title: task.title,
    objective: task.objective,
    status: task.status,
    summary: task.summary,
    completed: task.completed,
    assets: task.assets,
    conversationMarkdownTail: task.conversationMarkdownTail,
    open: task.open,
    blockers: task.blockers,
    facts: task.facts,
    next: task.next,
    recentRuns: task.recentRuns,
    recentCommits: task.recentCommits,
    recentEvidence: task.recentEvidence,
  };
}

function toKnownTask(task: GitMemoryTaskRoutingSnapshotTask): GitContextMemoryKnownTask {
  return {
    taskId: task.taskId,
    branch: task.branch,
    ref: task.ref,
    title: task.title,
    objective: task.objective,
    status: task.status,
    summary: task.summary,
    open: task.open,
    blockers: task.blockers,
    facts: task.facts,
    next: task.next,
    ...(task.missing ? { missing: true } : {}),
  };
}
