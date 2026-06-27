import {
  type RunId,
  type WorkId,
  isRunId,
  isWorkId,
  slugifyTitle,
} from "./ids.js";

export type GitRef = string;
export type WorkBranchName = string;

export const MAIN_BRANCH_REF = "refs/heads/main";
export const FOCUS_CURRENT_REF = "refs/ayati/focus/current";
export const SNAPSHOT_LATEST_REF = "refs/ayati/snapshots/latest";

const WORK_BRANCH_REF_PATTERN = /^refs\/heads\/work\/(W-\d{8}-\d{4})-([a-z0-9][a-z0-9-]{0,79})$/;

export interface ParsedWorkBranchRef {
  ref: GitRef;
  branchName: WorkBranchName;
  workId: WorkId;
  slug: string;
}

export function buildWorkBranchName(workId: WorkId, title: string): WorkBranchName {
  assertWorkId(workId);
  return `work/${workId}-${slugifyTitle(title)}`;
}

export function buildWorkBranchRef(workId: WorkId, title: string): GitRef {
  return `refs/heads/${buildWorkBranchName(workId, title)}`;
}

export function isWorkBranchRef(value: unknown): value is GitRef {
  return typeof value === "string" && parseWorkBranchRef(value) !== null;
}

export function parseWorkBranchRef(ref: string): ParsedWorkBranchRef | null {
  const match = WORK_BRANCH_REF_PATTERN.exec(ref);
  if (!match) {
    return null;
  }
  const workId = match[1] ?? "";
  const slug = match[2] ?? "";
  if (!isWorkId(workId)) {
    return null;
  }
  return {
    ref,
    branchName: `work/${workId}-${slug}`,
    workId,
    slug,
  };
}

export function buildRunRef(runId: RunId): GitRef {
  assertRunId(runId);
  return `refs/ayati/runs/${runId}`;
}

export function buildScratchRef(runId: RunId): GitRef {
  assertRunId(runId);
  return `refs/scratch/${runId}`;
}

function assertWorkId(workId: WorkId): void {
  if (!isWorkId(workId)) {
    throw new Error(`Invalid work id: ${workId}`);
  }
}

function assertRunId(runId: RunId): void {
  if (!isRunId(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }
}
