import type { ToolActionFile } from "./action-files.js";
import {
  buildDailySessionMachineContextPack,
  type DailySessionMachineContextPack,
} from "./context-pack.js";
import { DailySessionContextReader } from "./context-reader.js";
import type {
  CommitRunResult,
  CreateTaskBranchResult,
  DailySessionGitStore,
  RunActionWrite,
  UpdateFocusResult,
} from "./git-store.js";
import { createWorkId, type RunId, type SessionId, type WorkId } from "./ids.js";
import type { ConversationRecord } from "./session-files.js";
import type {
  TaskAssetRecord,
  TaskOutputFile,
  TaskRunSummaryFile,
  TaskStateFile,
} from "./task-files.js";
import {
  DailySessionTaskResolver,
  type TaskResolution,
} from "./task-resolver.js";

export interface DailySessionCoordinatorOptions {
  store: DailySessionGitStore;
  resolver?: DailySessionTaskResolver;
  reader?: DailySessionContextReader;
}

export interface PrepareUserTurnInput {
  sessionId: SessionId;
  timezone: string;
  userMessage: string;
  at?: string;
}

export type PreparedUserTurn =
  | {
      status: "ready";
      conversation: ConversationRecord;
      resolution: Exclude<TaskResolution, { mode: "ambiguous" }>;
      selected: {
        workId: WorkId;
        ref: string;
      };
      context: DailySessionMachineContextPack;
      createdTask?: CreateTaskBranchResult;
      focusUpdate?: UpdateFocusResult;
    }
  | {
      status: "ambiguous";
      conversation: ConversationRecord;
      resolution: Extract<TaskResolution, { mode: "ambiguous" }>;
      context: DailySessionMachineContextPack;
    };

export interface CompletePreparedRunInput {
  sessionId: SessionId;
  workId: WorkId;
  runId: RunId;
  state: TaskStateFile;
  runSummary: TaskRunSummaryFile;
  actions: Array<RunActionWrite | ToolActionFile>;
  taskAssets?: TaskAssetRecord[];
  finalOutput?: TaskOutputFile;
  assistantMessage?: string;
  assistantAt?: string;
  commitSummary?: string;
  completed?: string[];
  open?: string[];
  status?: string;
  at?: string;
}

export interface CompletedPreparedRun {
  run: CommitRunResult;
  assistantConversation?: ConversationRecord;
  context: DailySessionMachineContextPack;
}

export class DailySessionCoordinator {
  private readonly store: DailySessionGitStore;
  private readonly resolver: DailySessionTaskResolver;
  private readonly reader: DailySessionContextReader;

  constructor(options: DailySessionCoordinatorOptions) {
    this.store = options.store;
    this.resolver = options.resolver ?? new DailySessionTaskResolver(options.store);
    this.reader = options.reader ?? new DailySessionContextReader(options.store);
  }

  async prepareUserTurn(input: PrepareUserTurnInput): Promise<PreparedUserTurn> {
    await this.store.openOrCreateSession({
      sessionId: input.sessionId,
      timezone: input.timezone,
      createdAt: input.at,
    });
    const conversation = await this.store.appendConversation({
      sessionId: input.sessionId,
      role: "user",
      text: input.userMessage,
      at: input.at,
    });
    const resolution = await this.resolver.resolve({
      sessionId: input.sessionId,
      userMessage: input.userMessage,
    });

    if (resolution.mode === "ambiguous") {
      return {
        status: "ambiguous",
        conversation: conversation.record,
        resolution,
        context: await this.buildActivePack(input.sessionId),
      };
    }

    if (resolution.mode === "continue_focus") {
      return {
        status: "ready",
        conversation: conversation.record,
        resolution,
        selected: {
          workId: resolution.workId,
          ref: resolution.ref,
        },
        context: await this.buildActivePack(input.sessionId),
      };
    }

    if (resolution.mode === "switch_existing") {
      const focusUpdate = await this.store.updateFocus({
        sessionId: input.sessionId,
        ref: resolution.ref,
        at: input.at,
      });
      return {
        status: "ready",
        conversation: conversation.record,
        resolution,
        selected: {
          workId: resolution.workId,
          ref: resolution.ref,
        },
        focusUpdate,
        context: await this.buildActivePack(input.sessionId),
      };
    }

    const workId = await this.nextWorkId(input.sessionId);
    const createdTask = await this.store.createTaskBranch({
      sessionId: input.sessionId,
      workId,
      title: resolution.title,
      objective: resolution.objective,
      createdAt: input.at,
      state: {
        completed: [],
        open: [resolution.objective],
        facts: [],
        next: resolution.objective,
      },
    });
    const focusUpdate = await this.store.updateFocus({
      sessionId: input.sessionId,
      ref: createdTask.ref,
      at: input.at,
    });
    return {
      status: "ready",
      conversation: conversation.record,
      resolution,
      selected: {
        workId,
        ref: createdTask.ref,
      },
      createdTask,
      focusUpdate,
      context: await this.buildActivePack(input.sessionId),
    };
  }

  async completePreparedRun(input: CompletePreparedRunInput): Promise<CompletedPreparedRun> {
    const run = await this.store.commitRun({
      sessionId: input.sessionId,
      workId: input.workId,
      runId: input.runId,
      state: input.state,
      runSummary: input.runSummary,
      actions: input.actions.map(normalizeActionWrite),
      taskAssets: input.taskAssets,
      finalOutput: input.finalOutput,
      commitSummary: input.commitSummary,
      completed: input.completed,
      open: input.open,
      status: input.status,
      at: input.at,
    });
    const assistantConversation = input.assistantMessage
      ? (await this.store.appendConversation({
          sessionId: input.sessionId,
          role: "assistant",
          text: input.assistantMessage,
          at: input.assistantAt ?? input.at,
        })).record
      : undefined;
    return {
      run,
      ...(assistantConversation ? { assistantConversation } : {}),
      context: await this.buildTaskPack(input.sessionId, input.workId),
    };
  }

  private async buildActivePack(sessionId: SessionId): Promise<DailySessionMachineContextPack> {
    return buildDailySessionMachineContextPack(await this.reader.buildActiveContext({ sessionId }));
  }

  private async buildTaskPack(sessionId: SessionId, workId: WorkId): Promise<DailySessionMachineContextPack> {
    return buildDailySessionMachineContextPack(await this.reader.buildTaskContext({ sessionId, workId }));
  }

  private async nextWorkId(sessionId: SessionId): Promise<WorkId> {
    const branches = await this.store.listTaskBranches(sessionId);
    const nextSequence = branches.reduce((max, branch) => {
      const sequence = Number(branch.workId.split("-")[2] ?? "0");
      return Number.isInteger(sequence) ? Math.max(max, sequence) : max;
    }, 0) + 1;
    return createWorkId(sessionId, nextSequence);
  }
}

function normalizeActionWrite(action: RunActionWrite | ToolActionFile): RunActionWrite {
  return "action" in action ? action : { action };
}
