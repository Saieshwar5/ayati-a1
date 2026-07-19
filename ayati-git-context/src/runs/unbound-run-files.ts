import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GitContextServiceError } from "../errors.js";
import { writeFileAtomically } from "../files/atomic-file.js";

export function unboundRunPaths(sessionRepository: string, runId: string): {
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

export async function writeUnboundRunFiles(input: {
  sessionRepository: string;
  runFile: string;
  stepsFile: string;
  runContent: string;
  stepsContent: string;
}): Promise<void> {
  await requireNormalOrCreate(join(input.sessionRepository, "runs"));
  await requireNormalOrCreate(dirname(input.runFile));
  await writeFileAtomically(input.runFile, input.runContent);
  await writeFileAtomically(input.stepsFile, input.stepsContent);
}

async function requireNormalOrCreate(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "Unbound run evidence path is not a normal directory.",
        details: { path },
      });
    }
  } catch (error) {
    if (error instanceof GitContextServiceError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path);
  }
}
