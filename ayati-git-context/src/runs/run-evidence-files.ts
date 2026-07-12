import { lstat, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { GitContextServiceError } from "../errors.js";
import { writeFileAtomically } from "../files/atomic-file.js";
import { runGit } from "../git/git-process.js";

export function taskRunEvidencePaths(sessionRepository: string, runId: string): {
  runFile: string;
  stepsFile: string;
  runRelative: string;
  stepsRelative: string;
} {
  const runRelative = "runs/" + runId + "/run.json";
  const stepsRelative = "runs/" + runId + "/steps.jsonl";
  return {
    runFile: join(sessionRepository, runRelative),
    stepsFile: join(sessionRepository, stepsRelative),
    runRelative,
    stepsRelative,
  };
}

export async function writeAndStageRunEvidence(input: {
  sessionRepository: string;
  runFile: string;
  stepsFile: string;
  runContent: string;
  stepsContent: string;
  expectedSessionHead: string;
}): Promise<void> {
  await requireSafeEvidenceDirectory(input.sessionRepository, dirname(input.runFile));
  const before = await runGit(["rev-parse", "HEAD"], { cwd: input.sessionRepository });
  if (before !== input.expectedSessionHead) {
    throw sessionHeadMismatch(input.expectedSessionHead, before);
  }
  await writeFileAtomically(input.runFile, input.runContent);
  await writeFileAtomically(input.stepsFile, input.stepsContent);
  const paths = [
    portableRelative(input.sessionRepository, input.runFile),
    portableRelative(input.sessionRepository, input.stepsFile),
  ];
  await runGit(["add", "--", ...paths], { cwd: input.sessionRepository });
  const after = await runGit(["rev-parse", "HEAD"], { cwd: input.sessionRepository });
  if (after !== input.expectedSessionHead) {
    throw sessionHeadMismatch(input.expectedSessionHead, after);
  }
  const staged = await runGit(["diff", "--cached", "--name-only", "--", ...paths], {
    cwd: input.sessionRepository,
  });
  const stagedPaths = staged.split("\n").filter(Boolean).sort();
  if (JSON.stringify(stagedPaths) !== JSON.stringify(paths.sort())) {
    throw new GitContextServiceError({
      code: "RECOVERY_REQUIRED",
      message: "Task-run evidence files were not staged exactly.",
      details: { expectedPaths: paths, stagedPaths },
    });
  }
}

async function requireSafeEvidenceDirectory(
  sessionRepository: string,
  runDirectory: string,
): Promise<void> {
  const runsDirectory = join(sessionRepository, "runs");
  await requireNormalOrCreate(runsDirectory);
  await requireNormalOrCreate(runDirectory);
}

async function requireNormalOrCreate(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "Task-run evidence path is not a normal directory.",
        details: { path },
      });
    }
  } catch (error) {
    if (error instanceof GitContextServiceError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await mkdir(path);
  }
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}

function sessionHeadMismatch(expected: string, actual: string): GitContextServiceError {
  return new GitContextServiceError({
    code: "SESSION_HEAD_MISMATCH",
    message: "Session HEAD changed while persisting task-run evidence.",
    retryable: true,
    details: { expectedHead: expected, actualHead: actual },
  });
}
