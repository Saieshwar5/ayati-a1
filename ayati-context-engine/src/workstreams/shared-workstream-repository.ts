import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ContextDatabase } from "../database/database.js";
import { ContextEngineServiceError } from "../errors.js";
import { gitCommitEnvironment, runGit } from "../git/git-process.js";
import {
  initializeSharedWorkstreamRepositoryState,
  markSharedWorkstreamRepositoryHealth,
  readSharedWorkstreamRepositoryState,
  type SharedWorkstreamRepositoryState,
} from "../repositories/workstream-repository-state-records.js";

export async function ensureSharedWorkstreamRepository(input: {
  database: ContextDatabase;
  workstreamRoot: string;
  at: string;
}): Promise<SharedWorkstreamRepositoryState> {
  await mkdir(input.workstreamRoot, { recursive: true });
  const root = await realpath(input.workstreamRoot);
  const gitPath = join(root, ".git");
  const gitExists = await lstat(gitPath).then(() => true).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (!gitExists) {
    const entries = (await readdir(root)).filter((entry) => entry !== ".git");
    if (entries.length > 0) {
      throw recovery("Existing workstream directories require the one-time shared-repository migration.", {
        workstreamRoot: root,
        entries: entries.slice(0, 20),
      });
    }
    await runGit(["init", "--initial-branch=main"], { cwd: root });
    await runGit([
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "initialize shared workstream notebook",
    ], {
      cwd: root,
      env: gitCommitEnvironment(input.at),
    });
  }
  const gitRoot = resolve(await runGit(["rev-parse", "--show-toplevel"], { cwd: root }));
  const branch = await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: root });
  const bare = await runGit(["rev-parse", "--is-bare-repository"], { cwd: root });
  if (gitRoot !== resolve(root) || branch !== "main" || bare !== "false") {
    throw recovery("Shared workstream repository identity is invalid.", {
      expectedRoot: root,
      actualRoot: gitRoot,
      branch,
      bare,
    });
  }
  await rejectNestedRepositories(root);
  const head = await runGit(["rev-parse", "HEAD"], { cwd: root });
  const status = await runGit(["status", "--porcelain", "--untracked-files=all"], { cwd: root });
  const health = status ? "dirty_external" as const : "ready" as const;
  const existing = readSharedWorkstreamRepositoryState(input.database);
  if (existing && (resolve(existing.repositoryPath) !== resolve(root)
    || existing.branch !== "main")) {
    throw recovery("SQLite points at a different shared workstream repository.", {
      sqliteRepositoryPath: existing.repositoryPath,
      actualRepositoryPath: root,
    });
  }
  const state = initializeSharedWorkstreamRepositoryState(input.database, {
    repositoryPath: root,
    branch: "main",
    head,
    health: existing?.head === head ? health : existing ? "recovery_required" : health,
    updatedAt: input.at,
  });
  if (existing?.head === head && state.health !== health) {
    markSharedWorkstreamRepositoryHealth(input.database, health, input.at);
    return { ...state, health, updatedAt: input.at };
  }
  return state;
}

async function rejectNestedRepositories(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("W-")) continue;
    const nested = join(root, entry.name, ".git");
    const exists = await lstat(nested).then(() => true).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (exists) {
      throw recovery("Nested workstream Git repositories are not supported.", {
        nestedRepository: nested,
      });
    }
  }
}

function recovery(
  message: string,
  details?: Record<string, unknown>,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "RECOVERY_REQUIRED",
    message,
    ...(details ? { details } : {}),
  });
}
