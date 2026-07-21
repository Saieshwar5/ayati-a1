import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ContextDatabase } from "./database/database.js";
import {
  ContextEngineObserver,
  type ContextEngineObservabilitySink,
} from "./observability.js";
import type { ContextEngineService } from "./service.js";
import { SqliteContextEngineService } from "./services/sqlite-context-engine-service.js";
import { ContextEngineWriterLock } from "./writer-lock.js";

export interface ContextEngineHostOptions {
  databasePath: string;
  rootDirectory: string;
  observabilitySink?: ContextEngineObservabilitySink;
}

export interface ContextEngineHost {
  service: ContextEngineService;
  stop(): Promise<void>;
}

/** Opens the daemon-owned Context Engine and its exclusive durable writer. */
export async function startContextEngineHost(
  options: ContextEngineHostOptions,
): Promise<ContextEngineHost> {
  const observer = new ContextEngineObserver("context-engine", options.observabilitySink);
  observer.emit({
    level: "info",
    event: "engine_starting",
    outcome: "started",
    data: {
      databasePath: options.databasePath,
      rootDirectory: options.rootDirectory,
    },
  });

  await mkdir(dirname(options.databasePath), { recursive: true });
  await mkdir(options.rootDirectory, { recursive: true });

  const lock = await ContextEngineWriterLock.acquire({
    path: options.databasePath + ".writer-lock",
    databasePath: options.databasePath,
  });
  observer.emit({
    level: lock.recoveredStaleOwner ? "warn" : "info",
    event: lock.recoveredStaleOwner ? "stale_writer_lock_recovered" : "writer_lock_acquired",
    outcome: "succeeded",
    data: { lockPath: lock.path },
  });

  let service: SqliteContextEngineService | undefined;
  let stopPromise: Promise<void> | undefined;
  try {
    await mkdir(join(options.rootDirectory, "workstreams"), { recursive: true });
    await mkdir(join(options.rootDirectory, "workspace"), { recursive: true });
    await mkdir(join(options.rootDirectory, ".ayati"), { recursive: true });

    const database = await ContextDatabase.open({ path: options.databasePath });
    service = new SqliteContextEngineService({
      database,
      rootDirectory: options.rootDirectory,
      observer,
    });
    const health = await service.getHealth();
    if (!health.ready) {
      throw new Error("Context Engine did not become ready during startup.");
    }
    observer.emit({
      level: "info",
      event: "engine_ready",
      outcome: "succeeded",
      data: { capabilities: health.capabilities },
    });

    const stop = async (): Promise<void> => {
      if (stopPromise) return await stopPromise;
      stopPromise = (async () => {
        observer.emit({ level: "info", event: "shutdown_started", outcome: "started" });
        let closeError: unknown;
        try {
          await service?.close();
        } catch (error) {
          closeError = error;
        }
        try {
          await lock.release();
        } catch (error) {
          closeError ??= error;
        }
        if (closeError) throw closeError;
        observer.emit({ level: "info", event: "shutdown_completed", outcome: "succeeded" });
      })();
      return await stopPromise;
    };

    return { service, stop };
  } catch (error) {
    observer.emit({
      level: "error",
      event: "startup_failed",
      outcome: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
    await service?.close().catch(() => undefined);
    await lock.release().catch(() => undefined);
    throw error;
  }
}
