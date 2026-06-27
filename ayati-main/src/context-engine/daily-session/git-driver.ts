import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { GitRef } from "./refs.js";

export interface GitRefRecord {
  ref: GitRef;
  objectId: string;
}

export interface GitLogEntry {
  commit: string;
  message: string;
}

export interface CommitFilesInput {
  ref: GitRef;
  files: Record<string, string>;
  message: string;
  parentRef?: GitRef;
}

interface RunGitOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export class GitDriver {
  constructor(readonly repoPath: string) {}

  static async initBare(repoPath: string): Promise<GitDriver> {
    await mkdir(dirname(repoPath), { recursive: true });
    await runGit(["init", "--bare", repoPath]);
    const driver = new GitDriver(repoPath);
    await driver.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
    return driver;
  }

  async hasRef(ref: GitRef): Promise<boolean> {
    const result = await this.run(["rev-parse", "--verify", `${ref}^{commit}`], { allowFailure: true });
    return result.exitCode === 0;
  }

  async resolveRef(ref: GitRef): Promise<string | null> {
    const result = await this.run(["rev-parse", "--verify", `${ref}^{commit}`], { allowFailure: true });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async readFile(ref: GitRef, path: string): Promise<string | null> {
    const result = await this.run(["show", `${ref}:${path}`], { allowFailure: true });
    return result.exitCode === 0 ? result.stdout : null;
  }

  async listRefs(prefix: string): Promise<GitRefRecord[]> {
    const output = await this.mustRun(["for-each-ref", "--format=%(refname)%00%(objectname)", prefix]);
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [ref = "", objectId = ""] = line.split("\0");
        return { ref, objectId };
      })
      .filter((record) => record.ref && record.objectId);
  }

  async listTreePaths(ref: GitRef, prefix: string): Promise<string[]> {
    const result = await this.run(["ls-tree", "-r", "--name-only", ref, prefix], { allowFailure: true });
    if (result.exitCode !== 0) {
      return [];
    }
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  async setSymbolicRef(ref: GitRef, target: GitRef): Promise<void> {
    await this.mustRun(["symbolic-ref", ref, target]);
  }

  async readSymbolicRef(ref: GitRef): Promise<GitRef | null> {
    const result = await this.run(["symbolic-ref", "-q", ref], { allowFailure: true });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async updateRef(ref: GitRef, commit: string): Promise<void> {
    await this.mustRun(["update-ref", ref, commit]);
  }

  async commitFiles(input: CommitFilesInput): Promise<string> {
    const parent = input.parentRef
      ? await this.resolveRef(input.parentRef)
      : await this.resolveRef(input.ref);
    const indexPath = join(tmpdir(), `ayati-git-index-${randomUUID()}`);
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
      await this.updateRef(input.ref, commit);
      return commit;
    } finally {
      await unlink(indexPath).catch(() => undefined);
    }
  }

  async log(ref: GitRef, limit: number): Promise<GitLogEntry[]> {
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
      .filter((entry): entry is GitLogEntry => entry !== null);
  }

  private async mustRun(args: string[], options?: Omit<RunGitOptions, "allowFailure">): Promise<string> {
    const result = await this.run(args, options);
    return result.stdout;
  }

  private async run(args: string[], options?: RunGitOptions): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return await runGit(["--git-dir", this.repoPath, ...args], options);
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
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0 || options?.allowFailure) {
        resolve({ stdout, stderr, exitCode });
        return;
      }
      reject(new GitCommandError(`git ${args.join(" ")} failed`, args, exitCode, stderr));
    });
    child.stdin.end(options?.input ?? "");
  });
}
