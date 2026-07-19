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
  type ActivateWorkstreamForRunRequest,
  type BindResourcesForRunRequest,
  type BindResourcesForRunResponse,
  type CreateWorkstreamForRunRequest,
  type EnsureActiveSessionRequest,
  type EnsureActiveSessionResponse,
  type FinalizeRunRequest,
  type FinalizeRunResponse,
  type FindResourcesRequest,
  type FindResourcesResponse,
  type FindWorkstreamsRequest,
  type FindWorkstreamsResponse,
  type GetActiveContextRequest,
  type GetWorkstreamRequest,
  type GetWorkstreamResponse,
  type GitContextService,
  type GitContextObservabilityEvent,
  type GitContextObservabilitySink,
  type HealthResponse,
  type InspectResourceForRunRequest,
  type InspectResourceForRunResponse,
  type ListWorkstreamsRequest,
  type ListWorkstreamsResponse,
  type PlanWorkstreamRequestRouteRequest,
  type PlanWorkstreamRequestRouteResponse,
  type PrepareResourceMutationRequest,
  type PrepareResourceMutationResponse,
  type PrepareContextTurnRequest,
  type PrepareContextTurnResponse,
  type ReadWorkstreamRequest,
  type ReadWorkstreamResponse,
  type RecordRunStepRequest,
  type RecordRunStepResponse,
  type SelectedWorkstreamForRunResponse,
  type SetWorkstreamStarRequest,
  type SetWorkstreamStarResponse,
  type VerifyResourceMutationRequest,
  type VerifyResourceMutationResponse,
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

  async prepareContextTurn(
    input: PrepareContextTurnRequest,
  ): Promise<PrepareContextTurnResponse> {
    return await this.invoke((client) => client.prepareContextTurn(input));
  }

  async ensureActiveSession(input: EnsureActiveSessionRequest): Promise<EnsureActiveSessionResponse> {
    return await this.invoke((client) => client.ensureActiveSession(input));
  }

  async createWorkstreamForRun(
    input: CreateWorkstreamForRunRequest,
  ): Promise<SelectedWorkstreamForRunResponse> {
    return await this.invoke((client) => client.createWorkstreamForRun(input));
  }

  async activateWorkstreamForRun(
    input: ActivateWorkstreamForRunRequest,
  ): Promise<SelectedWorkstreamForRunResponse> {
    return await this.invoke((client) => client.activateWorkstreamForRun(input));
  }

  async planWorkstreamRequestRoute(
    input: PlanWorkstreamRequestRouteRequest,
  ): Promise<PlanWorkstreamRequestRouteResponse> {
    return await this.invoke((client) => client.planWorkstreamRequestRoute(input));
  }

  async listWorkstreams(input: ListWorkstreamsRequest): Promise<ListWorkstreamsResponse> {
    return await this.invoke((client) => client.listWorkstreams(input));
  }

  async findWorkstreams(input: FindWorkstreamsRequest): Promise<FindWorkstreamsResponse> {
    return await this.invoke((client) => client.findWorkstreams(input));
  }

  async getWorkstream(input: GetWorkstreamRequest): Promise<GetWorkstreamResponse> {
    return await this.invoke((client) => client.getWorkstream(input));
  }

  async readWorkstream(input: ReadWorkstreamRequest): Promise<ReadWorkstreamResponse> {
    return await this.invoke((client) => client.readWorkstream(input));
  }

  async setWorkstreamStar(input: SetWorkstreamStarRequest): Promise<SetWorkstreamStarResponse> {
    return await this.invoke((client) => client.setWorkstreamStar(input));
  }

  async findResources(input: FindResourcesRequest): Promise<FindResourcesResponse> {
    return await this.invoke((client) => client.findResources(input));
  }

  async inspectResourceForRun(
    input: InspectResourceForRunRequest,
  ): Promise<InspectResourceForRunResponse> {
    return await this.invoke((client) => client.inspectResourceForRun(input));
  }

  async bindResourcesForRun(
    input: BindResourcesForRunRequest,
  ): Promise<BindResourcesForRunResponse> {
    return await this.invoke((client) => client.bindResourcesForRun(input));
  }

  async prepareResourceMutation(
    input: PrepareResourceMutationRequest,
  ): Promise<PrepareResourceMutationResponse> {
    return await this.invoke((client) => client.prepareResourceMutation(input));
  }

  async verifyResourceMutation(
    input: VerifyResourceMutationRequest,
  ): Promise<VerifyResourceMutationResponse> {
    return await this.invoke((client) => client.verifyResourceMutation(input));
  }

  async finalizeRun(input: FinalizeRunRequest): Promise<FinalizeRunResponse> {
    return await this.invoke((client) => client.finalizeRun(input));
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
        AYATI_ROOT_DIR: this.options.rootDirectory,
        AYATI_GIT_CONTEXT_DATABASE: this.options.databasePath,
        AYATI_GIT_CONTEXT_SOCKET: this.options.socketPath,
        AYATI_GIT_CONTEXT_TIMEZONE: this.options.timezone,
        AYATI_GIT_CONTEXT_AGENT_ID: this.options.agentId,
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
