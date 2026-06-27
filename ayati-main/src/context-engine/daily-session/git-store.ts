import { join } from "node:path";
import type {
  RunId,
  SessionId,
  WorkId,
} from "./ids.js";
import {
  isSessionId,
  isWorkId,
} from "./ids.js";
import {
  FOCUS_CURRENT_REF,
  MAIN_BRANCH_REF,
  buildRunRef,
  buildWorkBranchName,
  buildWorkBranchRef,
  parseWorkBranchRef,
  type GitRef,
  type WorkBranchName,
} from "./refs.js";
import type {
  ConversationRecord,
  SessionAssetRecord,
  SessionEventRecord,
  SessionMetaFile,
} from "./session-files.js";
import {
  SESSION_ASSETS_PATH,
  SESSION_CONVERSATION_PATH,
  SESSION_EVENTS_PATH,
  SESSION_META_PATH,
} from "./session-files.js";
import type {
  TaskAssetRecord,
  TaskFile,
  TaskOutputFile,
  TaskRunSummaryFile,
  TaskStateFile,
} from "./task-files.js";
import {
  taskActionFilePath,
  taskActionOutputPath,
  taskAssetsPath,
  taskFilePath,
  taskFinalOutputPath,
  taskRunSummaryPath,
  taskStatePath,
} from "./task-files.js";
import type { ToolActionFile } from "./action-files.js";
import {
  parseAyatiCommitTrailers,
  renderAyatiCommitMessage,
  type ParsedAyatiTrailers,
} from "./commit-message.js";
import { GitDriver } from "./git-driver.js";

export interface DailySessionGitStoreOptions {
  contextStoreDir: string;
  now?: () => Date;
}

export interface DailySessionHandle {
  sessionId: SessionId;
  repoPath: string;
}

export interface AppendConversationInput {
  sessionId: SessionId;
  role: ConversationRecord["role"];
  text: string;
  at?: string;
}

export interface RegisterAssetInput {
  sessionId: SessionId;
  asset: SessionAssetRecord;
}

export interface CreateTaskBranchInput {
  sessionId: SessionId;
  workId: WorkId;
  title: string;
  objective: string;
  status?: TaskFile["status"];
  createdAt?: string;
  state?: Omit<TaskStateFile, "schemaVersion" | "workId" | "status"> & {
    status?: TaskStateFile["status"];
  };
  assets?: TaskAssetRecord[];
}

export interface CreateTaskBranchResult {
  workId: WorkId;
  branch: WorkBranchName;
  ref: GitRef;
  taskCommit: string;
  sessionCommit: string;
}

export interface UpdateFocusResult {
  ref: GitRef;
  sessionCommit: string;
}

export interface RunActionWrite {
  action: ToolActionFile;
  output?: string;
  outputExtension?: string;
}

export interface CommitRunInput {
  sessionId: SessionId;
  workId: WorkId;
  runId: RunId;
  state: TaskStateFile;
  runSummary: TaskRunSummaryFile;
  actions: RunActionWrite[];
  taskAssets?: TaskAssetRecord[];
  finalOutput?: TaskOutputFile;
  commitSummary?: string;
  completed?: string[];
  open?: string[];
  status?: string;
  at?: string;
}

export interface CommitRunResult {
  workCommit: string;
  sessionCommit: string;
  runRef: GitRef;
}

export interface TaskBranchInfo {
  workId: WorkId;
  ref: GitRef;
  branch: WorkBranchName;
  slug: string;
  commit: string;
}

export interface TaskCommitLogEntry {
  commit: string;
  message: string;
  trailers: ParsedAyatiTrailers;
}

export class DailySessionGitStore {
  private readonly contextStoreDir: string;
  private readonly nowProvider: () => Date;

  constructor(options: DailySessionGitStoreOptions) {
    this.contextStoreDir = options.contextStoreDir;
    this.nowProvider = options.now ?? (() => new Date());
  }

  repoPath(sessionId: SessionId): string {
    assertSessionId(sessionId);
    return join(this.contextStoreDir, "sessions", `${sessionId}.git`);
  }

  async openOrCreateSession(input: { sessionId: SessionId; timezone: string; createdAt?: string }): Promise<DailySessionHandle> {
    assertSessionId(input.sessionId);
    const driver = await this.driver(input.sessionId);
    if (!(await driver.hasRef(MAIN_BRANCH_REF))) {
      const createdAt = input.createdAt ?? this.nowIso();
      const meta: SessionMetaFile = {
        schemaVersion: 1,
        sessionId: input.sessionId,
        date: input.sessionId,
        timezone: input.timezone,
        createdAt,
      };
      const started: SessionEventRecord = {
        seq: 1,
        type: "session_started",
        at: createdAt,
        sessionId: input.sessionId,
      };
      await driver.commitFiles({
        ref: MAIN_BRANCH_REF,
        files: {
          [SESSION_META_PATH]: prettyJson(meta),
          [SESSION_CONVERSATION_PATH]: "",
          [SESSION_ASSETS_PATH]: "",
          [SESSION_EVENTS_PATH]: `${JSON.stringify(started)}\n`,
        },
        message: renderAyatiCommitMessage({
          subject: `open session ${input.sessionId}`,
          trailers: {
            sessionId: input.sessionId,
            event: "session_started",
            at: createdAt,
          },
        }),
      });
    }
    return { sessionId: input.sessionId, repoPath: this.repoPath(input.sessionId) };
  }

  async appendConversation(input: AppendConversationInput): Promise<{ record: ConversationRecord; commit: string }> {
    const driver = await this.driver(input.sessionId);
    const record: ConversationRecord = {
      seq: await this.nextJsonlSeq(driver, MAIN_BRANCH_REF, SESSION_CONVERSATION_PATH),
      role: input.role,
      at: input.at ?? this.nowIso(),
      text: input.text,
    };
    const content = await appendJsonl(driver, MAIN_BRANCH_REF, SESSION_CONVERSATION_PATH, record);
    const commit = await driver.commitFiles({
      ref: MAIN_BRANCH_REF,
      files: { [SESSION_CONVERSATION_PATH]: content },
      message: renderAyatiCommitMessage({
        subject: "record conversation message",
        summary: input.text,
        trailers: {
          sessionId: input.sessionId,
          event: "conversation_message",
          extras: { "Seq": String(record.seq), "Role": record.role },
          at: record.at,
        },
      }),
    });
    return { record, commit };
  }

  async registerAsset(input: RegisterAssetInput): Promise<{ event: SessionEventRecord; commit: string }> {
    const driver = await this.driver(input.sessionId);
    const assets = await appendJsonl(driver, MAIN_BRANCH_REF, SESSION_ASSETS_PATH, input.asset);
    const event: SessionEventRecord = {
      seq: await this.nextJsonlSeq(driver, MAIN_BRANCH_REF, SESSION_EVENTS_PATH),
      type: "asset_registered",
      at: input.asset.createdAt,
      assetId: input.asset.assetId,
    };
    const events = await appendJsonlContent(driver, MAIN_BRANCH_REF, SESSION_EVENTS_PATH, event);
    const commit = await driver.commitFiles({
      ref: MAIN_BRANCH_REF,
      files: {
        [SESSION_ASSETS_PATH]: assets,
        [SESSION_EVENTS_PATH]: events,
      },
      message: renderAyatiCommitMessage({
        subject: `register asset ${input.asset.assetId}`,
        summary: input.asset.name,
        trailers: {
          sessionId: input.sessionId,
          event: "asset_registered",
          extras: { "Asset": input.asset.assetId },
          at: input.asset.createdAt,
        },
      }),
    });
    return { event, commit };
  }

  async createTaskBranch(input: CreateTaskBranchInput): Promise<CreateTaskBranchResult> {
    assertWorkId(input.workId);
    const driver = await this.driver(input.sessionId);
    const createdAt = input.createdAt ?? this.nowIso();
    const status = input.status ?? "active";
    const branch = buildWorkBranchName(input.workId, input.title);
    const ref = buildWorkBranchRef(input.workId, input.title);
    if (await driver.hasRef(ref)) {
      throw new Error(`Task branch already exists: ${ref}`);
    }
    const task: TaskFile = {
      schemaVersion: 1,
      workId: input.workId,
      sessionId: input.sessionId,
      title: input.title,
      objective: input.objective,
      status,
      createdAt,
      updatedAt: createdAt,
    };
    const state: TaskStateFile = {
      schemaVersion: 1,
      workId: input.workId,
      status: input.state?.status ?? status,
      completed: input.state?.completed ?? [],
      open: input.state?.open ?? [],
      blockers: input.state?.blockers,
      facts: input.state?.facts ?? [],
      decisions: input.state?.decisions,
      assumptions: input.state?.assumptions,
      next: input.state?.next,
    };
    const taskCommit = await driver.commitFiles({
      ref,
      files: {
        [taskFilePath(input.workId)]: prettyJson(task),
        [taskStatePath(input.workId)]: prettyJson(state),
        [taskAssetsPath(input.workId)]: jsonl(input.assets ?? []),
      },
      message: renderAyatiCommitMessage({
        subject: `create task ${input.workId}`,
        summary: input.objective,
        trailers: {
          sessionId: input.sessionId,
          workId: input.workId,
          event: "task_created",
          status,
          at: createdAt,
        },
      }),
    });
    const event: SessionEventRecord = {
      seq: await this.nextJsonlSeq(driver, MAIN_BRANCH_REF, SESSION_EVENTS_PATH),
      type: "task_branch_created",
      at: createdAt,
      workId: input.workId,
      branch,
      ref,
    };
    const sessionCommit = await this.appendSessionEventWithDriver(driver, input.sessionId, event, {
      subject: `record task branch ${input.workId}`,
      summary: branch,
      at: createdAt,
      event: "task_branch_created",
      workId: input.workId,
    });
    return { workId: input.workId, branch, ref, taskCommit, sessionCommit };
  }

  async updateFocus(input: { sessionId: SessionId; ref: GitRef; at?: string }): Promise<UpdateFocusResult> {
    const driver = await this.driver(input.sessionId);
    if (!(await driver.hasRef(input.ref))) {
      throw new Error(`Cannot focus missing ref: ${input.ref}`);
    }
    const previous = await driver.readSymbolicRef(FOCUS_CURRENT_REF);
    await driver.setSymbolicRef(FOCUS_CURRENT_REF, input.ref);
    const event: SessionEventRecord = {
      seq: await this.nextJsonlSeq(driver, MAIN_BRANCH_REF, SESSION_EVENTS_PATH),
      type: "focus_changed",
      at: input.at ?? this.nowIso(),
      to: input.ref,
      ...(previous ? { from: previous } : {}),
    };
    const sessionCommit = await this.appendSessionEventWithDriver(driver, input.sessionId, event, {
      subject: "record focus change",
      summary: input.ref,
      at: event.at,
      event: "focus_changed",
    });
    return { ref: input.ref, sessionCommit };
  }

  async commitRun(input: CommitRunInput): Promise<CommitRunResult> {
    assertWorkId(input.workId);
    const driver = await this.driver(input.sessionId);
    const branch = await this.findTaskBranchRef(driver, input.workId);
    if (!branch) {
      throw new Error(`Task branch not found for work id: ${input.workId}`);
    }
    const files: Record<string, string> = {
      [taskStatePath(input.workId)]: prettyJson(input.state),
      [taskRunSummaryPath(input.workId, input.runId)]: prettyJson(input.runSummary),
    };
    if (input.taskAssets) {
      files[taskAssetsPath(input.workId)] = await appendJsonlRecords(
        driver,
        branch.ref,
        taskAssetsPath(input.workId),
        input.taskAssets,
      );
    }
    for (const item of input.actions) {
      let action = item.action;
      if (item.output !== undefined && !action.outputRef) {
        action = {
          ...action,
          outputRef: taskActionOutputPath(input.workId, input.runId, action.actionId, item.outputExtension ?? "txt"),
        };
      }
      files[taskActionFilePath(input.workId, input.runId, action.actionId)] = prettyJson(action);
      if (item.output !== undefined && action.outputRef) {
        files[action.outputRef] = item.output;
      }
    }
    if (input.finalOutput) {
      files[taskFinalOutputPath(input.workId)] = prettyJson(input.finalOutput);
    }
    const workCommit = await driver.commitFiles({
      ref: branch.ref,
      files,
      message: renderAyatiCommitMessage({
        subject: `complete run ${input.runId} for ${input.workId}`,
        summary: input.commitSummary ?? input.runSummary.summary,
        completed: input.completed ?? input.runSummary.completed,
        open: input.open ?? input.runSummary.open,
        trailers: {
          sessionId: input.sessionId,
          workId: input.workId,
          runId: input.runId,
          event: "run_completed",
          status: input.status ?? input.state.status,
          at: input.at ?? input.runSummary.createdAt,
          extras: {
            "Actions": input.runSummary.actions.join(","),
          },
        },
      }),
    });
    const runRef = buildRunRef(input.runId);
    await driver.updateRef(runRef, workCommit);
    const event: SessionEventRecord = {
      seq: await this.nextJsonlSeq(driver, MAIN_BRANCH_REF, SESSION_EVENTS_PATH),
      type: "run_committed",
      at: input.at ?? input.runSummary.createdAt,
      runId: input.runId,
      workId: input.workId,
      commit: workCommit,
    };
    const sessionCommit = await this.appendSessionEventWithDriver(driver, input.sessionId, event, {
      subject: `record run ${input.runId}`,
      summary: input.runSummary.summary,
      at: event.at,
      event: "run_committed",
      workId: input.workId,
      runId: input.runId,
    });
    return { workCommit, sessionCommit, runRef };
  }

  async readSessionConversationTail(sessionId: SessionId, limit: number): Promise<ConversationRecord[]> {
    const driver = await this.driver(sessionId);
    return parseJsonl<ConversationRecord>(await driver.readFile(MAIN_BRANCH_REF, SESSION_CONVERSATION_PATH)).slice(-limit);
  }

  async readSessionEventsTail(sessionId: SessionId, limit: number): Promise<SessionEventRecord[]> {
    const driver = await this.driver(sessionId);
    return parseJsonl<SessionEventRecord>(await driver.readFile(MAIN_BRANCH_REF, SESSION_EVENTS_PATH)).slice(-limit);
  }

  async readSessionAssets(sessionId: SessionId): Promise<SessionAssetRecord[]> {
    const driver = await this.driver(sessionId);
    return parseJsonl<SessionAssetRecord>(await driver.readFile(MAIN_BRANCH_REF, SESSION_ASSETS_PATH));
  }

  async listTaskBranches(sessionId: SessionId): Promise<TaskBranchInfo[]> {
    const driver = await this.driver(sessionId);
    return (await driver.listRefs("refs/heads/work"))
      .map((record) => {
        const parsed = parseWorkBranchRef(record.ref);
        return parsed
          ? {
              workId: parsed.workId,
              ref: parsed.ref,
              branch: parsed.branchName,
              slug: parsed.slug,
              commit: record.objectId,
            }
          : null;
      })
      .filter((record): record is TaskBranchInfo => record !== null);
  }

  async readFocus(sessionId: SessionId): Promise<GitRef | null> {
    const driver = await this.driver(sessionId);
    return await driver.readSymbolicRef(FOCUS_CURRENT_REF);
  }

  async readTaskState(sessionId: SessionId, workId: WorkId): Promise<TaskStateFile | null> {
    const driver = await this.driver(sessionId);
    const branch = await this.findTaskBranchRef(driver, workId);
    if (!branch) {
      return null;
    }
    return parseJson<TaskStateFile>(await driver.readFile(branch.ref, taskStatePath(workId)));
  }

  async readTaskFile(sessionId: SessionId, workId: WorkId): Promise<TaskFile | null> {
    const driver = await this.driver(sessionId);
    const branch = await this.findTaskBranchRef(driver, workId);
    if (!branch) {
      return null;
    }
    return parseJson<TaskFile>(await driver.readFile(branch.ref, taskFilePath(workId)));
  }

  async readTaskAssets(sessionId: SessionId, workId: WorkId): Promise<TaskAssetRecord[]> {
    const driver = await this.driver(sessionId);
    const branch = await this.findTaskBranchRef(driver, workId);
    if (!branch) {
      return [];
    }
    return parseJsonl<TaskAssetRecord>(await driver.readFile(branch.ref, taskAssetsPath(workId)));
  }

  async readTaskRunSummaries(sessionId: SessionId, workId: WorkId, limit: number): Promise<TaskRunSummaryFile[]> {
    const driver = await this.driver(sessionId);
    const branch = await this.findTaskBranchRef(driver, workId);
    if (!branch) {
      return [];
    }
    const paths = (await driver.listTreePaths(branch.ref, `${taskDirectoryForRead(workId)}/summaries`)).sort();
    const summaries: TaskRunSummaryFile[] = [];
    for (const path of paths) {
      const parsed = parseJson<TaskRunSummaryFile>(await driver.readFile(branch.ref, path));
      if (parsed) {
        summaries.push(parsed);
      }
    }
    return summaries.slice(-limit);
  }

  async readTaskCommitLog(sessionId: SessionId, workId: WorkId, limit: number): Promise<TaskCommitLogEntry[]> {
    const driver = await this.driver(sessionId);
    const branch = await this.findTaskBranchRef(driver, workId);
    if (!branch) {
      return [];
    }
    return (await driver.log(branch.ref, limit)).map((entry) => ({
      ...entry,
      trailers: parseAyatiCommitTrailers(entry.message),
    }));
  }

  private async driver(sessionId: SessionId): Promise<GitDriver> {
    assertSessionId(sessionId);
    return await GitDriver.initBare(this.repoPath(sessionId));
  }

  private async appendSessionEventWithDriver(
    driver: GitDriver,
    sessionId: SessionId,
    event: SessionEventRecord,
    commit: {
      subject: string;
      summary?: string;
      at?: string;
      event: string;
      workId?: WorkId;
      runId?: RunId;
    },
  ): Promise<string> {
    const content = await appendJsonlContent(driver, MAIN_BRANCH_REF, SESSION_EVENTS_PATH, event);
    return await driver.commitFiles({
      ref: MAIN_BRANCH_REF,
      files: { [SESSION_EVENTS_PATH]: content },
      message: renderAyatiCommitMessage({
        subject: commit.subject,
        summary: commit.summary,
        trailers: {
          sessionId,
          workId: commit.workId,
          runId: commit.runId,
          event: commit.event,
          at: commit.at,
        },
      }),
    });
  }

  private async nextJsonlSeq(driver: GitDriver, ref: GitRef, path: string): Promise<number> {
    const records = parseJsonl<{ seq?: unknown }>(await driver.readFile(ref, path));
    const max = records.reduce((current, record) => (
      typeof record.seq === "number" && Number.isInteger(record.seq) ? Math.max(current, record.seq) : current
    ), 0);
    return max + 1;
  }

  private async findTaskBranchRef(driver: GitDriver, workId: WorkId): Promise<TaskBranchInfo | null> {
    const branches = (await driver.listRefs("refs/heads/work"))
      .map((record) => {
        const parsed = parseWorkBranchRef(record.ref);
        return parsed
          ? {
              workId: parsed.workId,
              ref: parsed.ref,
              branch: parsed.branchName,
              slug: parsed.slug,
              commit: record.objectId,
            }
          : null;
      })
      .filter((record): record is TaskBranchInfo => record !== null);
    return branches.find((branch) => branch.workId === workId) ?? null;
  }

  private nowIso(): string {
    return this.nowProvider().toISOString();
  }
}

async function appendJsonl<T>(driver: GitDriver, ref: GitRef, path: string, record: T): Promise<string> {
  return await appendJsonlRecords(driver, ref, path, [record]);
}

async function appendJsonlContent<T>(driver: GitDriver, ref: GitRef, path: string, record: T): Promise<string> {
  return await appendJsonlRecords(driver, ref, path, [record]);
}

async function appendJsonlRecords<T>(driver: GitDriver, ref: GitRef, path: string, records: T[]): Promise<string> {
  const current = await driver.readFile(ref, path) ?? "";
  const prefix = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
  return `${prefix}${jsonl(records)}`;
}

function jsonl<T>(records: T[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJson<T>(value: string | null): T | null {
  if (!value?.trim()) {
    return null;
  }
  return JSON.parse(value) as T;
}

function parseJsonl<T>(value: string | null): T[] {
  if (!value?.trim()) {
    return [];
  }
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function assertSessionId(sessionId: SessionId): void {
  if (!isSessionId(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
}

function assertWorkId(workId: WorkId): void {
  if (!isWorkId(workId)) {
    throw new Error(`Invalid work id: ${workId}`);
  }
}

function taskDirectoryForRead(workId: WorkId): string {
  assertWorkId(workId);
  return `tasks/${workId}`;
}
