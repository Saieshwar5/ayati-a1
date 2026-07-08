import { basename, join } from "node:path";
import type {
  CompactGitMemoryStoreCommitSummary,
  GitMemoryEvidenceSearchMatch,
  GitMemoryTaskActionGroup,
  GitMemoryTaskDetailInclude,
  GitMemoryTaskDetailLimits,
  GitMemoryTaskRoutingFocus,
  GitMemoryTaskRoutingSnapshot,
  GitMemoryTaskRoutingSnapshotTask,
  GitMemoryTaskRunMarkdown,
  GitMemoryTaskSearchArtifact,
  GitMemoryTaskSearchMatch,
} from "./session-store.js";
import { GitMemoryWorktreeGitDriver } from "./git-driver.js";
import { parseGitMemoryCommitTrailers } from "./commit-message.js";
import {
  parseGitMemoryConversationMessageFiles,
  renderGitMemoryConversationMarkdownDocument,
} from "./conversation-markdown.js";
import { gitMemorySessionActiveTaskRef, readGitMemoryCustomRef } from "./custom-refs.js";
import {
  readGitMemorySessionTaskEntries,
  type GitMemoryDerivedTaskEntry,
} from "./task-refs.js";
import type {
  GitMemoryActionRecord,
  GitMemoryConversationRecord,
  GitMemoryConversationSeqRange,
  GitMemoryEvidenceManifestRecord,
  GitMemoryRunFile,
  GitMemoryRunId,
  GitMemorySessionId,
  GitMemoryTaskId,
  GitMemoryTaskStateFile,
  GitMemoryTaskStateFileRecord,
  GitMemoryStepRecord,
} from "./schema.js";
import {
  GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
  GIT_MEMORY_SESSION_STORE_DIR,
  gitMemorySessionStoreMessagesDir,
  gitMemoryTaskConversationDir,
  gitMemoryTaskDir,
  gitMemoryTaskNotesPath,
  gitMemoryTaskStatePath,
  gitMemoryTaskStepsPath,
} from "./schema.js";
import {
  legacyGitMemoryTaskEvidenceManifestPath,
  pathExists,
  runIdFromActionPath,
  runIdFromRunMarkdownPath,
} from "./session-store-paths.js";

export interface GitMemoryTaskSearchScore {
  score: number;
  routeScore: number;
  matchReasons: string[];
  matchedArtifacts: GitMemoryTaskSearchArtifact[];
}

interface GitMemoryTaskSearchDocument {
  entry: GitMemoryDerivedTaskEntry;
  task: GitMemoryTaskRoutingSnapshotTask;
  notesMarkdown: string;
  recentWork: string[];
  searchTerms: string[];
}

export async function activeTaskFromCustomRef(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
  tasks: GitMemoryDerivedTaskEntry[],
): Promise<GitMemoryDerivedTaskEntry | undefined> {
  let activeCommit: string | null;
  try {
    activeCommit = await readGitMemoryCustomRef(driver, gitMemorySessionActiveTaskRef(sessionId));
  } catch {
    return undefined;
  }
  if (!activeCommit) {
    return undefined;
  }
  for (const task of tasks) {
    const taskCommit = await driver.resolveRef(task.ref);
    if (taskCommit === activeCommit) {
      return task;
    }
  }
  return undefined;
}

export async function readTaskRoutingSnapshotFromDriver(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
): Promise<GitMemoryTaskRoutingSnapshot> {
  const [documents, currentBranch] = await Promise.all([
    readTaskSearchDocumentsFromDriver(driver, sessionId),
    driver.currentBranch(),
  ]);
  const tasks = documents.map((document) => document.entry);
  const branchTask = currentBranch?.startsWith("task/")
    ? tasks.find((task) => task.branch === currentBranch)
    : undefined;
  const currentTask = await activeTaskFromCustomRef(driver, sessionId, tasks)
    ?? branchTask;
  const focus: GitMemoryTaskRoutingFocus | null = currentTask
    ? {
        activeTaskId: currentTask.taskId,
        activeBranch: currentTask.branch,
        reason: "current_branch",
      }
    : null;

  return {
    sessionId,
    focus,
    tasks: documents.map((document) => document.task),
  };
}

export async function readTaskSearchDocumentsFromDriver(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
): Promise<GitMemoryTaskSearchDocument[]> {
  const taskEntries = await readGitMemorySessionTaskEntries(driver, sessionId);
  const documents: GitMemoryTaskSearchDocument[] = [];
  for (const taskEntry of taskEntries) {
    const ref = taskEntry.ref;
    if (!(await driver.hasRef(ref))) {
      const task: GitMemoryTaskRoutingSnapshotTask = {
        taskId: taskEntry.taskId,
        branch: taskEntry.branch,
        ref,
        title: taskEntry.title,
        objective: taskEntry.title,
        status: taskEntry.status,
        summary: taskEntry.title,
        open: [],
        blockers: [],
        facts: [],
        next: taskEntry.title,
        missing: true,
      };
      documents.push({
        entry: taskEntry,
        task,
        notesMarkdown: "",
        recentWork: [],
        searchTerms: [],
      });
      continue;
    }

    const [state, notesMarkdown] = await Promise.all([
      parseJson<GitMemoryTaskStateFile>(
        await driver.readFile(ref, gitMemoryTaskStatePath(taskEntry.taskId)),
      ),
      driver.readFile(ref, gitMemoryTaskNotesPath(taskEntry.taskId)),
    ]);
    const notes = parseTaskNotesSearchFields(notesMarkdown ?? "");
    documents.push({
      entry: taskEntry,
      task: {
        taskId: taskEntry.taskId,
        branch: taskEntry.branch,
        ref,
        title: state?.task.title ?? taskEntry.title,
        objective: state?.task.objective ?? taskEntry.title,
        status: state?.status ?? taskEntry.status,
        summary: state?.summary ?? taskEntry.title,
        open: state?.progress.open ?? [],
        blockers: state?.progress.blockers ?? [],
        facts: state?.memory.facts.map((fact) => fact.text) ?? [],
        next: state?.progress.next ?? taskEntry.title,
        updatedAt: state?.updatedAt ?? taskEntry.updatedAt,
        ...(state?.runs.latestRunId ? { latestRunId: state.runs.latestRunId } : notes.latestRunId ? { latestRunId: notes.latestRunId } : {}),
        ...(state?.context.importantFiles.length ? { files: state.context.importantFiles } : notes.files.length > 0 ? { files: notes.files } : {}),
        ...(state?.memory.files.length ? { artifacts: state.memory.files.map(taskSearchArtifactFromStateFile) } : {}),
        ...(!state ? { missing: true } : {}),
      },
      notesMarkdown: notesMarkdown ?? "",
      recentWork: notes.recentWork,
      searchTerms: state?.context.searchTerms ?? notes.searchTerms,
    });
  }

  return documents;
}

export function normalizeTaskDetailInclude(input: GitMemoryTaskDetailInclude[] | undefined): Set<GitMemoryTaskDetailInclude> {
  return new Set(input && input.length > 0
    ? input
    : ["task", "state", "runs", "markdown", "actions", "assets", "commits", "evidence", "conversation"]);
}

export function normalizeTaskDetailLimits(input: Partial<GitMemoryTaskDetailLimits> | undefined): GitMemoryTaskDetailLimits {
  return {
    runLimit: normalizeReadLimit(input?.runLimit, 5),
    actionRunLimit: normalizeReadLimit(input?.actionRunLimit, 3),
    actionLimit: normalizeReadLimit(input?.actionLimit, 20),
    commitLogLimit: normalizeReadLimit(input?.commitLogLimit, 10),
    evidenceLimit: normalizeReadLimit(input?.evidenceLimit, 20),
    conversationMarkdownCharLimit: normalizeMarkdownCharLimit(input?.conversationMarkdownCharLimit, 12_000),
    runMarkdownCharLimit: normalizeMarkdownCharLimit(input?.runMarkdownCharLimit, 12_000),
  };
}

export async function readRecentTaskRuns(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
  limit: number,
): Promise<GitMemoryRunFile[]> {
  const prefix = `${gitMemoryTaskDir(taskId)}/runs`;
  const paths = tail((await driver.listTreePaths(ref, prefix))
    .filter((path) => path.endsWith(".json"))
    .sort(), limit);
  const runs: GitMemoryRunFile[] = [];
  for (const path of paths) {
    const run = await readRefJson<GitMemoryRunFile>(driver, ref, path);
    if (run) {
      runs.push(run);
    }
  }
  return runs;
}

export async function readRecentTaskRunMarkdown(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
  limit: number,
  markdownLimit: number,
): Promise<GitMemoryTaskRunMarkdown[]> {
  const prefix = `${gitMemoryTaskDir(taskId)}/runs`;
  const paths = tail((await driver.listTreePaths(ref, prefix))
    .filter((path) => path.endsWith(".md"))
    .sort(), limit);
  const records: GitMemoryTaskRunMarkdown[] = [];
  for (const path of paths) {
    records.push({
      runId: runIdFromRunMarkdownPath(path),
      path,
      markdown: await readRefMarkdownTail(driver, ref, path, markdownLimit),
    });
  }
  return records;
}

export async function readRecentTaskActions(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
  runLimit: number,
  actionLimit: number,
): Promise<GitMemoryTaskActionGroup[]> {
  const prefix = `${gitMemoryTaskDir(taskId)}/actions`;
  const paths = tail((await driver.listTreePaths(ref, prefix))
    .filter((path) => path.endsWith(".jsonl"))
    .sort(), runLimit);
  const groups: GitMemoryTaskActionGroup[] = [];
  for (const path of paths) {
    groups.push({
      runId: runIdFromActionPath(path),
      path,
      actions: tail(await readRefJsonl<GitMemoryActionRecord>(driver, ref, path), actionLimit),
    });
  }
  return groups;
}

export async function readRecentTaskEvidence(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
  limit: number,
): Promise<GitMemoryEvidenceManifestRecord[]> {
  return tail(await readAllTaskEvidence(driver, ref, taskId), limit);
}

export async function readAllTaskEvidence(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
): Promise<GitMemoryEvidenceManifestRecord[]> {
  const stepPrefix = `${gitMemoryTaskDir(taskId)}/steps`;
  const stepPaths = (await driver.listTreePaths(ref, stepPrefix))
    .filter((path) => path.endsWith(".jsonl"))
    .sort();
  const stepRecords: GitMemoryEvidenceManifestRecord[] = [];
  for (const path of stepPaths) {
    stepRecords.push(...await readRefJsonl<GitMemoryStepRecord>(driver, ref, path).then((steps) => steps.map(stepToEvidenceRecord)));
  }
  if (stepRecords.length > 0) {
    return stepRecords;
  }

  const prefix = `${gitMemoryTaskDir(taskId)}/evidence`;
  const paths = (await driver.listTreePaths(ref, prefix))
    .filter((path) => path.endsWith("/manifest.jsonl"))
    .sort();
  const records: GitMemoryEvidenceManifestRecord[] = [];
  for (const path of paths) {
    records.push(...await readRefJsonl<GitMemoryEvidenceManifestRecord>(driver, ref, path));
  }
  return records;
}

export async function readTaskEvidenceForRun(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
  runId: GitMemoryRunId,
  limit: number,
): Promise<GitMemoryEvidenceManifestRecord[]> {
  const steps = await readRefJsonl<GitMemoryStepRecord>(driver, ref, gitMemoryTaskStepsPath(taskId, runId));
  if (steps.length > 0) {
    return tail(steps.map(stepToEvidenceRecord), limit);
  }
  const path = legacyGitMemoryTaskEvidenceManifestPath(taskId, runId);
  const raw = await driver.readFile(ref, path);
  if (raw === null) {
    throw new Error(`Git memory step log or evidence manifest not found for run: ${runId}`);
  }
  return tail(parseJsonl<GitMemoryEvidenceManifestRecord>(raw), limit);
}

export async function readTaskConversationMarkdownTail(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  sessionId: GitMemorySessionId,
  taskId: GitMemoryTaskId,
  limit: number,
): Promise<string> {
  const reconstructed = await readTaskConversationFromSessionStoreMarkdownTail(driver, ref, sessionId, taskId, limit);
  if (reconstructed) {
    return reconstructed;
  }
  const paths = (await driver.listTreePaths(ref, gitMemoryTaskConversationDir(taskId)))
    .filter((path) => path.endsWith(".md"))
    .sort();
  if (paths.length === 0) {
    return readRefMarkdownTail(driver, ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH, limit);
  }
  const records = parseGitMemoryConversationMessageFiles(await Promise.all(paths.map(async (path) => ({
    path,
    content: await driver.readFile(ref, path),
  }))));
  if (records.length === 0) {
    return readRefMarkdownTail(driver, ref, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH, limit);
  }
  return markdownTail(renderGitMemoryConversationMarkdownDocument(records), limit);
}

export async function readCompactLog(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  limit: number,
): Promise<CompactGitMemoryStoreCommitSummary[]> {
  return (await driver.log(ref, limit)).map((entry) => {
    const lines = entry.message.split(/\r?\n/);
    const subject = lines[0]?.trim() ?? "";
    const body = lines
      .slice(1)
      .join("\n")
      .split(/^Ayati-/m)[0]
      ?.trim();
    return {
      commit: entry.commit,
      subject,
      ...(body ? { summary: body } : {}),
      trailers: parseGitMemoryCommitTrailers(entry.message),
    };
  });
}

export function scoreTaskSearchMatch(
  document: GitMemoryTaskSearchDocument,
  rawQuery: string,
  queryTokens: string[],
): GitMemoryTaskSearchMatch {
  const scored = scoreGitMemoryTaskSearchDocument(document, rawQuery, queryTokens);
  return {
    ...document.task,
    score: scored.score,
    routeScore: scored.routeScore,
    matchReasons: scored.matchReasons,
    ...(scored.matchedArtifacts.length > 0 ? { matchedArtifacts: scored.matchedArtifacts } : {}),
  };
}

export function scoreGitMemoryTaskSearchDocument(
  document: {
    task: GitMemoryTaskRoutingSnapshotTask;
    notesMarkdown?: string;
    recentWork?: string[];
    searchTerms?: string[];
  },
  rawQuery: string,
  queryTokens = tokenizeSearchText(rawQuery),
): GitMemoryTaskSearchScore {
  const task = document.task;
  const reasons = new Set<string>();
  const matchedArtifacts = new Map<string, GitMemoryTaskSearchArtifact>();
  let score = 0;
  let routeScore = 0;
  const normalizedQuery = normalizeSearchText(rawQuery);

  const weightedFields: Array<{
    reason: string;
    searchWeight: number;
    routeSingleTokenScore: number;
    routeMultiTokenScore: number;
    values: string[];
  }> = [
    { reason: "taskId", searchWeight: 100, routeSingleTokenScore: 100, routeMultiTokenScore: 100, values: [task.taskId] },
    { reason: "branch", searchWeight: 60, routeSingleTokenScore: 45, routeMultiTokenScore: 85, values: [task.branch] },
    { reason: "title", searchWeight: 55, routeSingleTokenScore: 55, routeMultiTokenScore: 90, values: [task.title] },
    { reason: "objective", searchWeight: 45, routeSingleTokenScore: 40, routeMultiTokenScore: 75, values: [task.objective] },
    { reason: "files", searchWeight: 58, routeSingleTokenScore: 58, routeMultiTokenScore: 78, values: task.files ?? [] },
    { reason: "summary", searchWeight: 30, routeSingleTokenScore: 30, routeMultiTokenScore: 60, values: [task.summary] },
    { reason: "next", searchWeight: 28, routeSingleTokenScore: 28, routeMultiTokenScore: 58, values: [task.next] },
    { reason: "facts", searchWeight: 26, routeSingleTokenScore: 26, routeMultiTokenScore: 62, values: task.facts },
    { reason: "recentWork", searchWeight: 24, routeSingleTokenScore: 24, routeMultiTokenScore: 55, values: document.recentWork ?? [] },
    { reason: "searchTerms", searchWeight: 22, routeSingleTokenScore: 22, routeMultiTokenScore: 55, values: document.searchTerms ?? [] },
    { reason: "open", searchWeight: 20, routeSingleTokenScore: 20, routeMultiTokenScore: 72, values: task.open },
    { reason: "blockers", searchWeight: 18, routeSingleTokenScore: 18, routeMultiTokenScore: 50, values: task.blockers },
    { reason: "status", searchWeight: 5, routeSingleTokenScore: 5, routeMultiTokenScore: 5, values: [task.status] },
    { reason: "notes", searchWeight: 4, routeSingleTokenScore: 4, routeMultiTokenScore: 20, values: [document.notesMarkdown ?? ""] },
  ];

  for (const field of weightedFields) {
    const fieldText = normalizeSearchText(field.values.join(" "));
    if (!fieldText) {
      continue;
    }
    if (normalizedQuery && fieldText.includes(normalizedQuery)) {
      score += queryTokens.length > 1 ? field.searchWeight * 3 : field.searchWeight;
      routeScore = Math.max(routeScore, queryTokens.length > 1
        ? field.routeMultiTokenScore
        : field.routeSingleTokenScore);
      reasons.add(field.reason);
      continue;
    }
    const hits = queryTokens.filter((token) => fieldText.includes(token)).length;
    if (hits > 0) {
      score += hits * field.searchWeight;
      routeScore = Math.max(routeScore, hits >= 2
        ? field.routeMultiTokenScore
        : field.routeSingleTokenScore);
      reasons.add(field.reason);
    }
  }

  for (const artifact of task.artifacts ?? []) {
    const artifactScore = scoreTaskSearchArtifact(artifact, normalizedQuery, queryTokens);
    if (artifactScore.score <= 0) {
      continue;
    }
    score += artifactScore.score;
    routeScore = Math.max(routeScore, artifactScore.routeScore);
    matchedArtifacts.set(artifact.artifactId, artifact);
    for (const reason of artifactScore.reasons) {
      reasons.add(reason);
    }
  }

  return {
    score,
    routeScore,
    matchReasons: [...reasons],
    matchedArtifacts: [...matchedArtifacts.values()],
  };
}

export function scoreEvidenceSearchMatch(
  input: Omit<GitMemoryEvidenceSearchMatch, "score" | "matchReasons">,
  rawQuery: string,
  queryTokens: string[],
): GitMemoryEvidenceSearchMatch {
  const reasons = new Set<string>();
  let score = 0;
  const normalizedQuery = normalizeSearchText(rawQuery);
  const record = input.evidence;
  const weightedFields: Array<{
    reason: string;
    weight: number;
    values: string[];
  }> = [
    { reason: "taskId", weight: 12, values: [input.taskId] },
    { reason: "branch", weight: 8, values: [input.branch] },
    { reason: "runId", weight: 12, values: [record.runId] },
    { reason: "actionId", weight: 12, values: record.actionId ? [record.actionId] : [] },
    { reason: "tool", weight: 10, values: [record.tool] },
    { reason: "summary", weight: 12, values: [record.summary] },
    { reason: "evidenceRef", weight: 9, values: record.evidenceRef ? [record.evidenceRef] : [] },
    { reason: "artifacts", weight: 8, values: record.artifacts },
    { reason: "facts", weight: 10, values: record.facts },
    { reason: "accessModes", weight: 3, values: record.accessModes },
  ];

  for (const field of weightedFields) {
    const fieldText = normalizeSearchText(field.values.join(" "));
    if (!fieldText) {
      continue;
    }
    if (normalizedQuery && fieldText.includes(normalizedQuery)) {
      score += field.weight * 3;
      reasons.add(field.reason);
      continue;
    }
    const hits = queryTokens.filter((token) => fieldText.includes(token)).length;
    if (hits > 0) {
      score += hits * field.weight;
      reasons.add(field.reason);
    }
  }

  return {
    ...input,
    score,
    matchReasons: [...reasons],
  };
}

export function tokenizeSearchText(value: string): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .filter((token) => token.length >= 2)
    .filter((token, index, tokens) => tokens.indexOf(token) === index);
}

export function normalizeReadLimit(value: number | undefined, fallback: number): number {
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return fallback;
  }
  return Math.min(value, 100);
}

function taskSearchArtifactFromStateFile(record: GitMemoryTaskStateFileRecord): GitMemoryTaskSearchArtifact {
  return {
    artifactId: record.artifactId,
    source: record.source,
    kind: record.kind,
    path: record.path,
    ...(record.originalName ? { originalName: record.originalName } : {}),
    role: record.role,
    status: record.status,
    identity: record.identity,
    confidence: record.confidence,
  };
}

function parseTaskNotesSearchFields(markdown: string): {
  latestRunId?: GitMemoryRunId;
  files: string[];
  recentWork: string[];
  searchTerms: string[];
} {
  const latestRunId = /^Latest Run:\s*(R-\d{8}-\d{4})$/m.exec(markdown)?.[1] as GitMemoryRunId | undefined;
  return {
    ...(latestRunId ? { latestRunId } : {}),
    files: parseMarkdownListSection(markdown, "Files"),
    recentWork: parseMarkdownListSection(markdown, "Recent Work"),
    searchTerms: parseMarkdownTextSection(markdown, "Search Terms")
      .toLowerCase()
      .split(/[^a-z0-9._/-]+/g)
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

function parseMarkdownListSection(markdown: string, title: string): string[] {
  return parseMarkdownTextSection(markdown, title)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function parseMarkdownTextSection(markdown: string, title: string): string {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^## ${escapedTitle}\\s*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "m").exec(markdown);
  return match?.[1]?.trim() ?? "";
}

async function readRefMarkdownTail(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  path: string,
  limit: number,
): Promise<string> {
  return markdownTail(await driver.readFile(ref, path), limit);
}

async function readTaskConversationFromSessionStoreMarkdownTail(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  sessionId: GitMemorySessionId,
  taskId: GitMemoryTaskId,
  limit: number,
): Promise<string> {
  const messageStore = await openExistingSessionMessageStoreDriver(driver);
  if (!messageStore) {
    return "";
  }
  const runs = await readTaskRunsForConversation(driver, ref, taskId);
  const recordsBySeq = new Map<number, GitMemoryConversationRecord>();
  for (const run of runs) {
    if (!run.sessionStoreCommit) {
      continue;
    }
    const paths = (await messageStore.listTreePaths(run.sessionStoreCommit, gitMemorySessionStoreMessagesDir(sessionId)))
      .filter((path) => path.endsWith(".md"))
      .sort();
    const records = parseGitMemoryConversationMessageFiles(await Promise.all(paths.map(async (path) => ({
      path,
      content: await messageStore.readFile(run.sessionStoreCommit!, path),
    }))));
    for (const record of records.filter((record) => isConversationSeqInRanges(record.seq, run.conversationRefs))) {
      recordsBySeq.set(record.seq, record);
    }
  }
  const records = [...recordsBySeq.values()].sort((left, right) => left.seq - right.seq);
  return records.length > 0
    ? markdownTail(renderGitMemoryConversationMarkdownDocument(records), limit)
    : "";
}

async function readTaskRunsForConversation(
  driver: GitMemoryWorktreeGitDriver,
  ref: string,
  taskId: GitMemoryTaskId,
): Promise<GitMemoryRunFile[]> {
  const prefix = `${gitMemoryTaskDir(taskId)}/runs`;
  const paths = (await driver.listTreePaths(ref, prefix))
    .filter((path) => path.endsWith(".json"))
    .sort();
  const runs: GitMemoryRunFile[] = [];
  for (const path of paths) {
    const run = await readRefJson<GitMemoryRunFile>(driver, ref, path);
    if (run) {
      runs.push(run);
    }
  }
  return runs;
}

async function openExistingSessionMessageStoreDriver(
  driver: GitMemoryWorktreeGitDriver,
): Promise<GitMemoryWorktreeGitDriver | null> {
  const repoPath = join(driver.repoPath, GIT_MEMORY_SESSION_STORE_DIR);
  if (!(await pathExists(join(repoPath, ".git")))) {
    return null;
  }
  return new GitMemoryWorktreeGitDriver(repoPath);
}

async function readRefJson<T>(driver: GitMemoryWorktreeGitDriver, ref: string, path: string): Promise<T | null> {
  return parseJson<T>(await driver.readFile(ref, path));
}

async function readRefJsonl<T>(driver: GitMemoryWorktreeGitDriver, ref: string, path: string): Promise<T[]> {
  return parseJsonl<T>(await driver.readFile(ref, path));
}

function isConversationSeqInRanges(seq: number, ranges: GitMemoryConversationSeqRange[]): boolean {
  return ranges.some((range) => seq >= range.fromSeq && seq <= range.toSeq);
}

function stepToEvidenceRecord(step: GitMemoryStepRecord): GitMemoryEvidenceManifestRecord {
  const tools = step.toolCalls.map((call) => call.tool).filter(Boolean);
  return {
    v: 1,
    runId: step.runId,
    taskId: step.taskId,
    step: step.step,
    tool: tools.length > 0 ? unique(tools).join(",") : "agent_step",
    status: step.status === "failed" ? "failed" : step.status === "skipped" ? "skipped" : "completed",
    summary: step.summary || step.verification.summary || step.verification.evidenceSummary || "Step completed.",
    evidenceRef: step.verification.evidenceSummary ?? step.summary,
    artifacts: step.artifacts,
    facts: step.facts,
    accessModes: ["step"],
    ...(step.outputSize !== undefined ? { outputSize: step.outputSize } : {}),
    ...(step.lineCount !== undefined ? { lineCount: step.lineCount } : {}),
    ...(step.truncated !== undefined ? { truncated: step.truncated } : {}),
    source: {
      kind: "git-memory-step",
      step: step.step,
    },
  };
}

function scoreTaskSearchArtifact(
  artifact: GitMemoryTaskSearchArtifact,
  normalizedQuery: string,
  queryTokens: string[],
): { score: number; routeScore: number; reasons: string[] } {
  let score = 0;
  let routeScore = 0;
  const reasons = new Set<string>();
  const fields: Array<{
    reason: string;
    searchWeight: number;
    routeSingleTokenScore: number;
    routeMultiTokenScore: number;
    values: string[];
  }> = [
    { reason: "artifactPath", searchWeight: 95, routeSingleTokenScore: 82, routeMultiTokenScore: 95, values: [artifact.path] },
    { reason: "artifactFilename", searchWeight: 86, routeSingleTokenScore: 78, routeMultiTokenScore: 88, values: [basename(artifact.path)] },
    { reason: "artifactOriginalName", searchWeight: 90, routeSingleTokenScore: 82, routeMultiTokenScore: 90, values: artifact.originalName ? [artifact.originalName] : [] },
    { reason: "artifactIdentity", searchWeight: 88, routeSingleTokenScore: 70, routeMultiTokenScore: 88, values: [artifact.identity.name] },
    { reason: "artifactAlias", searchWeight: 82, routeSingleTokenScore: 68, routeMultiTokenScore: 82, values: artifact.identity.aliases },
    { reason: "artifactType", searchWeight: 20, routeSingleTokenScore: 20, routeMultiTokenScore: 40, values: [artifact.identity.type, artifact.kind, artifact.role] },
    { reason: "artifactSource", searchWeight: 15, routeSingleTokenScore: 15, routeMultiTokenScore: 35, values: [artifact.source] },
  ];

  for (const field of fields) {
    const fieldText = normalizeSearchText(field.values.join(" "));
    if (!fieldText) {
      continue;
    }
    if (normalizedQuery && fieldText.includes(normalizedQuery)) {
      score += queryTokens.length > 1 ? field.searchWeight * 3 : field.searchWeight;
      routeScore = Math.max(routeScore, queryTokens.length > 1
        ? field.routeMultiTokenScore
        : field.routeSingleTokenScore);
      reasons.add(field.reason);
      continue;
    }
    const hits = queryTokens.filter((token) => fieldText.includes(token)).length;
    if (hits > 0) {
      score += hits * field.searchWeight;
      routeScore = Math.max(routeScore, hits >= 2
        ? field.routeMultiTokenScore
        : field.routeSingleTokenScore);
      reasons.add(field.reason);
    }
  }

  const hasSpecificAttachmentWord = queryTokens.some((token) => token === "uploaded" || token === "attachment" || token === "attached");
  const hasUploadWord = queryTokens.includes("upload");
  if (artifact.source === "user_attachment" && (hasSpecificAttachmentWord || hasUploadWord)) {
    const identityText = normalizeSearchText([
      artifact.originalName,
      artifact.path,
      artifact.identity.name,
      ...artifact.identity.aliases,
    ].filter(Boolean).join(" "));
    const semanticHits = queryTokens.filter((token) => identityText.includes(token)).length;
    if (semanticHits > 0 && (hasSpecificAttachmentWord || semanticHits >= 2)) {
      score += 90 + semanticHits * 30;
      routeScore = Math.max(routeScore, semanticHits >= 2 ? 95 : 85);
      reasons.add("userAttachment");
    }
  }

  return {
    score,
    routeScore,
    reasons: [...reasons],
  };
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeMarkdownCharLimit(value: number | undefined, fallback: number): number {
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return fallback;
  }
  return Math.min(value, 50_000);
}

function markdownTail(value: string | null, limit: number): string {
  const trimmed = value?.trimEnd();
  if (!trimmed || trimmed === "# Conversation") {
    return "";
  }
  if (trimmed.length <= limit) {
    return `${trimmed}\n`;
  }
  const sliced = trimmed.slice(-limit);
  const headingIndex = sliced.search(/\n##\s/);
  return `${(headingIndex >= 0 ? sliced.slice(headingIndex + 1) : sliced).trimStart()}\n`;
}

function tail<T>(values: T[], limit: number): T[] {
  return values.slice(-limit);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function parseJson<T>(value: string | null): T | null {
  if (!value?.trim()) {
    return null;
  }
  return JSON.parse(value) as T;
}

function parseJsonl<T>(value: string | null): T[] {
  if (!value?.trim()) {
    return [];
  }
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
