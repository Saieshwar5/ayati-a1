import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface LockMetadata {
  pid: number;
  startedAt: string;
  databasePath: string;
}

export class ContextEngineWriterLock {
  private released = false;

  private constructor(
    readonly path: string,
    private readonly metadata: LockMetadata,
    readonly recoveredStaleOwner: boolean,
  ) {}

  static async acquire(input: {
    path: string;
    databasePath: string;
    startedAt?: string;
  }): Promise<ContextEngineWriterLock> {
    const metadata: LockMetadata = {
      pid: process.pid,
      startedAt: input.startedAt ?? new Date().toISOString(),
      databasePath: input.databasePath,
    };
    let recoveredStaleOwner = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(input.path);
        await writeFile(join(input.path, "owner.json"), JSON.stringify(metadata, null, 2) + "\n", {
          encoding: "utf8",
          flag: "wx",
        });
        return new ContextEngineWriterLock(input.path, metadata, recoveredStaleOwner);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const owner = await readLockMetadata(input.path);
        if (owner && isProcessAlive(owner.pid)) {
          throw new Error(
            "Context Engine storage already has a live writer (pid "
              + owner.pid + "): " + owner.databasePath,
          );
        }
        await rm(input.path, { recursive: true, force: true });
        recoveredStaleOwner = true;
      }
    }
    throw new Error("Could not acquire Context Engine writer lock: " + input.path);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const owner = await readLockMetadata(this.path);
    if (owner?.pid === this.metadata.pid && owner.startedAt === this.metadata.startedAt) {
      await rm(this.path, { recursive: true, force: true });
    }
  }
}

async function readLockMetadata(path: string): Promise<LockMetadata | undefined> {
  try {
    const value = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as Partial<LockMetadata>;
    return Number.isInteger(value.pid) && typeof value.startedAt === "string"
      && typeof value.databasePath === "string"
      ? value as LockMetadata
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "EEXIST";
}
