import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  GIT_CONTEXT_PROTOCOL_VERSION,
  GitContextClient,
  GitContextObserver,
  GitContextServiceError,
  isGitContextObservabilityEvent,
  type ActiveContext,
  type AdoptTaskReferenceRequest,
  type AdoptTaskReferenceResponse,
  type ActivateTaskRunRequest,
  type AcquireMutationAuthorityRequest,
  type AcquireMutationAuthorityResponse,
  type BindTaskAttachmentsRequest,
  type BindTaskAttachmentsResponse,
  type AppendConversationRequest,
  type AppendConversationResponse,
  type CheckpointMutationRequest,
  type CheckpointMutationResponse,
  type CreateTaskRequest,
  type CreateTaskResponse,
  type CreateTaskRunRequest,
  type EnsureActiveSessionRequest,
  type EnsureActiveSessionResponse,
  type FinalizeSessionRunRequest,
  type FinalizeSessionRunResponse,
  type FinalizeTaskRunRequest,
  type FinalizeTaskRunResponse,
  type GetActiveContextRequest,
  type GetTaskRequest,
  type GetTaskResponse,
  type GitContextService,
  type GitContextObservabilityEvent,
  type GitContextObservabilitySink,
  type HealthResponse,
  type ListTasksRequest,
  type ListTasksResponse,
  type InventoryTaskMigrationsRequest,
  type InventoryTaskMigrationsResponse,
  type MigrateTaskRepositoryRequest,
  type MigrateTaskRepositoryResponse,
  type MountTaskRequest,
  type MountTaskResponse,
  type PlanTaskRequestRouteRequest,
  type PlanTaskRequestRouteResponse,
  type RecordRunStepRequest,
  type RecordRunStepResponse,
  type RecordSessionAttachmentsRequest,
  type RecordSessionAttachmentsResponse,
  type SelectedTaskRunResponse,
  type SnapshotTaskRunEvidenceRequest,
  type SnapshotTaskRunEvidenceResponse,
  type StartRunRequest,
  type StartRunResponse,
  type VerifyMutationRequest,
  type VerifyMutationResponse,
} from "ayati-git-context";
import { devLog, devWarn } from "../shared/index.js";
import type { GitContextRuntimeConfig } from "../config/runtime-config.js";

const require = createRequire(import.meta.url);

export interface ManagedGitContextProcessOptions extends GitContextRuntimeConfig {
  serverEntryPath?: string;
  environment?: NodeJS.ProcessEnv;
  onObservabilityEvent?: GitContextObservabilitySink;
}

export interface ManagedGitContextProcessStatus {
  managed: boolean;
  running: boolean;
  pid?: number;
  generation: number;
}

export async function startManagedGitContextProcess(
  options: ManagedGitContextProcessOptions,
): Promise<ManagedGitContextProcess> {
  const process = new ManagedGitContextProcess(options);
  await process.start();
  return process;
}

export class ManagedGitContextProcess implements GitContextService {
  private client: GitContextClient;
  private child: ChildProcess | undefined;
  private startPromise: Promise<void> | undefined;
  private stopping = false;
  private generation = 0;
  private outputTail = "";
  private stdoutBuffer = "";
  private readonly observer: GitContextObserver;

  constructor(private readonly options: ManagedGitContextProcessOptions) {
    this.client = this.createClient();
    this.observer = new GitContextObserver(
      "git-context-supervisor",
      options.onObservabilityEvent,
    );
  }

  async start(): Promise<void> {
    if (this.startPromise) return await this.startPromise;
    if (this.options.managed && !this.childHasExited()) return;
    const startPromise = this.startInternal();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.observer.emit({ level: "info", event: "child_shutdown_started", data: this.processData(child) });
    child.kill("SIGTERM");
    if (await waitForExit(child, this.options.stopTimeoutMs)) {
      this.observer.emit({ level: "info", event: "child_shutdown_completed", data: this.processData(child) });
      return;
    }
    devWarn("Git Context Engine did not stop in time; sending SIGKILL.");
    this.observer.emit({ level: "warn", event: "child_shutdown_forced", data: this.processData(child) });
    child.kill("SIGKILL");
    await waitForExit(child, Math.min(this.options.stopTimeoutMs, 2_000));
  }

  getStatus(): ManagedGitContextProcessStatus {
    const child = this.child;
    return {
      managed: this.options.managed,
      running: Boolean(child && child.exitCode === null && child.signalCode === null),
      ...(child?.pid ? { pid: child.pid } : {}),
      generation: this.generation,
    };
  }

  async getHealth(): Promise<HealthResponse> {
    return await this.invoke((client) => client.getHealth());
  }

  async getActiveContext(input: GetActiveContextRequest): Promise<ActiveContext> {
    return await this.invoke((client) => client.getActiveContext(input));
  }

  async ensureActiveSession(input: EnsureActiveSessionRequest): Promise<EnsureActiveSessionResponse> {
    return await this.invoke((client) => client.ensureActiveSession(input));
  }

  async appendConversation(input: AppendConversationRequest): Promise<AppendConversationResponse> {
    return await this.invoke((client) => client.appendConversation(input));
  }

  async createTask(input: CreateTaskRequest): Promise<CreateTaskResponse> {
    return await this.invoke((client) => client.createTask(input));
  }

  async createTaskRun(input: CreateTaskRunRequest): Promise<SelectedTaskRunResponse> {
    return await this.invoke((client) => client.createTaskRun(input));
  }

  async activateTaskRun(input: ActivateTaskRunRequest): Promise<SelectedTaskRunResponse> {
    return await this.invoke((client) => client.activateTaskRun(input));
  }

  async planTaskRequestRoute(
    input: PlanTaskRequestRouteRequest,
  ): Promise<PlanTaskRequestRouteResponse> {
    return await this.invoke((client) => client.planTaskRequestRoute(input));
  }

  async listTasks(input: ListTasksRequest): Promise<ListTasksResponse> {
    return await this.invoke((client) => client.listTasks(input));
  }

  async inventoryTaskMigrations(
    input: InventoryTaskMigrationsRequest,
  ): Promise<InventoryTaskMigrationsResponse> {
    return await this.invoke((client) => client.inventoryTaskMigrations(input));
  }

  async migrateTaskRepository(
    input: MigrateTaskRepositoryRequest,
  ): Promise<MigrateTaskRepositoryResponse> {
    return await this.invoke((client) => client.migrateTaskRepository(input));
  }

  async getTask(input: GetTaskRequest): Promise<GetTaskResponse> {
    return await this.invoke((client) => client.getTask(input));
  }

  async mountTask(input: MountTaskRequest): Promise<MountTaskResponse> {
    return await this.invoke((client) => client.mountTask(input));
  }

  async recordSessionAttachments(
    input: RecordSessionAttachmentsRequest,
  ): Promise<RecordSessionAttachmentsResponse> {
    return await this.invoke((client) => client.recordSessionAttachments(input));
  }

  async bindTaskAttachments(
    input: BindTaskAttachmentsRequest,
  ): Promise<BindTaskAttachmentsResponse> {
    return await this.invoke((client) => client.bindTaskAttachments(input));
  }

  async adoptTaskReference(
    input: AdoptTaskReferenceRequest,
  ): Promise<AdoptTaskReferenceResponse> {
    return await this.invoke((client) => client.adoptTaskReference(input));
  }

  async acquireMutationAuthority(
    input: AcquireMutationAuthorityRequest,
  ): Promise<AcquireMutationAuthorityResponse> {
    return await this.invoke((client) => client.acquireMutationAuthority(input));
  }

  async verifyMutation(input: VerifyMutationRequest): Promise<VerifyMutationResponse> {
    return await this.invoke((client) => client.verifyMutation(input));
  }

  async checkpointMutation(input: CheckpointMutationRequest): Promise<CheckpointMutationResponse> {
    return await this.invoke((client) => client.checkpointMutation(input));
  }

  async snapshotTaskRunEvidence(
    input: SnapshotTaskRunEvidenceRequest,
  ): Promise<SnapshotTaskRunEvidenceResponse> {
    return await this.invoke((client) => client.snapshotTaskRunEvidence(input));
  }

  async finalizeTaskRun(input: FinalizeTaskRunRequest): Promise<FinalizeTaskRunResponse> {
    return await this.invoke((client) => client.finalizeTaskRun(input));
  }

  async finalizeSessionRun(input: FinalizeSessionRunRequest): Promise<FinalizeSessionRunResponse> {
    return await this.invoke((client) => client.finalizeSessionRun(input));
  }

  async startRun(input: StartRunRequest): Promise<StartRunResponse> {
    return await this.invoke((client) => client.startRun(input));
  }

  async recordRunStep(input: RecordRunStepRequest): Promise<RecordRunStepResponse> {
    return await this.invoke((client) => client.recordRunStep(input));
  }

  private async startInternal(): Promise<void> {
    this.stopping = false;
    try {
      if (this.options.managed) this.spawnChild();
      await this.waitUntilReady();
    } catch (error) {
      this.observer.emit({
        level: "error",
        event: "supervisor_startup_failed",
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
        data: { generation: this.generation },
      });
      await this.stop();
      throw error;
    }
  }

  private spawnChild(): void {
    const existing = this.child;
    if (existing && existing.exitCode === null && existing.signalCode === null) return;
    const entry = this.options.serverEntryPath ?? resolveServerEntry();
    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        ...this.options.environment,
        AYATI_GIT_CONTEXT_DATABASE: this.options.databasePath,
        AYATI_GIT_CONTEXT_DATA_DIR: this.options.dataRoot,
        AYATI_GIT_CONTEXT_WORKSPACE_DIR: this.options.workspaceRoot,
        AYATI_GIT_CONTEXT_SOCKET: this.options.socketPath,
        AYATI_GIT_CONTEXT_PARENT_PID: String(process.pid),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.generation += 1;
    this.outputTail = "";
    this.stdoutBuffer = "";
    this.observer.emit({ level: "info", event: "child_spawned", data: this.processData(child) });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      this.captureOutput(chunk);
      this.captureStructuredStdout(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.captureOutput(chunk);
      const message = String(chunk).trim();
      if (message) {
        devWarn("[git-context] " + message);
        this.observer.emit({
          level: "warn",
          event: "child_stderr",
          message: message.slice(0, 1_000),
          data: this.processData(child),
        });
      }
    });
    child.once("error", (error) => {
      this.captureOutput(error.message);
      this.observer.emit({
        level: "error",
        event: "child_process_error",
        message: error.message,
        data: this.processData(child),
      });
    });
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = undefined;
      this.observer.emit({
        level: this.stopping ? "info" : "error",
        event: "child_exit_observed",
        outcome: this.stopping ? "succeeded" : "failed",
        data: { ...this.processData(child), exitKind: this.stopping ? "expected" : "unexpected", code, signal },
      });
      if (!this.stopping) {
        devWarn(`Git Context Engine exited unexpectedly (code=${code ?? "none"}, signal=${signal ?? "none"}).`);
      }
    });
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.options.startTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (this.options.managed && this.childHasExited()) {
        throw new Error(this.startupFailureMessage("Git Context Engine exited before readiness."));
      }
      try {
        const health = await this.client.getHealth();
        if (!health.ready) throw new Error("Git Context Engine reported degraded readiness.");
        if (health.protocolVersion !== GIT_CONTEXT_PROTOCOL_VERSION) {
          throw new ProtocolMismatchError(
            `Git Context Engine protocol mismatch: client=${GIT_CONTEXT_PROTOCOL_VERSION}, server=${health.protocolVersion}.`,
          );
        }
        this.observer.emit({
          level: "info",
          event: "child_ready",
          outcome: "succeeded",
          data: {
            ...this.processData(this.child),
            protocolVersion: health.protocolVersion,
            capabilities: health.capabilities,
          },
        });
        return;
      } catch (error) {
        if (error instanceof ProtocolMismatchError) throw error;
        lastError = error;
        await delay(50);
      }
    }
    await this.stop();
    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
    throw new Error(this.startupFailureMessage("Git Context Engine readiness timed out: " + detail));
  }

  private async invoke<T>(operation: (client: GitContextClient) => Promise<T>): Promise<T> {
    const generation = this.generation;
    try {
      return await operation(this.client);
    } catch (error) {
      if (!this.options.managed || this.stopping || !isTransportFailure(error)) throw error;
      if (generation === this.generation && !this.childHasExited()) throw error;
      this.observer.emit({
        level: "warn",
        event: "request_retry_after_child_exit",
        outcome: "started",
        message: error instanceof Error ? error.message : String(error),
        data: { failedGeneration: generation, currentGeneration: this.generation },
      });
      await this.restartAfterCrash();
      return await operation(this.client);
    }
  }

  private async restartAfterCrash(): Promise<void> {
    if (this.startPromise) return await this.startPromise;
    this.startPromise = (async () => {
      const previousGeneration = this.generation;
      this.observer.emit({ level: "warn", event: "child_restart_started", data: { previousGeneration } });
      try {
        this.spawnChild();
        await this.waitUntilReady();
        this.observer.emit({
          level: "info",
          event: "child_restart_completed",
          outcome: "succeeded",
          data: { previousGeneration, generation: this.generation },
        });
      } catch (error) {
        this.observer.emit({
          level: "error",
          event: "child_restart_failed",
          outcome: "failed",
          message: error instanceof Error ? error.message : String(error),
          data: { previousGeneration, generation: this.generation },
        });
        throw error;
      }
    })().finally(() => {
      this.startPromise = undefined;
    });
    return await this.startPromise;
  }

  private childHasExited(): boolean {
    return !this.child || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private createClient(): GitContextClient {
    return new GitContextClient({
      connection: { socketPath: this.options.socketPath },
      timeoutMs: this.options.requestTimeoutMs,
    });
  }

  private captureOutput(value: Buffer | string): void {
    this.outputTail = (this.outputTail + String(value)).slice(-8_000);
  }

  private captureStructuredStdout(value: Buffer | string): void {
    this.stdoutBuffer += String(value);
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) this.forwardChildOutputLine(line);
  }

  private forwardChildOutputLine(line: string): void {
    const message = line.trim();
    if (!message) return;
    try {
      const parsed: unknown = JSON.parse(message);
      if (isGitContextObservabilityEvent(parsed)) {
        const event: GitContextObservabilityEvent = {
          ...parsed,
          data: { ...parsed.data, processGeneration: this.generation },
        };
        this.options.onObservabilityEvent?.(event);
        return;
      }
    } catch {
      // Report unstructured output without losing the child process diagnostics.
    }
    devLog("[git-context] " + message);
    this.observer.emit({
      level: "warn",
      event: "child_output_unstructured",
      message: message.slice(0, 1_000),
      data: { generation: this.generation },
    });
  }

  private processData(child: ChildProcess | undefined): Record<string, unknown> {
    return {
      generation: this.generation,
      ...(child?.pid ? { childPid: child.pid } : {}),
    };
  }

  private startupFailureMessage(message: string): string {
    const output = this.outputTail.trim();
    return output ? message + " Child output: " + output : message;
  }
}

function resolveServerEntry(): string {
  return join(dirname(require.resolve("ayati-git-context")), "server-main.js");
}

function isTransportFailure(error: unknown): boolean {
  return error instanceof GitContextServiceError && error.code === "SERVICE_UNAVAILABLE";
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class ProtocolMismatchError extends Error {}
