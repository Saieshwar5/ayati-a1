import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import type { TaskAssetRecord } from "../contracts.js";
import type {
  GitMemoryActionRecord,
  GitMemoryEvidenceManifestRecord,
  GitMemoryRunId,
  GitMemoryTaskId,
  GitMemoryTaskStateDecision,
  GitMemoryTaskStateEvidence,
  GitMemoryTaskStateFact,
  GitMemoryTaskStateFileRecord,
} from "./schema.js";
import { tokenizeSearchText } from "./session-store-readers.js";

export interface ArtifactIdentityContext {
  title: string;
  objective: string;
  sourceTurnSeq?: number;
}

export function normalizeMemoryList(values: Array<string | undefined> | undefined): string[] | undefined {
  const normalized = (values ?? []).map((value) => value?.trim() ?? "").filter(Boolean);
  return normalized.length > 0 ? unique(normalized) : undefined;
}

export function taskStateFacts(
  values: string[],
  sourceRunId?: GitMemoryRunId,
  confidence: GitMemoryTaskStateFact["confidence"] = "observed",
): GitMemoryTaskStateFact[] {
  return unique(values)
    .map((text) => ({
      text,
      ...(sourceRunId ? { sourceRunId } : {}),
      confidence,
    }));
}

export function mergeTaskStateFacts(
  existing: GitMemoryTaskStateFact[],
  incoming: GitMemoryTaskStateFact[],
): GitMemoryTaskStateFact[] {
  const facts = new Map<string, GitMemoryTaskStateFact>();
  for (const fact of [...existing, ...incoming]) {
    facts.set(fact.text.toLowerCase(), fact);
  }
  return [...facts.values()];
}

export function taskStateDecisions(values: string[], sourceRunId: GitMemoryRunId): GitMemoryTaskStateDecision[] {
  return unique(values).map((text) => ({ text, sourceRunId }));
}

export function mergeTaskStateDecisions(
  existing: GitMemoryTaskStateDecision[],
  incoming: GitMemoryTaskStateDecision[],
): GitMemoryTaskStateDecision[] {
  const decisions = new Map<string, GitMemoryTaskStateDecision>();
  for (const decision of [...existing, ...incoming]) {
    decisions.set(decision.text.toLowerCase(), decision);
  }
  return [...decisions.values()];
}

export function taskStateEvidence(
  evidence: GitMemoryEvidenceManifestRecord[],
  sourceRunId: GitMemoryRunId,
): GitMemoryTaskStateEvidence[] {
  return evidence
    .map((record) => ({
      summary: record.summary,
      sourceRunId,
      ...(record.step ? { sourceStep: record.step } : {}),
      artifacts: record.artifacts,
      facts: record.facts,
    }))
    .filter((record) => record.summary.trim().length > 0);
}

export function mergeTaskStateEvidence(
  existing: GitMemoryTaskStateEvidence[],
  incoming: GitMemoryTaskStateEvidence[],
): GitMemoryTaskStateEvidence[] {
  const evidence = new Map<string, GitMemoryTaskStateEvidence>();
  for (const record of [...existing, ...incoming]) {
    evidence.set(`${record.sourceRunId ?? ""}:${record.sourceStep ?? ""}:${record.summary.toLowerCase()}`, record);
  }
  return [...evidence.values()];
}

export function taskStateFiles(
  paths: string[],
  role: GitMemoryTaskStateFileRecord["role"],
  reason: string,
  sourceRunId: GitMemoryRunId,
  context: ArtifactIdentityContext,
): GitMemoryTaskStateFileRecord[] {
  return unique(paths)
    .map((path) => taskStateFileRecord({
      source: "agent_workspace",
      kind: inferArtifactKind(path),
      path,
      role,
      reason,
      sourceRunId,
      lastTouchedRunId: sourceRunId,
      confidence: "verified",
    }, context));
}

export function taskStateFilesFromAssets(
  assets: TaskAssetRecord[],
  sourceRunId: GitMemoryRunId,
  context: ArtifactIdentityContext,
): GitMemoryTaskStateFileRecord[] {
  return assets
    .map((asset) => taskStateFileRecord({
      source: isUserAttachmentAsset(asset) ? "user_attachment" : "agent_workspace",
      kind: asset.kind,
      path: asset.path ?? asset.name,
      originalName: asset.name,
      role: asset.role === "generated" ? "generated" : "reference",
      reason: asset.role === "generated" ? "generated task asset" : "task input asset",
      sourceRunId,
      ...(asset.role === "generated" ? { lastTouchedRunId: sourceRunId } : {}),
      confidence: isUserAttachmentAsset(asset) ? "user_provided" : "verified",
    }, context))
    .filter((record, index, all) => all.findIndex((candidate) => candidate.path === record.path && candidate.source === record.source) === index);
}

export function mergeTaskStateFiles(
  existing: GitMemoryTaskStateFileRecord[],
  incoming: GitMemoryTaskStateFileRecord[],
): GitMemoryTaskStateFileRecord[] {
  const files = new Map<string, GitMemoryTaskStateFileRecord>();
  for (const file of [...existing, ...incoming]) {
    const key = `${file.source}:${file.path}`;
    const previous = files.get(key);
    files.set(key, previous ? {
      ...previous,
      ...file,
      artifactId: previous.artifactId || file.artifactId,
      role: chooseTaskFileRole(previous.role, file.role),
      reason: chooseTaskFileRole(previous.role, file.role) === previous.role ? previous.reason : file.reason,
      createdByRunId: previous.createdByRunId ?? file.createdByRunId,
      sourceRunId: file.sourceRunId ?? previous.sourceRunId,
      lastTouchedRunId: file.lastTouchedRunId ?? previous.lastTouchedRunId,
    } : file);
  }
  return [...files.values()];
}

export function taskStateFileSearchTerms(file: GitMemoryTaskStateFileRecord): string[] {
  return [
    file.path,
    file.originalName ?? "",
    file.identity.name,
    file.identity.description,
    file.identity.type,
    ...file.identity.aliases,
  ];
}

export function deriveTaskStateSearchTerms(input: {
  taskId: GitMemoryTaskId;
  branch: string;
  title: string;
  objective: string;
  summary: string;
  completed: string[];
  open: string[];
  blockers: string[];
  facts: string[];
  next: string;
  files: string[];
  decisions: string[];
}): string[] {
  return unique([
    input.taskId,
    input.branch,
    input.title,
    input.objective,
    input.summary,
    input.next,
    ...input.completed,
    ...input.open,
    ...input.blockers,
    ...input.facts,
    ...input.files,
    ...input.decisions,
  ].flatMap(tokenizeSearchText));
}

export function actionSummaries(actions: GitMemoryActionRecord[]): string[] {
  return unique(actions
    .filter((action) => action.status === "completed")
    .map((action) => action.summary.trim())
    .filter(Boolean));
}

export function actionVerificationSummaries(actions: GitMemoryActionRecord[]): string[] {
  return unique(actions
    .filter((action) => action.evidenceRef)
    .map((action) => `${action.tool}: ${action.evidenceRef}`)
    .filter(Boolean));
}

export function evidenceSummaries(evidence: GitMemoryEvidenceManifestRecord[]): string[] | undefined {
  const summaries = unique(evidence
    .map((record) => record.summary.trim())
    .filter(Boolean));
  return summaries.length > 0 ? summaries : undefined;
}

export function taskNoteFiles(
  changedFiles: string[],
  evidence: GitMemoryEvidenceManifestRecord[],
  assets: TaskAssetRecord[],
): string[] {
  return unique([
    ...changedFiles,
    ...evidence.flatMap((record) => record.artifacts),
    ...assets.map((asset) => asset.path ?? asset.name ?? "").filter(Boolean),
  ].map((value) => value.trim()).filter(Boolean));
}

export function mergeTaskAssets(
  existing: TaskAssetRecord[],
  incoming: TaskAssetRecord[],
): TaskAssetRecord[] {
  const assets = new Map<string, TaskAssetRecord>();
  for (const asset of [...existing, ...incoming]) {
    assets.set(taskAssetKey(asset), asset);
  }
  return [...assets.values()];
}

export function sameTaskAssets(left: TaskAssetRecord[], right: TaskAssetRecord[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isTaskAssetRecord(value: unknown): value is TaskAssetRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.assetId === "string"
    && typeof record.role === "string"
    && typeof record.kind === "string"
    && typeof record.name === "string";
}

function taskStateFileRecord(
  input: {
    source: GitMemoryTaskStateFileRecord["source"];
    kind: string;
    path: string;
    originalName?: string;
    mimeType?: string;
    role: GitMemoryTaskStateFileRecord["role"];
    reason: string;
    sourceRunId: GitMemoryRunId;
    lastTouchedRunId?: GitMemoryRunId;
    confidence: GitMemoryTaskStateFileRecord["confidence"];
  },
  context: ArtifactIdentityContext,
): GitMemoryTaskStateFileRecord {
  const identity = buildArtifactIdentity({
    path: input.path,
    originalName: input.originalName,
    kind: input.kind,
    source: input.source,
    title: context.title,
    objective: context.objective,
  });
  return {
    artifactId: stableArtifactId(input.source, input.path),
    source: input.source,
    kind: input.kind,
    path: input.path,
    ...(input.originalName ? { originalName: input.originalName } : {}),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    role: input.role,
    identity,
    status: "active",
    reason: input.reason,
    ...(input.role === "generated" || input.role === "modified" ? { createdByRunId: input.sourceRunId } : {}),
    ...(input.lastTouchedRunId ? { lastTouchedRunId: input.lastTouchedRunId } : {}),
    sourceRunId: input.sourceRunId,
    ...(context.sourceTurnSeq ? { sourceTurnSeq: context.sourceTurnSeq } : {}),
    confidence: input.confidence,
  };
}

function chooseTaskFileRole(
  previous: GitMemoryTaskStateFileRecord["role"],
  incoming: GitMemoryTaskStateFileRecord["role"],
): GitMemoryTaskStateFileRecord["role"] {
  return taskFileRolePriority(incoming) > taskFileRolePriority(previous) ? incoming : previous;
}

function taskFileRolePriority(role: GitMemoryTaskStateFileRecord["role"]): number {
  switch (role) {
    case "modified":
      return 5;
    case "created":
      return 4;
    case "generated":
      return 3;
    case "touched":
      return 2;
    case "reference":
      return 1;
  }
}

function buildArtifactIdentity(input: {
  path: string;
  originalName?: string;
  kind: string;
  source: GitMemoryTaskStateFileRecord["source"];
  title: string;
  objective: string;
}): GitMemoryTaskStateFileRecord["identity"] {
  const fileName = input.originalName?.trim() || basename(input.path);
  const subject = taskSubject(input.title, input.objective);
  const type = inferArtifactIdentityType(input.path, input.kind);
  const label = artifactLabel(fileName, type, input.source);
  const name = titleCase(`${subject} ${label}`.trim());
  const aliases = unique([
    fileName,
    stripExtension(fileName),
    label,
    `${subject} ${label}`,
    type.replace(/_/g, " "),
    ...(input.source === "user_attachment" ? [`uploaded ${label}`, `attached ${label}`] : []),
  ].flatMap((value) => [value, normalizeAlias(value)]));
  return {
    name,
    type,
    description: input.source === "user_attachment"
      ? `User-provided ${label} for ${subject}.`
      : `${label} for ${subject}.`,
    aliases,
  };
}

function taskSubject(title: string, objective: string): string {
  const source = title.trim() || objective.trim() || "task";
  return normalizeWords(source
    .replace(/^(create|build|make|update|fix|implement|add|write|generate)\s+/i, "")
    .replace(/\b(static|tiny|simple|new)\b/gi, " "))
    || "task";
}

function artifactLabel(fileName: string, type: string, source: GitMemoryTaskStateFileRecord["source"]): string {
  const stem = stripExtension(fileName).toLowerCase();
  if (stem === "index" && type === "html_page") return "homepage";
  if (["style", "styles", "main"].includes(stem) && type === "stylesheet") return "stylesheet";
  if (stem.includes("logo")) return "logo";
  if (type === "html_page") return `${normalizeWords(stem)} page`;
  if (type === "stylesheet") return "stylesheet";
  if (type === "script") return "script";
  if (type === "image_asset") return source === "user_attachment" ? "image asset" : "image";
  if (type === "directory") return `${normalizeWords(stem)} directory`;
  return normalizeWords(stem) || "artifact";
}

function inferArtifactKind(path: string): string {
  return extname(path) ? "file" : "directory";
}

function inferArtifactIdentityType(path: string, kind: string): string {
  if (kind === "directory") return "directory";
  const ext = extname(path).toLowerCase();
  if ([".html", ".htm"].includes(ext)) return "html_page";
  if (ext === ".css") return "stylesheet";
  if ([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"].includes(ext)) return "script";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image_asset";
  if ([".json", ".csv", ".xlsx", ".xls", ".sqlite", ".db"].includes(ext)) return "data_file";
  if ([".md", ".txt", ".pdf", ".doc", ".docx"].includes(ext)) return "document";
  return "file";
}

function isUserAttachmentAsset(asset: TaskAssetRecord): boolean {
  return asset.role === "input" || asset.role === "reference" || Boolean(asset.sessionAssetId);
}

function stableArtifactId(source: GitMemoryTaskStateFileRecord["source"], path: string): string {
  return `artifact-${createHash("sha256").update(`${source}:${path}`).digest("hex").slice(0, 16)}`;
}

function stripExtension(value: string): string {
  const extension = extname(value);
  return extension ? value.slice(0, -extension.length) : value;
}

function titleCase(value: string): string {
  return normalizeWords(value).replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function normalizeWords(value: string): string {
  return value
    .replace(/[_/-]+/g, " ")
    .replace(/[^a-z0-9 ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeAlias(value: string): string {
  return normalizeWords(value);
}

function taskAssetKey(asset: TaskAssetRecord): string {
  return asset.assetId
    || asset.sessionAssetId
    || asset.path
    || `${asset.role}:${asset.kind}:${asset.name}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
