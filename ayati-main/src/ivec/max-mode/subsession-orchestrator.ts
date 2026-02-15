import { randomUUID } from "node:crypto";
import type { LlmProvider } from "../../core/contracts/provider.js";
import type { LlmMessage } from "../../core/contracts/llm-protocol.js";
import type { SessionMemory } from "../../memory/types.js";
import { noopSessionMemory } from "../../memory/provider.js";
import type { ToolExecutor } from "../../skills/tool-executor.js";
import { AgentLoop } from "../agent-loop.js";
import type { AgentLoopConfigInput } from "../agent-loop-types.js";
import { ContextRecallService } from "../context-recall-service.js";
import { devWarn } from "../../shared/index.js";
import { SubsessionStore } from "./subsession-store.js";
import type {
  SubsessionEndReport,
  SubsessionFailureReport,
  SubsessionLogEvent,
  SubsessionMeta,
  SubsessionPlan,
  SubsessionProgressEvent,
  SubsessionState,
  SubsessionTask,
  SubsessionTaskAttempt,
  SubsessionTaskReflection,
  SubsessionTaskVerification,
} from "./types.js";

interface PlanPayload {
  goal?: string;
  done_criteria?: string;
  constraints?: string[];
  tasks?: Array<{
    title?: string;
    objective?: string;
    expected_output?: string;
  }>;
}

interface VerificationPayload {
  pass?: boolean;
  score?: number;
  gap?: string;
  rationale?: string;
}

interface ReflectionPayload {
  failure_reason?: string;
  strategy_delta?: string;
  next_instruction?: string;
}

interface ResumeSelectionPayload {
  action?: "resume" | "new";
  subsession_id?: string | null;
  reason?: string;
  confidence?: number;
}

export interface MaxModeConfig {
  enabled: boolean;
  rootDir?: string;
  maxTasks: number;
  maxAttemptsPerTask: number;
  maxTotalSteps: number;
  maxNoProgressCycles: number;
  maxTaskOutputChars: number;
}

export interface MaxModeRunInput {
  clientId: string;
  userContent: string;
  systemContext: string;
  mainSessionId: string;
  mainRunId: string;
  staticSystemTokens: number;
  resolveModelName: (providerName: string) => string;
}

export interface MaxModeRunResult {
  content: string;
  endStatus: "solved" | "partial" | "stuck";
  subsessionId: string;
}

interface ExecutePlanResult {
  ok: boolean;
  endStatus: "solved" | "partial" | "stuck";
  message: string;
  completedTaskIds: string[];
  unresolvedItems: string[];
  verificationFiles: string[];
  failedTaskId?: string;
  failedTaskTitle?: string;
  failureReason?: string;
}

interface ResumeResolution {
  subsessionId: string | null;
  reason?: string;
}

const DEFAULT_MAX_MODE_CONFIG: MaxModeConfig = {
  enabled: true,
  maxTasks: 12,
  maxAttemptsPerTask: 3,
  maxTotalSteps: 60,
  maxNoProgressCycles: 2,
  maxTaskOutputChars: 16_000,
};

const RESUME_PATTERN = /\b(continue|resume|pick up|carry on|same subsession|retry previous)\b/i;
const NEW_TASK_PATTERN = /\b(new task|start fresh|from scratch|unrelated|different problem|independent)\b/i;
const PLAN_CHANGE_PATTERN = /\b(change plan|update plan|modify plan|adjust plan|revise plan|new plan)\b/i;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const MAX_RESUME_CANDIDATES = 6;

function parseJson<T>(text: string): T | null {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

function clampScore(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15))} ...[truncated]`;
}

function summarize(value: string, maxChars = 420): string {
  return truncate(value.replace(/\s+/g, " ").trim(), maxChars);
}

function nowIso(): string {
  return new Date().toISOString();
}

function padTaskId(index: number): string {
  return `task-${String(index + 1).padStart(3, "0")}`;
}

export interface MaxModeOrchestratorOptions {
  provider: LlmProvider;
  toolExecutor?: ToolExecutor;
  sessionMemory: SessionMemory;
  onReply?: (clientId: string, data: unknown) => void;
  loopConfig?: AgentLoopConfigInput;
  maxModeConfig?: Partial<MaxModeConfig>;
}

export class MaxModeSubsessionOrchestrator {
  private readonly provider: LlmProvider;
  private readonly toolExecutor?: ToolExecutor;
  private readonly sessionMemory: SessionMemory;
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly loopConfig?: AgentLoopConfigInput;
  private readonly config: MaxModeConfig;
  private readonly store: SubsessionStore;
  private readonly recallService: ContextRecallService;

  constructor(options: MaxModeOrchestratorOptions) {
    this.provider = options.provider;
    this.toolExecutor = options.toolExecutor;
    this.sessionMemory = options.sessionMemory;
    this.onReply = options.onReply;
    this.loopConfig = options.loopConfig;
    this.config = {
      ...DEFAULT_MAX_MODE_CONFIG,
      ...(options.maxModeConfig ?? {}),
    };
    this.store = new SubsessionStore({ rootDir: this.config.rootDir });
    this.recallService = new ContextRecallService(this.sessionMemory, this.provider);
  }

  async run(input: MaxModeRunInput): Promise<MaxModeRunResult> {
    await this.store.ensureRoot();

    const resumeResolution = await this.resolveResumeSubsession(input.clientId, input.userContent);
    let snapshot = resumeResolution.subsessionId
      ? await this.store.loadSubsession(resumeResolution.subsessionId)
      : null;

    if (!snapshot) {
      snapshot = await this.store.createSubsession({
        clientId: input.clientId,
        parentSessionId: input.mainSessionId,
        parentRunId: input.mainRunId,
        goalSummary: summarize(input.userContent, 280),
        maxAttemptsPerTask: this.config.maxAttemptsPerTask,
        maxTotalSteps: this.config.maxTotalSteps,
        maxNoProgressCycles: this.config.maxNoProgressCycles,
      });
      await this.emitProgress(input.clientId, snapshot.meta.id, {
        type: "subsession_started",
        message: `Started maximum sub-session ${snapshot.meta.id}`,
      });
    } else {
      await this.emitProgress(input.clientId, snapshot.meta.id, {
        type: "subsession_resumed",
        message:
          `Resumed maximum sub-session ${snapshot.meta.id}` +
          (resumeResolution.reason ? ` (${resumeResolution.reason})` : ""),
      });
    }

    const lock = await this.store.acquireActiveLock(snapshot.meta.id);
    if (!lock.ok) {
      return {
        content: `Maximum mode is busy. Active sub-session: ${lock.activeId}.`,
        endStatus: "stuck",
        subsessionId: snapshot.meta.id,
      };
    }
    await this.log(snapshot.meta.id, "lock_acquired", { lockOwner: snapshot.meta.id });

    try {
      let activeMeta: SubsessionMeta = {
        ...snapshot.meta,
        status: "running",
      };
      await this.store.saveMeta(activeMeta);

      const context = this.buildContextMarkdown(input, activeMeta.id);
      await this.store.writeContext(activeMeta.id, context);

      let plan = snapshot.plan;
      let state = snapshot.state;

      const shouldRevise = plan.tasks.length > 0 && PLAN_CHANGE_PATTERN.test(input.userContent);
      if (plan.tasks.length === 0) {
        plan = await this.createInitialPlan(input.userContent);
      } else if (shouldRevise) {
        activeMeta = {
          ...activeMeta,
          status: "waiting_for_plan_update",
        };
        state = {
          ...state,
          modeStatus: "waiting_for_plan_update",
        };
        await this.store.saveMeta(activeMeta);
        await this.store.saveState(activeMeta.id, state);
        await this.log(activeMeta.id, "state_write", {
          modeStatus: state.modeStatus,
          currentTaskIndex: state.currentTaskIndex,
        });
        plan = await this.revisePlan(plan, input.userContent);
      }

      await this.store.savePlan(activeMeta.id, plan);
      activeMeta = {
        ...activeMeta,
        revision: plan.revision,
        status: "running",
      };
      await this.store.saveMeta(activeMeta);

      await this.log(activeMeta.id, "plan_write", {
        revision: plan.revision,
        tasks: plan.tasks.length,
      });
      await this.persistTasks(activeMeta.id, plan.tasks);
      await this.emitPlan(input.clientId, activeMeta.id, plan);

      state = {
        ...state,
        modeStatus: "running",
        maxAttemptsPerTask: this.config.maxAttemptsPerTask,
        maxTotalSteps: this.config.maxTotalSteps,
        maxNoProgressCycles: this.config.maxNoProgressCycles,
      };
      await this.store.saveState(activeMeta.id, state);
      await this.log(activeMeta.id, "state_write", {
        modeStatus: state.modeStatus,
        currentTaskIndex: state.currentTaskIndex,
      });

      const execution = await this.executePlan(
        input,
        activeMeta.id,
        plan,
        state,
      );

      if (!execution.ok) {
        const failedState: SubsessionState = {
          ...state,
          modeStatus: "failed",
        };
        await this.store.saveState(activeMeta.id, failedState);

        const failure: SubsessionFailureReport = {
          subsessionId: activeMeta.id,
          status: "failed",
          failedTaskId: execution.failedTaskId ?? "unknown_task",
          failedTaskTitle: execution.failedTaskTitle ?? "Unknown task",
          attempts: state.currentAttempt,
          rootCause: execution.failureReason ?? execution.message,
          lastCheckpoint: nowIso(),
          recommendedNextStep: "Resume this sub-session and revise pending task strategy.",
          createdAt: nowIso(),
        };
        await this.store.writeFailure(activeMeta.id, failure);
        await this.log(activeMeta.id, "failure_write", failure as unknown as Record<string, unknown>);
        await this.store.saveMeta({ ...activeMeta, status: "failed" });

        await this.emitProgress(input.clientId, activeMeta.id, {
          type: "subsession_failed",
          message: execution.message,
          taskId: execution.failedTaskId,
          taskTitle: execution.failedTaskTitle,
          revision: plan.revision,
        });

        return {
          content:
            `${execution.message}\n` +
            `Sub-session ${activeMeta.id} is resumable. Say "continue" with plan updates to resume.`,
          endStatus: execution.endStatus,
          subsessionId: activeMeta.id,
        };
      }

      const completedState: SubsessionState = {
        ...state,
        currentTaskId: undefined,
        currentTaskIndex: plan.tasks.length,
        currentAttempt: 0,
        modeStatus: "completed",
      };
      await this.store.saveState(activeMeta.id, completedState);

      const end: SubsessionEndReport = {
        subsessionId: activeMeta.id,
        status: "completed",
        endStatus: execution.endStatus === "stuck" ? "partial" : execution.endStatus,
        finalAnswer: execution.message,
        completedTaskIds: execution.completedTaskIds,
        unresolvedItems: execution.unresolvedItems,
        verificationEvidenceFiles: execution.verificationFiles,
        createdAt: nowIso(),
      };
      await this.store.writeEnd(activeMeta.id, end);
      await this.log(activeMeta.id, "end_write", end as unknown as Record<string, unknown>);
      await this.store.saveMeta({ ...activeMeta, status: "completed" });

      await this.emitProgress(input.clientId, activeMeta.id, {
        type: "subsession_completed",
        message: `Sub-session ${activeMeta.id} completed ${execution.completedTaskIds.length} task(s).`,
        revision: plan.revision,
      });

      return {
        content: execution.message,
        endStatus: end.endStatus,
        subsessionId: activeMeta.id,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown max-mode orchestration error";
      devWarn("Maximum mode orchestration failed:", message);
      await this.store.saveMeta({
        ...snapshot.meta,
        status: "failed",
      });
      await this.store.saveState(snapshot.meta.id, {
        ...snapshot.state,
        modeStatus: "failed",
      });
      await this.emitProgress(input.clientId, snapshot.meta.id, {
        type: "subsession_failed",
        message,
      });
      return {
        content: `Maximum mode failed unexpectedly: ${message}`,
        endStatus: "stuck",
        subsessionId: snapshot.meta.id,
      };
    } finally {
      await this.store.releaseActiveLock(snapshot.meta.id);
      await this.log(snapshot.meta.id, "lock_released", { lockOwner: snapshot.meta.id });
    }
  }

  private async createInitialPlan(userContent: string): Promise<SubsessionPlan> {
    const messages: LlmMessage[] = [
      {
        role: "system",
        content:
          "You create execution plans for a maximum-mode autonomous sub-session. Return strict JSON only.",
      },
      {
        role: "user",
        content: [
          "Return JSON with keys:",
          "{\"goal\":\"string\",\"done_criteria\":\"string\",\"constraints\":[\"...\"],\"tasks\":[{\"title\":\"string\",\"objective\":\"string\",\"expected_output\":\"string\"}]}",
          `Rules: tasks must be ordered, actionable, and <= ${this.config.maxTasks}.`,
          `Task request: ${userContent}`,
        ].join("\n"),
      },
    ];

    const output = await this.provider.generateTurn({ messages });
    const parsed =
      output.type === "assistant"
        ? parseJson<PlanPayload>(output.content)
        : null;

    const builtTasks = this.buildTasksFromPlanPayload(parsed, userContent);
    const now = nowIso();
    return {
      goal:
        typeof parsed?.goal === "string" && parsed.goal.trim().length > 0
          ? parsed.goal.trim()
          : summarize(userContent, 220),
      doneCriteria:
        typeof parsed?.done_criteria === "string" && parsed.done_criteria.trim().length > 0
          ? parsed.done_criteria.trim()
          : "All planned tasks completed with passing verification.",
      constraints: Array.isArray(parsed?.constraints)
        ? parsed!.constraints.filter((item): item is string => typeof item === "string").slice(0, 20)
        : [],
      tasks: builtTasks,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: "llm",
    };
  }

  private async revisePlan(existing: SubsessionPlan, userContent: string): Promise<SubsessionPlan> {
    const completed = existing.tasks.filter((task) => task.status === "completed");
    const pending = existing.tasks.filter((task) => task.status !== "completed");

    const messages: LlmMessage[] = [
      {
        role: "system",
        content:
          "You revise only pending tasks of an active autonomous sub-session plan. Return strict JSON only.",
      },
      {
        role: "user",
        content: [
          "Return JSON with key `tasks` where each item has title/objective/expected_output.",
          `Do not include already completed tasks. Keep task count <= ${this.config.maxTasks}.`,
          "Current plan goal:",
          existing.goal,
          "Completed task titles:",
          completed.map((task) => task.title).join(", ") || "(none)",
          "Current pending task titles:",
          pending.map((task) => task.title).join(", ") || "(none)",
          "User revision request:",
          userContent,
        ].join("\n"),
      },
    ];

    const output = await this.provider.generateTurn({ messages });
    const parsed =
      output.type === "assistant"
        ? parseJson<PlanPayload>(output.content)
        : null;
    const revisedPending = this.buildTasksFromPlanPayload(parsed, userContent);
    const now = nowIso();

    const rebuilt: SubsessionTask[] = [];
    for (const task of completed) {
      rebuilt.push(task);
    }
    for (let i = 0; i < revisedPending.length; i++) {
      const template = revisedPending[i];
      if (!template) continue;
      rebuilt.push({
        ...template,
        id: padTaskId(completed.length + i),
      });
    }

    return {
      ...existing,
      tasks: rebuilt,
      revision: existing.revision + 1,
      updatedAt: now,
    };
  }

  private buildTasksFromPlanPayload(parsed: PlanPayload | null, userContent: string): SubsessionTask[] {
    const now = nowIso();
    const rawTasks = Array.isArray(parsed?.tasks) ? parsed!.tasks : [];

    const normalized = rawTasks
      .map<SubsessionTask | null>((task, index) => {
        const title = typeof task.title === "string" ? task.title.trim() : "";
        const objective = typeof task.objective === "string" ? task.objective.trim() : "";
        const expectedOutput =
          typeof task.expected_output === "string" ? task.expected_output.trim() : "";
        if (objective.length === 0) return null;
        return {
          id: padTaskId(index),
          title: title.length > 0 ? title : `Task ${index + 1}`,
          objective,
          expectedOutput:
            expectedOutput.length > 0
              ? expectedOutput
              : "Concrete output that satisfies this task objective.",
          status: "pending",
          attempts: [] as SubsessionTaskAttempt[],
          createdAt: now,
          updatedAt: now,
        };
      })
      .filter((task): task is SubsessionTask => task !== null)
      .slice(0, this.config.maxTasks);

    if (normalized.length > 0) return normalized;
    return [
      {
        id: "task-001",
        title: "Execute request",
        objective: summarize(userContent, 400),
        expectedOutput: "A complete answer with evidence from executed actions.",
        status: "pending",
        attempts: [] as SubsessionTaskAttempt[],
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  private async executePlan(
    input: MaxModeRunInput,
    subsessionId: string,
    plan: SubsessionPlan,
    state: SubsessionState,
  ): Promise<ExecutePlanResult> {
    const completedTaskIds: string[] = [];
    const unresolvedItems: string[] = [];
    const verificationFiles: string[] = [];

    for (let index = state.currentTaskIndex; index < plan.tasks.length; index++) {
      const task = plan.tasks[index];
      if (!task) continue;
      if (task.status === "completed") {
        completedTaskIds.push(task.id);
        continue;
      }

      task.status = "running";
      task.updatedAt = nowIso();
      state.currentTaskId = task.id;
      state.currentTaskIndex = index;
      await this.store.saveTask(subsessionId, task);
      await this.store.saveState(subsessionId, state);
      await this.log(subsessionId, "task_write", {
        taskId: task.id,
        status: task.status,
      });
      await this.emitProgress(input.clientId, subsessionId, {
        type: "task_started",
        message: `Starting ${task.id}: ${task.title}`,
        taskId: task.id,
        taskTitle: task.title,
        revision: plan.revision,
      });

      let taskCompleted = false;
      for (
        let attemptNumber = task.attempts.length + 1;
        attemptNumber <= state.maxAttemptsPerTask;
        attemptNumber++
      ) {
        if (state.totalSteps >= state.maxTotalSteps) {
          task.status = "failed";
          unresolvedItems.push(task.title);
          await this.store.saveTask(subsessionId, task);
          return {
            ok: false,
            endStatus: "partial",
            message: `Sub-session ${subsessionId} reached max step budget (${state.maxTotalSteps}).`,
            completedTaskIds,
            unresolvedItems,
            verificationFiles,
            failedTaskId: task.id,
            failedTaskTitle: task.title,
            failureReason: "step_budget_exceeded",
          };
        }

        const priorReflection = task.attempts.length > 0
          ? task.attempts[task.attempts.length - 1]?.reflection
          : undefined;
        const attempt = await this.runTaskAttempt(
          input,
          subsessionId,
          plan,
          task,
          attemptNumber,
          priorReflection,
        );
        task.attempts.push(attempt);
        state.totalSteps += attempt.totalSteps;
        state.totalToolCalls += attempt.toolCallsMade;
        state.currentAttempt = attemptNumber;

        const verificationPath = await this.store.writeVerification(
          subsessionId,
          task.id,
          attemptNumber,
          attempt.verification,
          attempt.outputSummary,
        );
        verificationFiles.push(verificationPath);
        await this.log(subsessionId, "verification_write", {
          taskId: task.id,
          attempt: attemptNumber,
          verificationPath,
          pass: attempt.verification.pass,
          score: attempt.verification.score,
        });
        await this.log(subsessionId, "attempt_result", {
          taskId: task.id,
          attempt: attemptNumber,
          endStatus: attempt.endStatus,
          verified: attempt.verification.pass,
          steps: attempt.totalSteps,
          toolCalls: attempt.toolCallsMade,
        });

        if (attempt.verification.pass) {
          task.status = "completed";
          task.updatedAt = nowIso();
          state.currentTaskIndex = index + 1;
          state.currentTaskId = undefined;
          state.currentAttempt = 0;
          state.noProgressCycles = 0;
          await this.store.saveTask(subsessionId, task);
          await this.store.saveState(subsessionId, state);
          completedTaskIds.push(task.id);

          await this.emitProgress(input.clientId, subsessionId, {
            type: "task_completed",
            message: `${task.id} completed and verified.`,
            taskId: task.id,
            taskTitle: task.title,
            revision: plan.revision,
          });
          taskCompleted = true;
          break;
        }

        state.noProgressCycles += 1;
        const reflection = await this.reflectOnFailure(task, attempt);
        attempt.reflection = reflection;
        task.updatedAt = nowIso();
        await this.store.saveTask(subsessionId, task);
        await this.store.saveState(subsessionId, state);

        if (state.noProgressCycles > state.maxNoProgressCycles) {
          task.status = "failed";
          unresolvedItems.push(task.title);
          await this.store.saveTask(subsessionId, task);
          return {
            ok: false,
            endStatus: "partial",
            message:
              `Sub-session ${subsessionId} stopped: no progress after ${state.noProgressCycles} failed verification cycle(s).`,
            completedTaskIds,
            unresolvedItems,
            verificationFiles,
            failedTaskId: task.id,
            failedTaskTitle: task.title,
            failureReason: attempt.verification.gap,
          };
        }
      }

      if (!taskCompleted) {
        task.status = "failed";
        task.updatedAt = nowIso();
        unresolvedItems.push(task.title);
        await this.store.saveTask(subsessionId, task);
        await this.emitProgress(input.clientId, subsessionId, {
          type: "task_failed",
          message: `${task.id} failed after ${state.maxAttemptsPerTask} attempt(s).`,
          taskId: task.id,
          taskTitle: task.title,
          revision: plan.revision,
        });

        const lastAttempt = task.attempts[task.attempts.length - 1];
        return {
          ok: false,
          endStatus: "partial",
          message: `Task ${task.id} failed. Returning control to main session.`,
          completedTaskIds,
          unresolvedItems,
          verificationFiles,
          failedTaskId: task.id,
          failedTaskTitle: task.title,
          failureReason: lastAttempt?.verification.gap ?? "task_failed",
        };
      }
    }

    const finalSummary = this.buildCompletionSummary(
      subsessionId,
      plan,
      completedTaskIds,
      verificationFiles,
    );
    return {
      ok: true,
      endStatus: "solved",
      message: finalSummary,
      completedTaskIds,
      unresolvedItems,
      verificationFiles,
    };
  }

  private async runTaskAttempt(
    input: MaxModeRunInput,
    subsessionId: string,
    plan: SubsessionPlan,
    task: SubsessionTask,
    attempt: number,
    reflection?: SubsessionTaskReflection,
  ): Promise<SubsessionTaskAttempt> {
    const startedAt = nowIso();
    const taskPrompt = this.buildTaskPrompt(plan, task, reflection);
    const taskSystem = this.buildTaskSystemContext(input.systemContext, plan);

    const loop = new AgentLoop(
      this.provider,
      this.toolExecutor,
      noopSessionMemory,
      this.recallService,
      undefined,
      {
        ...this.loopConfig,
        baseStepLimit: Math.max(16, this.loopConfig?.baseStepLimit ?? 16),
        maxStepLimit: Math.max(32, this.loopConfig?.maxStepLimit ?? 32),
        noProgressLimit: Math.max(6, this.loopConfig?.noProgressLimit ?? 6),
        escalation: {
          ...(this.loopConfig?.escalation ?? {}),
          enabled: false,
        },
      },
      this.toolExecutor?.definitions() ?? [],
    );

    const runHandle = {
      sessionId: `subsession-${subsessionId}`,
      runId: `subtask-${task.id}-${attempt}-${randomUUID()}`,
    };

    const loopResult = await loop.run(
      input.clientId,
      taskPrompt,
      taskSystem,
      0,
      runHandle,
      input.staticSystemTokens,
      input.resolveModelName,
    );

    const output = truncate(loopResult.content, this.config.maxTaskOutputChars);
    const verification = await this.verifyAttempt(task, output);

    return {
      attempt,
      startedAt,
      endedAt: nowIso(),
      output,
      outputSummary: summarize(output),
      endStatus: loopResult.endStatus ?? "partial",
      totalSteps: loopResult.totalSteps,
      toolCallsMade: loopResult.toolCallsMade,
      verification,
    };
  }

  private async verifyAttempt(
    task: SubsessionTask,
    output: string,
  ): Promise<SubsessionTaskVerification> {
    const messages: LlmMessage[] = [
      {
        role: "system",
        content:
          "You validate a task result against expected output. Return strict JSON only.",
      },
      {
        role: "user",
        content: [
          "Return JSON:",
          "{\"pass\":true|false,\"score\":0.0,\"gap\":\"string\",\"rationale\":\"string\"}",
          "Task objective:",
          task.objective,
          "Expected output:",
          task.expectedOutput,
          "Observed output:",
          output,
        ].join("\n"),
      },
    ];

    try {
      const out = await this.provider.generateTurn({ messages });
      const parsed =
        out.type === "assistant"
          ? parseJson<VerificationPayload>(out.content)
          : null;

      if (!parsed || typeof parsed.pass !== "boolean") {
        return this.fallbackVerification(output);
      }

      return {
        pass: parsed.pass,
        score: clampScore(parsed.score, parsed.pass ? 0.78 : 0.38),
        gap:
          typeof parsed.gap === "string" && parsed.gap.trim().length > 0
            ? parsed.gap.trim()
            : (parsed.pass ? "No significant gap." : "Output did not meet expected criteria."),
        rationale:
          typeof parsed.rationale === "string" && parsed.rationale.trim().length > 0
            ? parsed.rationale.trim()
            : "Model verification fallback rationale.",
      };
    } catch {
      return this.fallbackVerification(output);
    }
  }

  private fallbackVerification(output: string): SubsessionTaskVerification {
    const pass = output.trim().length > 0;
    return {
      pass,
      score: pass ? 0.6 : 0.2,
      gap: pass ? "Heuristic verification passed with non-empty output." : "No output returned.",
      rationale: "Heuristic verification used due invalid verifier response.",
    };
  }

  private async reflectOnFailure(
    task: SubsessionTask,
    attempt: SubsessionTaskAttempt,
  ): Promise<SubsessionTaskReflection> {
    const messages: LlmMessage[] = [
      {
        role: "system",
        content: "You generate failure reflection and strategy adjustment. Return strict JSON only.",
      },
      {
        role: "user",
        content: [
          "Return JSON:",
          "{\"failure_reason\":\"string\",\"strategy_delta\":\"string\",\"next_instruction\":\"string\"}",
          "Task objective:",
          task.objective,
          "Expected output:",
          task.expectedOutput,
          "Observed output summary:",
          attempt.outputSummary,
          "Verification gap:",
          attempt.verification.gap,
        ].join("\n"),
      },
    ];

    try {
      const out = await this.provider.generateTurn({ messages });
      const parsed =
        out.type === "assistant"
          ? parseJson<ReflectionPayload>(out.content)
          : null;
      if (!parsed) return this.fallbackReflection(attempt);

      return {
        failureReason:
          typeof parsed.failure_reason === "string" && parsed.failure_reason.trim().length > 0
            ? parsed.failure_reason.trim()
            : attempt.verification.gap,
        strategyDelta:
          typeof parsed.strategy_delta === "string" && parsed.strategy_delta.trim().length > 0
            ? parsed.strategy_delta.trim()
            : "Change method or tool input materially before retry.",
        nextInstruction:
          typeof parsed.next_instruction === "string" && parsed.next_instruction.trim().length > 0
            ? parsed.next_instruction.trim()
            : "Retry with adjusted strategy and stricter verification expectations.",
      };
    } catch {
      return this.fallbackReflection(attempt);
    }
  }

  private fallbackReflection(attempt: SubsessionTaskAttempt): SubsessionTaskReflection {
    return {
      failureReason: attempt.verification.gap,
      strategyDelta: "Use a different method, input source, or validation path.",
      nextInstruction: "Retry the task with a non-identical strategy.",
    };
  }

  private buildTaskPrompt(
    plan: SubsessionPlan,
    task: SubsessionTask,
    reflection?: SubsessionTaskReflection,
  ): string {
    const lines = [
      `Sub-session goal: ${plan.goal}`,
      `Task ID: ${task.id}`,
      `Task objective: ${task.objective}`,
      `Expected output: ${task.expectedOutput}`,
      "Execution rule: perform concrete actions and conclude with a precise task result.",
    ];

    if (plan.constraints.length > 0) {
      lines.push(`Plan constraints: ${plan.constraints.join("; ")}`);
    }

    if (reflection) {
      lines.push(`Previous failure reason: ${reflection.failureReason}`);
      lines.push(`Required strategy change: ${reflection.strategyDelta}`);
      lines.push(`Next instruction: ${reflection.nextInstruction}`);
    }

    return lines.join("\n");
  }

  private buildTaskSystemContext(baseSystem: string, plan: SubsessionPlan): string {
    const policy = [
      "Maximum mode sub-session is active.",
      "Follow ACT -> VERIFY -> REFLECT discipline.",
      "Do not stop at partial progress for this task.",
      "Return only factual executed outcomes.",
      `Plan done criteria: ${plan.doneCriteria}`,
    ].join("\n");
    return `${baseSystem.trim()}\n\n${policy}`.trim();
  }

  private buildCompletionSummary(
    subsessionId: string,
    plan: SubsessionPlan,
    completedTaskIds: string[],
    verificationFiles: string[],
  ): string {
    const taskRows = plan.tasks
      .filter((task) => completedTaskIds.includes(task.id))
      .map((task) => {
        const last = task.attempts[task.attempts.length - 1];
        const summaryText = last?.outputSummary ?? "No output summary.";
        return `- ${task.id} (${task.title}): ${summaryText}`;
      });

    return [
      `Maximum sub-session ${subsessionId} completed.`,
      `Goal: ${plan.goal}`,
      `Completed tasks: ${completedTaskIds.length}/${plan.tasks.length}`,
      "Task outcomes:",
      taskRows.join("\n"),
      `Verification evidence files: ${verificationFiles.length}`,
    ]
      .filter((line) => line.trim().length > 0)
      .join("\n");
  }

  private buildContextMarkdown(input: MaxModeRunInput, subsessionId: string): string {
    return [
      `# Sub-session Context`,
      ``,
      `- Subsession ID: ${subsessionId}`,
      `- Parent session: ${input.mainSessionId}`,
      `- Parent run: ${input.mainRunId}`,
      `- Client: ${input.clientId}`,
      `- Created at: ${nowIso()}`,
      ``,
      `## User Request`,
      input.userContent,
    ].join("\n");
  }

  private async persistTasks(subsessionId: string, tasks: SubsessionTask[]): Promise<void> {
    for (const task of tasks) {
      await this.store.saveTask(subsessionId, task);
    }
  }

  private async emitPlan(clientId: string, subsessionId: string, plan: SubsessionPlan): Promise<void> {
    const tasks = plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      objective: task.objective,
      expectedOutput: task.expectedOutput,
      status: task.status,
    }));
    this.onReply?.(clientId, {
      type: "subsession_plan",
      subsessionId,
      revision: plan.revision,
      goal: plan.goal,
      doneCriteria: plan.doneCriteria,
      tasks,
    });
    await this.emitProgress(clientId, subsessionId, {
      type: plan.revision === 1 ? "plan_ready" : "plan_updated",
      message: `Plan revision ${plan.revision} ready with ${plan.tasks.length} task(s).`,
      revision: plan.revision,
    });
  }

  private async emitProgress(
    clientId: string,
    subsessionId: string,
    event: Omit<SubsessionProgressEvent, "ts" | "subsessionId">,
  ): Promise<void> {
    const payload: SubsessionProgressEvent = {
      ts: nowIso(),
      subsessionId,
      ...event,
    };
    await this.store.appendProgress(subsessionId, payload);
    this.onReply?.(clientId, {
      type: "subsession_progress",
      subsessionId: payload.subsessionId,
      ts: payload.ts,
      event: payload.type,
      message: payload.message,
      ...(payload.taskId ? { taskId: payload.taskId } : {}),
      ...(payload.taskTitle ? { taskTitle: payload.taskTitle } : {}),
      ...(payload.revision !== undefined ? { revision: payload.revision } : {}),
    });
  }

  private async log(
    subsessionId: string,
    event: SubsessionLogEvent["event"],
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.store.appendLog(subsessionId, {
      ts: nowIso(),
      subsessionId,
      event,
      details,
    });
  }

  private async resolveResumeSubsession(
    clientId: string,
    userContent: string,
  ): Promise<ResumeResolution> {
    const explicitId = this.extractSubsessionId(userContent);
    if (explicitId) {
      const snapshot = await this.store.loadSubsession(explicitId);
      if (snapshot && snapshot.meta.clientId === clientId && this.isResumableStatus(snapshot.meta.status)) {
        return {
          subsessionId: explicitId,
          reason: "explicit_id",
        };
      }
    }

    const metas = await this.store.listMetas(clientId);
    const candidates = metas
      .filter((meta) => this.isResumableStatus(meta.status))
      .slice(0, MAX_RESUME_CANDIDATES);

    if (candidates.length === 0) return { subsessionId: null };
    if (NEW_TASK_PATTERN.test(userContent)) return { subsessionId: null, reason: "forced_new_task" };

    const llmChoice = await this.selectResumeCandidateWithLlm(userContent, candidates);
    if (llmChoice.subsessionId) {
      return {
        subsessionId: llmChoice.subsessionId,
        reason: llmChoice.reason ?? "llm_selected_resume",
      };
    }

    if (!RESUME_PATTERN.test(userContent)) return { subsessionId: null };
    const candidate = candidates[0];
    return {
      subsessionId: candidate?.id ?? null,
      reason: candidate ? "resume_pattern_fallback" : undefined,
    };
  }

  private isResumableStatus(status: SubsessionMeta["status"]): boolean {
    return (
      status === "created" ||
      status === "running" ||
      status === "waiting_for_plan_update" ||
      status === "paused" ||
      status === "failed"
    );
  }

  private async selectResumeCandidateWithLlm(
    userContent: string,
    candidates: SubsessionMeta[],
  ): Promise<ResumeResolution> {
    const candidateLines = candidates
      .map((meta, index) => {
        return [
          `${index + 1}.`,
          `id=${meta.id}`,
          `status=${meta.status}`,
          `updated_at=${meta.updatedAt}`,
          `goal="${summarize(meta.goalSummary, 120)}"`,
        ].join(" ");
      })
      .join("\n");

    const messages: LlmMessage[] = [
      {
        role: "system",
        content:
          "You decide whether a new user request should resume an existing max-mode sub-session. Return strict JSON only.",
      },
      {
        role: "user",
        content: [
          "Return JSON:",
          "{\"action\":\"resume|new\",\"subsession_id\":\"uuid-or-null\",\"reason\":\"string\",\"confidence\":0.0}",
          "Use action=resume only if the request clearly depends on unfinished work in one candidate.",
          "If uncertain, return action=new.",
          "Request:",
          userContent,
          "Candidates:",
          candidateLines,
        ].join("\n"),
      },
    ];

    try {
      const out = await this.provider.generateTurn({ messages });
      if (out.type !== "assistant") return { subsessionId: null };
      const parsed = parseJson<ResumeSelectionPayload>(out.content);
      if (!parsed || (parsed.action !== "resume" && parsed.action !== "new")) {
        return { subsessionId: null };
      }
      if (parsed.action !== "resume") return { subsessionId: null, reason: parsed.reason };

      const selected =
        typeof parsed.subsession_id === "string"
          ? candidates.find((meta) => meta.id === parsed.subsession_id)
          : undefined;
      if (!selected) return { subsessionId: null };

      return {
        subsessionId: selected.id,
        reason:
          typeof parsed.reason === "string" && parsed.reason.trim().length > 0
            ? parsed.reason.trim()
            : "llm_selected_resume",
      };
    } catch {
      return { subsessionId: null };
    }
  }

  private extractSubsessionId(text: string): string | null {
    const match = text.match(UUID_PATTERN);
    return match?.[0] ?? null;
  }
}

export function buildMaxModeConfigFromEnv(): Partial<MaxModeConfig> {
  const readPositiveInt = (name: string): number | undefined => {
    const raw = process.env[name];
    if (!raw) return undefined;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return parsed;
  };

  const enabledRaw = process.env["IVEC_MAX_MODE_ENABLED"];
  const enabled =
    enabledRaw === undefined
      ? undefined
      : (enabledRaw === "1" || enabledRaw.toLowerCase() === "true");

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(process.env["IVEC_MAX_MODE_ROOT_DIR"] ? { rootDir: process.env["IVEC_MAX_MODE_ROOT_DIR"] } : {}),
    ...(readPositiveInt("IVEC_MAX_MODE_MAX_TASKS") ? { maxTasks: readPositiveInt("IVEC_MAX_MODE_MAX_TASKS")! } : {}),
    ...(readPositiveInt("IVEC_MAX_MODE_MAX_ATTEMPTS_PER_TASK")
      ? { maxAttemptsPerTask: readPositiveInt("IVEC_MAX_MODE_MAX_ATTEMPTS_PER_TASK")! }
      : {}),
    ...(readPositiveInt("IVEC_MAX_MODE_MAX_TOTAL_STEPS")
      ? { maxTotalSteps: readPositiveInt("IVEC_MAX_MODE_MAX_TOTAL_STEPS")! }
      : {}),
    ...(readPositiveInt("IVEC_MAX_MODE_MAX_NO_PROGRESS_CYCLES")
      ? { maxNoProgressCycles: readPositiveInt("IVEC_MAX_MODE_MAX_NO_PROGRESS_CYCLES")! }
      : {}),
    ...(readPositiveInt("IVEC_MAX_MODE_MAX_TASK_OUTPUT_CHARS")
      ? { maxTaskOutputChars: readPositiveInt("IVEC_MAX_MODE_MAX_TASK_OUTPUT_CHARS")! }
      : {}),
  };
}
