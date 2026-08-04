import { execFile } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export interface GitProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitReadProcessError extends Error {
  readonly code = "GIT_READ_PROCESS_FAILED";

  constructor(
    message: string,
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = "GitReadProcessError";
  }
}

export async function runReadOnlyGit(
  repositoryPath: string,
  args: readonly string[],
  options: {
    allowedExitCodes?: readonly number[];
    maxBuffer?: number;
    timeoutMs?: number;
  } = {},
): Promise<GitProcessResult> {
  const allowedExitCodes = new Set(options.allowedExitCodes ?? [0]);
  return await new Promise((resolve, reject) => {
    execFile(
      "git",
      [
        "--no-pager",
        "--no-optional-locks",
        "-c",
        "core.pager=cat",
        ...args,
      ],
      {
        cwd: repositoryPath,
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          PAGER: "cat",
        },
      },
      (error, stdout, stderr) => {
        const exitCode = numericExitCode(error);
        if (!error || allowedExitCodes.has(exitCode)) {
          resolve({ stdout, stderr, exitCode });
          return;
        }
        const detail = stderr.trim() || error.message;
        reject(new GitReadProcessError(
          `Read-only Git operation failed: ${bounded(detail, 2_000)}`,
          exitCode,
        ));
      },
    );
  });
}

function numericExitCode(error: { code?: string | number | null } | null): number {
  if (!error) return 0;
  return typeof error.code === "number" ? error.code : 1;
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}
