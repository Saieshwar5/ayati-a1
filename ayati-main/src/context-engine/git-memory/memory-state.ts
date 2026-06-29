import type {
  CompactGitMemoryCommitSummary,
  GitMemoryContextLimits,
  GitMemoryFocusContext,
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
  GitMemorySessionEventRecord,
  GitMemorySessionId,
  GitMemoryTaskMessageLinkRecord,
} from "./schema.js";

export interface GitContextMemoryStateLimits extends GitMemoryContextLimits {
  evidenceLimit: number;
}

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
  recentCommits: CompactGitMemoryCommitSummary[];
  recentEvidence: GitMemoryEvidenceManifestRecord[];
}

export interface GitContextMemoryState {
  session: {
    sessionId: GitMemorySessionId;
    conversationTail: GitMemoryConversationRecord[];
    conversationMarkdownTail: string;
    eventTail: GitMemorySessionEventRecord[];
    taskMessageLinkTail: GitMemoryTaskMessageLinkRecord[];
    recentCommits: CompactGitMemoryCommitSummary[];
    taskCount: number;
    currentBranch?: string;
  };
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

    const recentEvidence = context.task
      ? (await this.store.readTaskDetail({
          sessionId: input.sessionId,
          taskId: context.task.taskId,
          include: ["evidence"],
          limits: input.limits?.evidenceLimit ? { evidenceLimit: input.limits.evidenceLimit } : undefined,
        })).recentEvidence ?? []
      : [];

    return {
      session: {
        sessionId: context.session.sessionId,
        conversationTail: context.session.conversationTail,
        conversationMarkdownTail: context.session.conversationMarkdownTail,
        eventTail: context.session.eventTail,
        taskMessageLinkTail: context.session.taskMessageLinkTail,
        recentCommits: context.session.recentCommits,
        taskCount: context.session.taskCount,
        ...(context.focus.status === "active" ? { currentBranch: context.focus.branch } : {}),
      },
      focus: context.focus,
      ...(context.task ? { activeTask: toActiveTask(context.task, recentEvidence) } : {}),
      knownTasks: routing.tasks.map(toKnownTask),
    };
  }
}

export function createGitContextMemoryStateHydrator(
  store: GitMemoryDailySessionStore,
): GitContextMemoryStateHydrator {
  return new GitContextMemoryStateHydrator(store);
}

function toActiveTask(
  task: NonNullable<Awaited<ReturnType<GitMemoryContextReader["buildActiveContext"]>>["task"]>,
  recentEvidence: GitMemoryEvidenceManifestRecord[],
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
    recentEvidence,
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
