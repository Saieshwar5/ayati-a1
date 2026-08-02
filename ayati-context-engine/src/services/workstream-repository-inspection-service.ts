import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ReadWorkstreamRepositoryCommitRequest,
  ReadWorkstreamRepositoryCommitResponse,
  ReadWorkstreamRepositoryDiffRequest,
  ReadWorkstreamRepositoryDiffResponse,
  ReadWorkstreamRepositoryLogRequest,
  ReadWorkstreamRepositoryLogResponse,
  WorkstreamRepositoryCommitReceipt,
  WorkstreamRepositoryProjection,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { ContextEngineServiceError } from "../errors.js";
import { runGit, runGitRaw } from "../git/git-process.js";
import { readSharedWorkstreamRepositoryState } from "../repositories/workstream-repository-state-records.js";
import { parseWorkstreamCommit } from "../workstreams/workstream-commit-metadata.js";

const DEFAULT_LOG_LIMIT = 10;
const MAX_LOG_LIMIT = 20;
const DEFAULT_DIFF_CHARS = 40_000;
const MAX_DIFF_CHARS = 100_000;
const COMMIT_REF = /^[a-f0-9]{7,40}$/;

export interface WorkstreamRepositoryInspectionServiceOptions {
  database: ContextDatabase;
  workstreamRoot: string;
}

export class WorkstreamRepositoryInspectionService {
  constructor(private readonly options: WorkstreamRepositoryInspectionServiceOptions) {}

  async readLog(
    input: ReadWorkstreamRepositoryLogRequest,
  ): Promise<ReadWorkstreamRepositoryLogResponse> {
    const repository = await this.requireRepository(input.repositoryPath);
    const limit = boundedInteger(input.limit, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT, "limit");
    const commits = (await runGit([
      "log",
      `--max-count=${limit + 1}`,
      "--format=%H",
    ], { cwd: repository.path })).split("\n").filter(Boolean);
    const hasMore = commits.length > limit;
    const selected = commits.slice(0, limit);
    return {
      repository,
      commits: await Promise.all(selected.map(async (commit) =>
        await this.readCommitReceipt(repository.path, commit))),
      count: selected.length,
      hasMore,
    };
  }

  async readCommit(
    input: ReadWorkstreamRepositoryCommitRequest,
  ): Promise<ReadWorkstreamRepositoryCommitResponse> {
    const repository = await this.requireRepository(input.repositoryPath);
    const commit = await this.resolveCommit(repository.path, input.commit);
    return {
      repository,
      commit: await this.readCommitReceipt(repository.path, commit),
      changedPaths: await readChangedPaths(repository.path, commit),
    };
  }

  async readDiff(
    input: ReadWorkstreamRepositoryDiffRequest,
  ): Promise<ReadWorkstreamRepositoryDiffResponse> {
    const repository = await this.requireRepository(input.repositoryPath);
    const from = await this.resolveCommit(repository.path, input.from);
    const to = await this.resolveCommit(repository.path, input.to);
    const maxChars = boundedInteger(
      input.maxChars,
      DEFAULT_DIFF_CHARS,
      MAX_DIFF_CHARS,
      "maxChars",
    );
    const patch = await runGitRaw([
      "diff",
      "--no-ext-diff",
      "--no-color",
      from,
      to,
      "--",
    ], { cwd: repository.path });
    return {
      repository,
      from,
      to,
      changedPaths: await readChangedPaths(repository.path, from, to),
      patch: patch.slice(0, maxChars),
      totalPatchChars: patch.length,
      truncated: patch.length > maxChars,
    };
  }

  private async requireRepository(repositoryPath: string): Promise<WorkstreamRepositoryProjection> {
    if (!repositoryPath.trim()) throw invalid("repositoryPath is required.");
    const state = readSharedWorkstreamRepositoryState(this.options.database);
    if (!state) {
      throw unavailable("The managed workstream repository has not been initialized.");
    }
    let requested: string;
    let configured: string;
    try {
      [requested, configured] = await Promise.all([
        realpath(repositoryPath),
        realpath(this.options.workstreamRoot),
      ]);
    } catch {
      throw invalid("repositoryPath must be the exact managed workstream repository path.");
    }
    if (resolve(requested) !== resolve(configured)
      || resolve(state.repositoryPath) !== resolve(configured)) {
      throw invalid("Only the managed workstream repository may be inspected.", {
        expectedRepositoryPath: configured,
      });
    }
    if (state.health === "recovery_required" || state.health === "unavailable") {
      throw unavailable("The managed workstream repository is not safe to inspect.", {
        health: state.health,
      });
    }
    const [gitRoot, branch, head] = await Promise.all([
      runGit(["rev-parse", "--show-toplevel"], { cwd: configured }),
      runGit(["symbolic-ref", "--short", "HEAD"], { cwd: configured }),
      runGit(["rev-parse", "HEAD"], { cwd: configured }),
    ]);
    if (resolve(gitRoot) !== resolve(configured) || branch !== "main" || head !== state.head) {
      throw unavailable("The managed workstream repository identity or HEAD changed.", {
        expectedHead: state.head,
        actualHead: head,
        branch,
      });
    }
    return {
      path: configured,
      branch: "main",
      head,
      health: state.health,
      kind: "context_only_git",
      access: "read_only",
    };
  }

  private async resolveCommit(repositoryPath: string, value: string): Promise<string> {
    const ref = value.trim().toLowerCase();
    if (!COMMIT_REF.test(ref)) {
      throw invalid("Commit references must be 7 to 40 lowercase hexadecimal characters.");
    }
    try {
      return await runGit(["rev-parse", "--verify", `${ref}^{commit}`], {
        cwd: repositoryPath,
      });
    } catch {
      throw invalid("The commit does not exist in the managed workstream repository.", {
        commit: ref,
      });
    }
  }

  private async readCommitReceipt(
    repositoryPath: string,
    commit: string,
  ): Promise<WorkstreamRepositoryCommitReceipt> {
    const raw = await runGitRaw([
      "show",
      "-s",
      "--format=%H%x00%P%x00%s%x00%cI%x00%B",
      commit,
    ], { cwd: repositoryPath });
    const [sha = "", parentText = "", subject = "", committedAt = "", ...bodyParts] = raw.split("\0");
    const metadata = parseWorkstreamCommit(bodyParts.join("\0").trim());
    const base: WorkstreamRepositoryCommitReceipt = {
      commit: sha,
      parents: parentText.split(" ").filter(Boolean),
      subject,
      committedAt,
      mutationCount: metadata?.event === "workstream_bound_run_finalized"
        ? metadata.mutations
        : 0,
      mutations: metadata?.event === "workstream_bound_run_finalized"
        ? metadata.mutationDetails
        : [],
      problemCodes: metadata?.event === "workstream_bound_run_finalized"
        ? metadata.problemCodes
        : [],
      ...(metadata ? metadataReceipt(metadata) : {}),
    };
    return base;
  }
}

function metadataReceipt(
  metadata: NonNullable<ReturnType<typeof parseWorkstreamCommit>>,
): Partial<WorkstreamRepositoryCommitReceipt> {
  if (metadata.event === "workstream_created") {
    return {
      event: metadata.event,
      workstreamId: metadata.workstreamId,
      requestId: metadata.requestId,
      outcome: metadata.outcome,
      schema: metadata.schema,
      ...(metadata.workstreamTitle ? { workstreamTitle: metadata.workstreamTitle } : {}),
      ...(metadata.requestTitle ? { requestTitle: metadata.requestTitle } : {}),
      ...(metadata.requestStatusAfter
        ? { requestStatusAfter: metadata.requestStatusAfter }
        : {}),
    };
  }
  return {
    event: metadata.event,
    workstreamId: metadata.workstreamId,
    requestId: metadata.requestId,
    runId: metadata.runId,
    streamId: metadata.streamId,
    outcome: metadata.outcome,
    validation: metadata.validation,
    summary: metadata.summary,
    schema: metadata.schema,
    ...(metadata.workstreamTitle ? { workstreamTitle: metadata.workstreamTitle } : {}),
    ...(metadata.requestTitle ? { requestTitle: metadata.requestTitle } : {}),
    ...(metadata.requestStatusAfter
      ? { requestStatusAfter: metadata.requestStatusAfter }
      : {}),
    ...(metadata.stopReason ? { stopReason: metadata.stopReason } : {}),
    ...(metadata.criteria ? { criteria: metadata.criteria } : {}),
    ...(metadata.resourceEffects ? { resourceEffects: metadata.resourceEffects } : {}),
    ...(metadata.next ? { next: metadata.next } : {}),
  };
}

async function readChangedPaths(
  repositoryPath: string,
  fromOrCommit: string,
  to?: string,
): Promise<ReadWorkstreamRepositoryCommitResponse["changedPaths"]> {
  const args = to
    ? ["diff", "--name-status", "-z", fromOrCommit, to, "--"]
    : ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", fromOrCommit, "--"];
  const tokens = (await runGitRaw(args, { cwd: repositoryPath })).split("\0");
  const result: ReadWorkstreamRepositoryCommitResponse["changedPaths"] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousPath = tokens[index++];
      const path = tokens[index++];
      if (!previousPath || !path) throw new Error("Git returned an incomplete renamed path record.");
      result.push({ status, path, previousPath });
      continue;
    }
    const path = tokens[index++];
    if (!path) throw new Error("Git returned an incomplete path record.");
    result.push({ status, path });
  }
  return result;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw invalid(`${field} must be an integer between 1 and ${maximum}.`);
  }
  return normalized;
}

function invalid(message: string, details?: Record<string, unknown>): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "WORKSTREAM_REPOSITORY_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}

function unavailable(
  message: string,
  details?: Record<string, unknown>,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "REPOSITORY_UNAVAILABLE",
    message,
    ...(details ? { details } : {}),
  });
}
