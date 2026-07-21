import type { CommitSummary, WorkstreamCatalogEntry, WorkstreamContextProjection } from "../contracts.js";
import { runGitRaw } from "../git/git-process.js";
import { parseWorkstreamCommit } from "./workstream-commit-metadata.js";
import { validateWorkstreamRepository } from "./workstream-repository-validator.js";

const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";
const RECENT_COMMIT_LIMIT = 12;

export async function readSimpleWorkstreamContext(
  workstream: WorkstreamCatalogEntry,
  options: { workstreamRoot: string },
): Promise<WorkstreamContextProjection> {
  const validation = await validateWorkstreamRepository({
    workstreamRoot: options.workstreamRoot,
    contextRepositoryPath: workstream.contextRepositoryPath,
    expectedWorkstreamId: workstream.workstreamId,
    requestReadMode: "current",
  });
  const logOutput = await runGitRaw([
    "log",
    "-" + RECENT_COMMIT_LIMIT,
    "--format=%H%x1f%s%x1f%cI%x1f%B%x1e",
    validation.head,
  ], { cwd: validation.contextRepositoryPath });
  const recentCommits = parseCommits(logOutput);
  const latestFinalization = recentCommits.find(
    (commit) => commit.event === "workstream_bound_run_finalized",
  );
  const card = validation.workstreamCard;
  return {
    workstream: {
      workstreamId: validation.workstreamId,
      contextRepositoryPath: validation.contextRepositoryPath,
      branch: validation.branch,
      head: validation.head,
    },
    title: card.title,
    objective: card.purpose,
    summary: card.currentSnapshot,
    recentCommits,
    schemaVersion: card.schema,
    lifecycleStatus: card.status,
    repositoryHealth: validation.health,
    currentFocus: card.currentFocus,
    blockers: card.blockers,
    ...(validation.currentRequest ? {
      currentRequest: {
        id: validation.currentRequest.id,
        title: validation.currentRequest.title,
        status: validation.currentRequest.status,
        request: validation.currentRequest.request,
        acceptance: validation.currentRequest.acceptance,
        constraints: validation.currentRequest.constraints,
      },
    } : {}),
    ...(latestFinalization?.outcome
      ? { latestOutcome: latestFinalization.outcome }
      : {}),
    ...(latestFinalization?.validation
      ? { validation: latestFinalization.validation }
      : {}),
    ...(latestFinalization?.next ? { next: latestFinalization.next } : {}),
  };
}

function parseCommits(output: string): CommitSummary[] {
  return output
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [commit = "", subject = "", committedAt = "", ...messageParts] = record.split(
        FIELD_SEPARATOR,
      );
      const message = messageParts.join(FIELD_SEPARATOR).trim();
      const metadata = parseWorkstreamCommit(message);
      return {
        commit,
        subject,
        ...(committedAt ? { committedAt } : {}),
        ...(message ? { message } : {}),
        ...(metadata ? {
          event: metadata.event,
          workstreamId: metadata.workstreamId,
          requestId: metadata.requestId,
          outcome: metadata.outcome,
          ...(metadata.event === "workstream_bound_run_finalized" ? {
            runId: metadata.runId,
            streamId: metadata.streamId,
            validation: metadata.validation,
            workSummary: metadata.summary,
            ...(metadata.next ? { next: metadata.next } : {}),
          } : {}),
        } : {}),
      };
    });
}
