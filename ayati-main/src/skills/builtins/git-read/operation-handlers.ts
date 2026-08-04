import {
  DEFAULT_GIT_READ_CHARS,
  DEFAULT_GIT_READ_LIMIT,
  type GitReadInput,
  type GitReadOperationResult,
  type GitRepositoryIdentity,
} from "./contracts.js";
import { runReadOnlyGit } from "./git-process.js";

interface CommitSummary {
  commit: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authoredAt: string;
  committedAt: string;
  subject: string;
}

export async function executeGitReadOperation(
  input: GitReadInput,
  repository: GitRepositoryIdentity,
): Promise<GitReadOperationResult> {
  switch (input.operation) {
    case "info":
      return info(repository);
    case "status":
      return await status(repository);
    case "log":
      return await log(input, repository);
    case "show":
      return await show(input, repository);
    case "diff":
      return await diff(input, repository);
    case "branches":
      return await refs(repository, "branches", input.limit);
    case "tags":
      return await refs(repository, "tags", input.limit);
    case "remotes":
      return await remotes(repository);
    case "files":
      return await files(input, repository);
    case "read_file":
      return await readFile(input, repository);
    case "grep":
      return await grep(input, repository);
    case "blame":
      return await blame(input, repository);
    case "reflog":
      return await reflog(input, repository);
    case "merge_base":
      return await mergeBase(input, repository);
  }
}

export async function resolveCommitRevision(
  repositoryPath: string,
  revision = "HEAD",
): Promise<string> {
  const result = await runReadOnlyGit(repositoryPath, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  ]);
  const commit = result.stdout.trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) {
    throw new Error(`Git did not resolve ${revision} to one commit.`);
  }
  return commit;
}

async function info(repository: GitRepositoryIdentity): Promise<GitReadOperationResult> {
  return {
    result: {
      bare: repository.bare,
      ...(repository.head ? { head: repository.head } : {}),
      ...(repository.branch ? { branch: repository.branch } : {}),
      detached: Boolean(repository.head && !repository.branch),
      empty: !repository.head,
    },
    truncated: false,
  };
}

async function status(repository: GitRepositoryIdentity): Promise<GitReadOperationResult> {
  requireWorktree(repository, "status");
  const output = (await runReadOnlyGit(repository.path, [
    "status",
    "--porcelain=v1",
    "-z",
    "--branch",
    "--untracked-files=all",
  ])).stdout;
  const tokens = output.split("\0").filter(Boolean);
  const branchLine = tokens[0]?.startsWith("## ") ? tokens.shift() : undefined;
  const changes: Array<Record<string, unknown>> = [];
  for (let index = 0; index < tokens.length && changes.length <= DEFAULT_GIT_READ_LIMIT; index++) {
    const token = tokens[index];
    if (!token || token.length < 3) continue;
    const code = token.slice(0, 2);
    const path = token.slice(3);
    if (code.includes("R") || code.includes("C")) {
      const previousPath = tokens[++index];
      changes.push({ code, path, ...(previousPath ? { previousPath } : {}) });
    } else {
      changes.push({ code, path });
    }
  }
  const hasMore = changes.length > DEFAULT_GIT_READ_LIMIT || tokens.length > DEFAULT_GIT_READ_LIMIT;
  return {
    result: {
      branchSummary: branchLine?.slice(3) ?? "",
      clean: tokens.length === 0,
      changes: changes.slice(0, DEFAULT_GIT_READ_LIMIT),
      count: Math.min(changes.length, DEFAULT_GIT_READ_LIMIT),
      hasMore,
    },
    truncated: hasMore,
  };
}

async function log(
  input: GitReadInput,
  repository: GitRepositoryIdentity,
): Promise<GitReadOperationResult> {
  const limit = input.limit ?? DEFAULT_GIT_READ_LIMIT;
  const commit = await resolveCommitRevision(repository.path, input.revision);
  const args = [
    "log",
    `--max-count=${limit + 1}`,
    "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x1e",
    commit,
  ];
  if (input.path) args.push("--", literalPathspec(input.path));
  const commits = parseCommitSummaries((await runReadOnlyGit(repository.path, args)).stdout);
  const hasMore = commits.length > limit;
  return {
    result: {
      commits: commits.slice(0, limit),
      count: Math.min(commits.length, limit),
      hasMore,
    },
    truncated: hasMore,
  };
}

async function show(
  input: GitReadInput,
  repository: GitRepositoryIdentity,
): Promise<GitReadOperationResult> {
  const commit = await resolveCommitRevision(repository.path, input.revision);
  const summary = await readOneCommit(repository.path, commit);
  const changedPaths = await readChangedPaths(repository.path, [
    "diff-tree",
    "--root",
    "--no-commit-id",
    "--name-status",
    "-r",
    "-z",
    commit,
    "--",
    ...(input.path ? [literalPathspec(input.path)] : []),
  ]);
  const includePatch = input.includePatch ?? true;
  if (!includePatch) {
    return { result: { commit: summary, changedPaths }, truncated: false };
  }
  const patch = (await runReadOnlyGit(repository.path, [
    "show",
    "--format=",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    commit,
    "--",
    ...(input.path ? [literalPathspec(input.path)] : []),
  ])).stdout;
  const bounded = boundText(patch, input.maxChars);
  return {
    result: {
      commit: summary,
      changedPaths,
      patch: bounded.text,
      totalPatchChars: bounded.totalChars,
    },
    truncated: bounded.truncated,
  };
}

async function diff(
  input: GitReadInput,
  repository: GitRepositoryIdentity,
): Promise<GitReadOperationResult> {
  const scope = input.diffScope ?? (
    input.baseRevision || input.targetRevision ? "commits" : "working"
  );
  if (repository.bare && scope !== "commits") {
    throw new Error(`A bare repository does not support ${scope} diff.`);
  }
  const revisions = scope === "commits"
    ? [
        await resolveCommitRevision(repository.path, input.baseRevision),
        await resolveCommitRevision(repository.path, input.targetRevision),
      ]
    : [];
  const scopeArgs = scope === "staged" ? ["--cached"] : revisions;
  const common = [
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    ...scopeArgs,
    "--",
    ...(input.path ? [literalPathspec(input.path)] : []),
  ];
  const [changedPaths, patch] = await Promise.all([
    readChangedPaths(repository.path, ["diff", "--name-status", "-z", ...common]),
    runReadOnlyGit(repository.path, ["diff", ...common]),
  ]);
  const bounded = boundText(patch.stdout, input.maxChars);
  return {
    result: {
      scope,
      ...(revisions[0] ? { baseRevision: revisions[0] } : {}),
      ...(revisions[1] ? { targetRevision: revisions[1] } : {}),
      changedPaths,
      patch: bounded.text,
      totalPatchChars: bounded.totalChars,
    },
    truncated: bounded.truncated,
  };
}

async function refs(
  repository: GitRepositoryIdentity,
  kind: "branches" | "tags",
  requestedLimit?: number,
): Promise<GitReadOperationResult> {
  const limit = requestedLimit ?? DEFAULT_GIT_READ_LIMIT;
  const namespaces = kind === "branches"
    ? ["refs/heads", "refs/remotes"]
    : ["refs/tags"];
  const output = (await runReadOnlyGit(repository.path, [
    "for-each-ref",
    `--count=${limit + 1}`,
    "--format=%(refname:short)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(subject)%1e",
    ...namespaces,
  ])).stdout;
  const entries = output.split("\x1e").flatMap((record) => {
    const normalized = record.replace(/^\n+|\n+$/g, "");
    if (!normalized) return [];
    const [name = "", object = "", head = "", upstream = "", subject = ""] = normalized.split("\0");
    return [{
      name,
      object,
      current: head.trim() === "*",
      ...(upstream ? { upstream } : {}),
      ...(subject ? { subject } : {}),
    }];
  });
  const hasMore = entries.length > limit;
  return {
    result: {
      entries: entries.slice(0, limit),
      count: Math.min(entries.length, limit),
      hasMore,
    },
    truncated: hasMore,
  };
}

async function remotes(repository: GitRepositoryIdentity): Promise<GitReadOperationResult> {
  const output = (await runReadOnlyGit(repository.path, ["remote", "-v"])).stdout;
  const entries = output.split("\n").filter(Boolean).slice(0, DEFAULT_GIT_READ_LIMIT * 2).map((line) => {
    const match = /^(\S+)\s+(.+?)\s+\((fetch|push)\)$/.exec(line);
    return match
      ? { name: match[1], url: redactRemoteUrl(match[2] ?? ""), direction: match[3] }
      : { raw: line };
  });
  const totalLines = output.split("\n").filter(Boolean).length;
  const truncated = totalLines > entries.length;
  return {
    result: { entries, count: entries.length, hasMore: truncated },
    truncated,
  };
}

async function files(
  input: GitReadInput,
  repository: GitRepositoryIdentity,
): Promise<GitReadOperationResult> {
  const limit = input.limit ?? DEFAULT_GIT_READ_LIMIT;
  const output = input.revision
    ? (await runReadOnlyGit(repository.path, [
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        await resolveCommitRevision(repository.path, input.revision),
        "--",
      ])).stdout
    : (await runReadOnlyGit(repository.path, ["ls-files", "-z"])).stdout;
  const paths = output.split("\0").filter(Boolean);
  const hasMore = paths.length > limit;
  return {
    result: {
      paths: paths.slice(0, limit),
      count: Math.min(paths.length, limit),
      hasMore,
    },
    truncated: hasMore,
  };
}

async function readFile(
  input: GitReadInput,
  repository: GitRepositoryIdentity,
): Promise<GitReadOperationResult> {
  const commit = await resolveCommitRevision(repository.path, input.revision);
  const path = required(input.path, "read_file path");
  const content = (await runReadOnlyGit(repository.path, ["cat-file", "blob", `${commit}:${path}`])).stdout;
  if (content.includes("\0")) {
    throw new Error("read_file supports text Git objects only.");
  }
  const bounded = boundText(content, input.maxChars);
  return {
    result: {
      revision: commit,
      path,
      content: bounded.text,
      totalChars: bounded.totalChars,
    },
    truncated: bounded.truncated,
  };
}

async function grep(
  input: GitReadInput,
  repository: GitRepositoryIdentity,
): Promise<GitReadOperationResult> {
  const query = required(input.query, "grep query");
  const revision = input.revision
    ? await resolveCommitRevision(repository.path, input.revision)
    : undefined;
  if (repository.bare && !revision) {
    throw new Error("grep in a bare repository requires revision.");
  }
  const args = ["grep", "-n", "-I", "-z", "--full-name", "-e", query];
  if (revision) args.push(revision);
  args.push("--", ...(input.path ? [literalPathspec(input.path)] : []));
  const output = (await runReadOnlyGit(repository.path, args, { allowedExitCodes: [0, 1] })).stdout;
  const matches = output.split("\n").filter(Boolean).map((record) => {
    const [rawPath = "", rawLine = "", text = ""] = record.split("\0");
    const path = revision && rawPath.startsWith(`${revision}:`)
      ? rawPath.slice(revision.length + 1)
      : rawPath;
    return { path, line: Number.parseInt(rawLine, 10), text };
  });
  const limit = input.limit ?? DEFAULT_GIT_READ_LIMIT;
  const selected = matches.slice(0, limit);
  const bounded = boundStructuredText(selected, input.maxChars);
  return {
    result: {
      matches: bounded.value,
      count: bounded.value.length,
      hasMore: matches.length > bounded.value.length,
    },
    truncated: matches.length > bounded.value.length,
  };
}

async function blame(
  input: GitReadInput,
  repository: GitRepositoryIdentity,
): Promise<GitReadOperationResult> {
  requireWorktreeOrRevision(repository, input.revision, "blame");
  const revision = input.revision
    ? await resolveCommitRevision(repository.path, input.revision)
    : undefined;
  const path = required(input.path, "blame path");
  const output = (await runReadOnlyGit(repository.path, [
    "blame",
    "--line-porcelain",
    ...(revision ? [revision] : []),
    "--",
    path,
  ])).stdout;
  const bounded = boundText(output, input.maxChars);
  return {
    result: {
      path,
      ...(revision ? { revision } : {}),
      blame: bounded.text,
      totalChars: bounded.totalChars,
    },
    truncated: bounded.truncated,
  };
}

async function reflog(
  input: GitReadInput,
  repository: GitRepositoryIdentity,
): Promise<GitReadOperationResult> {
  const limit = input.limit ?? DEFAULT_GIT_READ_LIMIT;
  const revision = input.revision ?? "HEAD";
  const output = (await runReadOnlyGit(repository.path, [
    "reflog",
    "show",
    `--max-count=${limit + 1}`,
    "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x1e",
    revision,
  ], { allowedExitCodes: [0, 1] })).stdout;
  const commits = parseCommitSummaries(output);
  const hasMore = commits.length > limit;
  return {
    result: {
      commits: commits.slice(0, limit),
      count: Math.min(commits.length, limit),
      hasMore,
    },
    truncated: hasMore,
  };
}

async function mergeBase(
  input: GitReadInput,
  repository: GitRepositoryIdentity,
): Promise<GitReadOperationResult> {
  const baseRevision = await resolveCommitRevision(repository.path, input.baseRevision);
  const targetRevision = await resolveCommitRevision(repository.path, input.targetRevision);
  const mergeBase = (await runReadOnlyGit(repository.path, [
    "merge-base",
    baseRevision,
    targetRevision,
  ])).stdout.trim();
  return {
    result: { baseRevision, targetRevision, mergeBase },
    truncated: false,
  };
}

async function readOneCommit(repositoryPath: string, commit: string): Promise<CommitSummary> {
  const output = (await runReadOnlyGit(repositoryPath, [
    "show",
    "-s",
    "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s",
    commit,
  ])).stdout.trimEnd();
  const [sha = "", parents = "", author = "", authorEmail = "", authoredAt = "", committedAt = "", subject = ""] = output.split("\0");
  return {
    commit: sha,
    parents: parents.split(" ").filter(Boolean),
    author,
    authorEmail,
    authoredAt,
    committedAt,
    subject,
  };
}

function parseCommitSummaries(output: string): CommitSummary[] {
  return output.split("\x1e").flatMap((record) => {
    const normalized = record.replace(/^\n+|\n+$/g, "");
    if (!normalized) return [];
    const [commit = "", parents = "", author = "", authorEmail = "", authoredAt = "", committedAt = "", subject = ""] = normalized.split("\0");
    return [{
      commit,
      parents: parents.split(" ").filter(Boolean),
      author,
      authorEmail,
      authoredAt,
      committedAt,
      subject,
    }];
  });
}

async function readChangedPaths(
  repositoryPath: string,
  args: string[],
): Promise<Array<Record<string, unknown>>> {
  const tokens = (await runReadOnlyGit(repositoryPath, args)).stdout.split("\0");
  const entries: Array<Record<string, unknown>> = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousPath = tokens[index++];
      const path = tokens[index++];
      if (!previousPath || !path) throw new Error("Git returned an incomplete renamed path record.");
      entries.push({ status, path, previousPath });
      continue;
    }
    const path = tokens[index++];
    if (!path) throw new Error("Git returned an incomplete path record.");
    entries.push({ status, path });
  }
  return entries;
}

function boundText(value: string, requested?: number): {
  text: string;
  totalChars: number;
  truncated: boolean;
} {
  const maximum = requested ?? DEFAULT_GIT_READ_CHARS;
  return {
    text: value.slice(0, maximum),
    totalChars: value.length,
    truncated: value.length > maximum,
  };
}

function boundStructuredText(
  values: Array<{ path: string; line: number; text: string }>,
  requested?: number,
): { value: Array<{ path: string; line: number; text: string }> } {
  const maximum = requested ?? DEFAULT_GIT_READ_CHARS;
  const selected: Array<{ path: string; line: number; text: string }> = [];
  let chars = 0;
  for (const value of values) {
    const size = value.path.length + value.text.length + 32;
    if (chars + size > maximum) break;
    selected.push(value);
    chars += size;
  }
  return { value: selected };
}

function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

function redactRemoteUrl(value: string): string {
  return value.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/i,
    "$1[redacted]@",
  );
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function requireWorktree(repository: GitRepositoryIdentity, operation: string): void {
  if (repository.bare) throw new Error(`${operation} requires a non-bare repository.`);
}

function requireWorktreeOrRevision(
  repository: GitRepositoryIdentity,
  revision: string | undefined,
  operation: string,
): void {
  if (repository.bare && !revision) {
    throw new Error(`${operation} in a bare repository requires revision.`);
  }
}
