export const GIT_READ_OPERATIONS = [
  "info",
  "status",
  "log",
  "show",
  "diff",
  "branches",
  "tags",
  "remotes",
  "files",
  "read_file",
  "grep",
  "blame",
  "reflog",
  "merge_base",
] as const;

export type GitReadOperation = typeof GIT_READ_OPERATIONS[number];

export type GitDiffScope = "commits" | "working" | "staged";

export interface GitReadInput {
  repositoryPath: string;
  operation: GitReadOperation;
  revision?: string;
  baseRevision?: string;
  targetRevision?: string;
  path?: string;
  query?: string;
  diffScope?: GitDiffScope;
  limit?: number;
  maxChars?: number;
  includePatch?: boolean;
}

export interface GitRepositoryIdentity {
  path: string;
  bare: boolean;
  head?: string;
  branch?: string;
  protectedWorkstream: boolean;
}

export interface GitReadRepositoryProjection {
  path: string;
  kind: "git_repository" | "context_only_git";
  bare: boolean;
  head?: string;
  branch?: string;
  health?: "ready" | "dirty_external" | "recovery_required" | "unavailable";
  access: "read_only";
}

export interface GitReadOperationResult {
  result: Record<string, unknown>;
  truncated: boolean;
}

export interface GitReadOutput {
  operation: GitReadOperation;
  repository: GitReadRepositoryProjection;
  result: Record<string, unknown>;
  truncated: boolean;
}

export const DEFAULT_GIT_READ_LIMIT = 20;
export const MAX_GIT_READ_LIMIT = 100;
export const DEFAULT_GIT_READ_CHARS = 40_000;
export const MAX_GIT_READ_CHARS = 100_000;
