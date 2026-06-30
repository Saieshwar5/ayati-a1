import type { GitMemoryWorktreeGitDriver } from "./git-driver.js";
import {
  parseGitMemoryTaskMarkdown,
} from "./task-markdown.js";
import type {
  GitMemoryTaskId,
  GitMemoryTaskStateFile,
  GitMemoryTaskStatus,
} from "./schema.js";
import {
  gitMemoryTaskMarkdownPath,
  gitMemoryTaskStatePath,
} from "./schema.js";

export interface GitMemoryDerivedTaskEntry {
  taskId: GitMemoryTaskId;
  branch: string;
  ref: string;
  title: string;
  objective: string;
  status: GitMemoryTaskStatus;
  createdAt: string;
  updatedAt: string;
  missing?: boolean;
}

export async function readGitMemoryTaskEntries(
  driver: GitMemoryWorktreeGitDriver,
): Promise<GitMemoryDerivedTaskEntry[]> {
  const refs = (await driver.listRefs("refs/heads/task/")).sort();
  const entries: GitMemoryDerivedTaskEntry[] = [];
  for (const ref of refs) {
    const branch = ref.replace(/^refs\/heads\//, "");
    const taskId = gitMemoryTaskIdFromBranch(branch);
    if (!taskId) {
      continue;
    }
    const [taskMarkdown, state] = await Promise.all([
      driver.readFile(ref, gitMemoryTaskMarkdownPath(taskId)),
      readRefJson<GitMemoryTaskStateFile>(driver, ref, gitMemoryTaskStatePath(taskId)),
    ]);
    const task = parseGitMemoryTaskMarkdown(taskMarkdown);
    entries.push({
      taskId,
      branch,
      ref,
      title: task?.title ?? taskId,
      objective: task?.objective ?? task?.title ?? taskId,
      status: state?.status ?? task?.status ?? "open",
      createdAt: task?.createdAt ?? "",
      updatedAt: state?.updatedAt ?? task?.updatedAt ?? "",
      ...(!task || !state ? { missing: true } : {}),
    });
  }
  return entries.sort((left, right) => left.taskId.localeCompare(right.taskId));
}

export async function resolveGitMemoryTaskEntry(
  driver: GitMemoryWorktreeGitDriver,
  input: { taskId?: GitMemoryTaskId; branch?: string },
): Promise<GitMemoryDerivedTaskEntry> {
  const hasTaskId = Boolean(input.taskId?.trim());
  const hasBranch = Boolean(input.branch?.trim());
  if (hasTaskId === hasBranch) {
    throw new Error("Provide exactly one task selector: taskId or branch.");
  }

  const tasks = await readGitMemoryTaskEntries(driver);
  const entry = hasTaskId
    ? tasks.find((task) => task.taskId === input.taskId)
    : tasks.find((task) => task.branch === input.branch);
  if (!entry) {
    throw new Error(hasTaskId
      ? `Git memory task not found: ${input.taskId}`
      : `Git memory task branch not found: ${input.branch}`);
  }
  return entry;
}

export function gitMemoryTaskIdFromBranch(branch: string): GitMemoryTaskId | null {
  const match = /^task\/(W-\d{8}-\d{4})(?:-|$)/.exec(branch);
  return match?.[1] ?? null;
}

export function nextGitMemoryTaskSequence(tasks: GitMemoryDerivedTaskEntry[]): number {
  const maxSequence = tasks.reduce((max, task) => {
    const match = /^W-\d{8}-(\d{4})$/.exec(task.taskId);
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0);
  return maxSequence + 1;
}

async function readRefJson<T>(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  path: string,
): Promise<T | null> {
  const raw = await driver.readFile(ref, path);
  if (!raw?.trim()) {
    return null;
  }
  return JSON.parse(raw) as T;
}
