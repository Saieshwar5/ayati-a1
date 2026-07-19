import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ContextDatabase } from "./database/database.js";
import { GitContextProcessLock } from "./process-lock.js";
import { GitContextHttpServer, type GitContextServerAddress } from "./server.js";
import { SqliteGitContextService } from "./services/sqlite-git-context-service.js";
import {
  GitContextObserver,
  type GitContextObservabilitySink,
} from "./observability.js";

export interface GitContextServerRuntimeOptions {
  databasePath: string;
  dataRoot: string;
  workspaceRoot?: string;
  timezone?: string;
  agentId?: string;
  socketPath: string;
  parentPid?: number;
  parentPollIntervalMs?: number;
  observabilitySink?: GitContextObservabilitySink;
}

export interface GitContextServerRuntime {
  address: GitContextServerAddress;
  stop(): Promise<void>;
}

export async function startGitContextServerRuntime(
  options: GitContextServerRuntimeOptions,
): Promise<GitContextServerRuntime> {
  const observer = new GitContextObserver("git-context-engine", options.observabilitySink);
  const httpObserver = new GitContextObserver("git-context-http", options.observabilitySink);
  observer.emit({
    level: "info",
    event: "process_starting",
    outcome: "started",
    data: { databasePath: options.databasePath, dataRoot: options.dataRoot, socketPath: options.socketPath },
  });
  await mkdir(dirname(options.databasePath), { recursive: true });
  await mkdir(options.dataRoot, { recursive: true });
  const lock = await GitContextProcessLock.acquire({
    path: options.databasePath + ".writer-lock",
    databasePath: options.databasePath,
  });
  observer.emit({
    level: lock.recoveredStaleOwner ? "warn" : "info",
    event: lock.recoveredStaleOwner ? "stale_writer_lock_recovered" : "writer_lock_acquired",
    outcome: "succeeded",
    data: { lockPath: lock.path },
  });
  let service: SqliteGitContextService | undefined;
  let server: GitContextHttpServer | undefined;
  let parentTimer: NodeJS.Timeout | undefined;
  let stopPromise: Promise<void> | undefined;
  try {
    const database = await ContextDatabase.open({ path: options.databasePath });
    const workspaceRoot = options.workspaceRoot ?? join(options.dataRoot, "workspace");
    await mkdir(join(workspaceRoot, "tasks"), { recursive: true });
    service = new SqliteGitContextService({
      database,
      dataRoot: options.dataRoot,
      workspaceRoot,
      observer,
    });
    const at = new Date().toISOString();
    const timezone = options.timezone ?? "UTC";
    const agentId = options.agentId ?? "local";
    const date = localDate(at, timezone);
    await service.ensureActiveSession({
      requestId: `startup-session:${date}:${agentId}`,
      date,
      timezone,
      agentId,
    });
    await service.getHealth();
    server = new GitContextHttpServer({
      service,
      listen: { socketPath: options.socketPath },
      observer: httpObserver,
    });
    const address = await server.start();

    const stop = async (): Promise<void> => {
      if (stopPromise) return await stopPromise;
      stopPromise = (async () => {
        observer.emit({ level: "info", event: "shutdown_started", outcome: "started" });
        if (parentTimer) clearInterval(parentTimer);
        await server?.stop();
        await service?.close();
        await lock.release();
        observer.emit({ level: "info", event: "shutdown_completed", outcome: "succeeded" });
      })();
      return await stopPromise;
    };

    if (options.parentPid && options.parentPid > 0) {
      parentTimer = setInterval(() => {
        if (!isProcessAlive(options.parentPid!)) {
          observer.emit({
            level: "warn",
            event: "parent_process_missing",
            outcome: "failed",
            data: { parentPid: options.parentPid },
          });
          void stop();
        }
      }, options.parentPollIntervalMs ?? 1_000);
      parentTimer.unref();
    }
    return { address, stop };
  } catch (error) {
    observer.emit({
      level: "error",
      event: "startup_failed",
      outcome: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
    if (parentTimer) clearInterval(parentTimer);
    await server?.stop().catch(() => undefined);
    await service?.close().catch(() => undefined);
    await lock.release().catch(() => undefined);
    throw error;
  }
}

function localDate(at: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
