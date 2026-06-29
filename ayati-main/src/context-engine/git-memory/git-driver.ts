import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export interface GitMemoryLogEntry {
  commit: string;
  message: string;
}

export interface GitMemoryCommitFilesInput {
  files: Record<string, string>;
  message: string;
}

export interface GitMemorySyntheticCommitInput {
  ref: string;
  files: Record<string, string>;
  message: string;
  parentRef?: string;
}

interface RunGitOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
}

export class GitMemoryGitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export class GitMemoryWorktreeGitDriver {
  constructor(readonly repoPath: string) {}

  static async init(repoPath: string): Promise<GitMemoryWorktreeGitDriver> {
    await mkdir(repoPath, { recursive: true });
    const driver = new GitMemoryWorktreeGitDriver(repoPath);
    if (!(await pathExists(join(repoPath, ".git")))) {
      await runGit(["init", repoPath]);
      await driver.mustRun(["symbolic-ref", "HEAD", "refs/heads/main"]);
    }
    return driver;
  }

  async hasRef(ref: string): Promise<boolean> {
    const result = await this.run(["rev-parse", "--verify", `${ref}^{commit}`], { allowFailure: true });
    return result.exitCode === 0;
  }

  async currentBranch(): Promise<string | null> {
    const result = await this.run(["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true });
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  }

  async readFile(ref: string, path: string): Promise<string | null> {
    const result = await this.run(["show", `${ref}:${path}`], { allowFailure: true });
    return result.exitCode === 0 ? result.stdout : null;
  }

  async listTreePaths(ref: string, prefix: string): Promise<string[]> {
    const result = await this.run(["ls-tree", "-r", "--name-only", ref, prefix], { allowFailure: true });
    if (result.exitCode !== 0) {
      return [];
    }
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  async readWorkingFile(path: string): Promise<string | null> {
    try {
      return await readFile(join(this.repoPath, path), "utf-8");
    } catch {
      return null;
    }
  }

  async writeWorkingFiles(files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      const absolutePath = join(this.repoPath, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf-8");
    }
  }

  async commitFiles(input: GitMemoryCommitFilesInput): Promise<string> {
    await this.writeWorkingFiles(input.files);
    const commit = await this.commitPaths(Object.keys(input.files), input.message);
    if (!commit) {
      throw new Error("No changes to commit.");
    }
    return commit;
  }

  async commitPaths(paths: string[], message: string): Promise<string | null> {
    if (paths.length === 0) {
      return null;
    }
    await this.mustRun(["add", "--", ...paths]);
    const diff = await this.run(["diff", "--cached", "--quiet"], { allowFailure: true });
    if (diff.exitCode === 0) {
      return null;
    }
    await this.mustRun(["commit", "--file", "-"], { input: message });
    return (await this.mustRun(["rev-parse", "HEAD"])).trim();
  }

  async commitSyntheticFiles(input: GitMemorySyntheticCommitInput): Promise<string> {
    const parent = input.parentRef
      ? await this.resolveRef(input.parentRef)
      : await this.resolveRef(input.ref);
    const indexPath = join(tmpdir(), `ayati-git-memory-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: indexPath };
    try {
      if (parent) {
        await this.mustRun(["read-tree", parent], { env });
      } else {
        await this.mustRun(["read-tree", "--empty"], { env });
      }
      for (const [path, content] of Object.entries(input.files)) {
        const blob = (await this.mustRun(["hash-object", "-w", "--stdin"], { input: content })).trim();
        await this.mustRun(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
      }
      const tree = (await this.mustRun(["write-tree"], { env })).trim();
      const commitArgs = parent
        ? ["commit-tree", tree, "-p", parent]
        : ["commit-tree", tree];
      const commit = (await this.mustRun(commitArgs, { input: input.message })).trim();
      await this.mustRun(["update-ref", input.ref, commit]);
      return commit;
    } finally {
      await unlink(indexPath).catch(() => undefined);
    }
  }

  async resolveRef(ref: string): Promise<string | null> {
    const result = await this.run(["rev-parse", "--verify", `${ref}^{commit}`], { allowFailure: true });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async log(ref: string, limit: number): Promise<GitMemoryLogEntry[]> {
    const safeLimit = Math.max(1, Math.floor(limit));
    const result = await this.run(["log", "-n", String(safeLimit), "--format=%H%x1f%B%x1e", ref], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) {
      return [];
    }
    return result.stdout
      .split("\x1e")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("\x1f");
        if (separator < 0) {
          return null;
        }
        return {
          commit: entry.slice(0, separator).trim(),
          message: entry.slice(separator + 1).trimEnd(),
        };
      })
      .filter((entry): entry is GitMemoryLogEntry => entry !== null);
  }

  private async mustRun(args: string[], options?: Omit<RunGitOptions, "allowFailure">): Promise<string> {
    const result = await this.run(args, options);
    return result.stdout;
  }

  private async run(
    args: string[],
    options?: RunGitOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return await runGit(["-C", this.repoPath, ...args], options);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runGit(
  args: string[],
  options?: RunGitOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Ayati",
        GIT_AUTHOR_EMAIL: "ayati@example.local",
        GIT_COMMITTER_NAME: "Ayati",
        GIT_COMMITTER_EMAIL: "ayati@example.local",
        ...options?.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let stdinError: Error | undefined;
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") {
        return;
      }
      stdinError = err;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (stdinError && exitCode === 0 && !options?.allowFailure) {
        reject(stdinError);
        return;
      }
      if (exitCode === 0 || options?.allowFailure) {
        resolve({ stdout, stderr, exitCode });
        return;
      }
      reject(new GitMemoryGitError(`git ${args.join(" ")} failed`, args, exitCode, stderr));
    });
    try {
      child.stdin.end(options?.input ?? "");
    } catch (err) {
      stdinError = err instanceof Error ? err : new Error(String(err));
    }
  });
}
