import type { CommitSummary, TaskCatalogEntry, TaskContextProjection } from "../contracts.js";
import { runGitRaw } from "../git/git-process.js";
import { parseSimpleTaskCommit } from "./task-commit-metadata.js";
import { resolveTaskReferenceAvailabilities } from "./task-reference-files.js";
import { validateTaskRepository } from "./task-repository-validator.js";

const RECORD_SEPARATOR = "\u001e";
const FIELD_SEPARATOR = "\u001f";
const RECENT_COMMIT_LIMIT = 12;

export async function readSimpleTaskContext(
  task: TaskCatalogEntry,
  options: { taskRoot: string; includeReferencesSummary: boolean },
): Promise<TaskContextProjection> {
  const validation = await validateTaskRepository({
    taskRoot: options.taskRoot,
    repositoryPath: task.repositoryPath,
    expectedTaskId: task.taskId,
    requestReadMode: "current",
  });
  const logOutput = await runGitRaw([
    "log",
    "-" + RECENT_COMMIT_LIMIT,
    "--format=%H%x1f%s%x1f%cI%x1f%B%x1e",
    validation.head,
  ], { cwd: validation.repositoryPath });
  const recentCommits = parseCommits(logOutput);
  const latestFinalization = recentCommits.find(
    (commit) => commit.event === "task_run_finalized",
  );
  const missing = new Set(validation.missingImportantPaths);
  const card = validation.taskCard;
  const references = options.includeReferencesSummary
    ? await resolveTaskReferenceAvailabilities(
        validation.repositoryPath,
        validation.references,
      )
    : validation.references;
  return {
    task: {
      taskId: validation.taskId,
      repositoryPath: validation.repositoryPath,
      workingPath: validation.repositoryPath,
      branch: validation.branch,
      head: validation.head,
    },
    workingDirectory: validation.repositoryPath,
    title: card.title,
    objective: card.purpose,
    summary: card.currentSnapshot,
    importantPaths: card.importantPaths.map((entry) => entry.path),
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
    importantPathDetails: card.importantPaths.map((entry) => ({
      path: entry.path,
      ...(entry.description ? { description: entry.description } : {}),
      exists: !missing.has(entry.path),
    })),
    ...(latestFinalization?.outcome
      ? { latestOutcome: latestFinalization.outcome }
      : {}),
    ...(latestFinalization?.validation
      ? { validation: latestFinalization.validation }
      : {}),
    ...(latestFinalization?.next ? { next: latestFinalization.next } : {}),
    ...(options.includeReferencesSummary
      ? { referencesSummary: summarizeReferences(references) }
      : {}),
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
      const metadata = parseSimpleTaskCommit(message);
      return {
        commit,
        subject,
        ...(committedAt ? { committedAt } : {}),
        ...(message ? { message } : {}),
        ...(metadata ? {
          event: metadata.event,
          taskId: metadata.taskId,
          requestId: metadata.requestId,
          outcome: metadata.outcome,
          ...(metadata.event === "task_run_finalized" ? {
            runId: metadata.runId,
            sessionId: metadata.sessionId,
            validation: metadata.validation,
            ...(metadata.next ? { next: metadata.next } : {}),
          } : {}),
        } : {}),
      };
    });
}

function summarizeReferences(references: Array<{ availability: string }>): {
  total: number;
  available: number;
  missing: number;
  changed: number;
  unchecked: number;
} {
  const count = (availability: string) => references.filter(
    (reference) => reference.availability === availability,
  ).length;
  return {
    total: references.length,
    available: count("available"),
    missing: count("missing"),
    changed: count("changed"),
    unchecked: count("unchecked"),
  };
}
