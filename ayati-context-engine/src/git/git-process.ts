import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export async function runGit(
  args: string[],
  options: GitCommandOptions,
): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}

export async function runGitRaw(
  args: string[],
  options: GitCommandOptions,
): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

export async function configureAyatiGitIdentity(repositoryPath: string): Promise<void> {
  await runGit(["config", "user.name", "Ayati Context Engine"], {
    cwd: repositoryPath,
  });
  await runGit(["config", "user.email", "git-context@ayati.local"], {
    cwd: repositoryPath,
  });
  await runGit(["config", "commit.gpgsign", "false"], {
    cwd: repositoryPath,
  });
}

export function gitCommitEnvironment(at: string): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: "Ayati Context Engine",
    GIT_AUTHOR_EMAIL: "git-context@ayati.local",
    GIT_COMMITTER_NAME: "Ayati Context Engine",
    GIT_COMMITTER_EMAIL: "git-context@ayati.local",
    GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_DATE: at,
  };
}
