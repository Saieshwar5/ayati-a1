import { join } from "node:path";
import { GitDriver } from "../daily-session/git-driver.js";
import { renderGitMemoryCommitMessage } from "./commit-message.js";
import type {
  GitMemoryFocusFile,
  GitMemorySessionEventRecord,
  GitMemorySessionId,
  GitMemorySessionMetaFile,
  GitMemoryTaskIndexFile,
} from "./schema.js";
import {
  GIT_MEMORY_SESSION_CONVERSATION_PATH,
  GIT_MEMORY_SESSION_EVENTS_PATH,
  GIT_MEMORY_SESSION_FOCUS_PATH,
  GIT_MEMORY_SESSION_META_PATH,
  GIT_MEMORY_SESSION_SCHEMA_PATH,
  GIT_MEMORY_SESSION_TASKS_PATH,
  GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH,
  createGitMemoryEventId,
  createGitMemorySessionId,
} from "./schema.js";

export const GIT_MEMORY_MAIN_REF = "refs/heads/main";

export interface GitMemoryDailySessionStoreOptions {
  contextStoreDir: string;
  now?: () => Date;
}

export interface OpenGitMemoryDailySessionInput {
  date: string;
  timezone: string;
  agentId: string;
  createdAt?: string;
  sessionId?: GitMemorySessionId;
}

export interface GitMemoryDailySessionHandle {
  sessionId: GitMemorySessionId;
  repoPath: string;
  initialized: boolean;
  initialCommit?: string;
}

export class GitMemoryDailySessionStore {
  private readonly contextStoreDir: string;
  private readonly nowProvider: () => Date;

  constructor(options: GitMemoryDailySessionStoreOptions) {
    this.contextStoreDir = options.contextStoreDir;
    this.nowProvider = options.now ?? (() => new Date());
  }

  repoPath(sessionId: GitMemorySessionId): string {
    return join(this.contextStoreDir, "sessions", `${sessionId}.git`);
  }

  async openOrCreateDailySession(input: OpenGitMemoryDailySessionInput): Promise<GitMemoryDailySessionHandle> {
    const sessionId = input.sessionId ?? createGitMemorySessionId(input.date, input.agentId);
    const repoPath = this.repoPath(sessionId);
    const driver = await GitDriver.initBare(repoPath);
    if (await driver.hasRef(GIT_MEMORY_MAIN_REF)) {
      return { sessionId, repoPath, initialized: false };
    }

    const createdAt = input.createdAt ?? this.nowProvider().toISOString();
    const files = buildInitialSessionFiles({
      sessionId,
      date: input.date,
      timezone: input.timezone,
      agentId: input.agentId,
      createdAt,
    });
    const initialCommit = await driver.commitFiles({
      ref: GIT_MEMORY_MAIN_REF,
      files,
      message: renderGitMemoryCommitMessage({
        subject: `ayati: initialize session ${sessionId}`,
        summary: "Create the daily git-memory session repo and base memory files.",
        trailers: {
          sessionId,
          event: "session_initialized",
          at: createdAt,
          schemaVersion: 1,
        },
      }),
    });

    return { sessionId, repoPath, initialized: true, initialCommit };
  }
}

interface BuildInitialSessionFilesInput {
  sessionId: GitMemorySessionId;
  date: string;
  timezone: string;
  agentId: string;
  createdAt: string;
}

function buildInitialSessionFiles(input: BuildInitialSessionFilesInput): Record<string, string> {
  const meta: GitMemorySessionMetaFile = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    date: input.date,
    timezone: input.timezone,
    createdAt: input.createdAt,
    repoKind: "daily_session",
    agentId: input.agentId,
  };
  const initialized: GitMemorySessionEventRecord = {
    v: 1,
    seq: 1,
    eventId: createGitMemoryEventId(input.date, 1),
    type: "session_initialized",
    at: input.createdAt,
  };
  const focus: GitMemoryFocusFile = {
    schemaVersion: 1,
    activeTaskId: null,
    activeBranch: null,
    updatedAt: input.createdAt,
    reason: "session_initialized",
  };
  const tasks: GitMemoryTaskIndexFile = {
    schemaVersion: 1,
    tasks: [],
  };

  return {
    [GIT_MEMORY_SESSION_META_PATH]: prettyJson(meta),
    [GIT_MEMORY_SESSION_CONVERSATION_PATH]: "",
    [GIT_MEMORY_SESSION_EVENTS_PATH]: jsonl([initialized]),
    [GIT_MEMORY_SESSION_FOCUS_PATH]: prettyJson(focus),
    [GIT_MEMORY_SESSION_TASKS_PATH]: prettyJson(tasks),
    [GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH]: "",
    [GIT_MEMORY_SESSION_SCHEMA_PATH]: prettyJson({
      schemaVersion: 1,
      kind: "git_memory_session",
      sourceOfTruth: "git_files",
      commitPolicy: "checkpoint_boundaries",
    }),
  };
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonl<T>(records: T[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}
