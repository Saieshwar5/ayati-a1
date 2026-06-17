import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PreparedAttachmentRegistry, type PreparedAttachmentRecord } from "./prepared-attachment-registry.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "./types.js";
import type { DirectoryLibrary } from "../files/directory-library.js";
import type { FileLibrary } from "../files/file-library.js";
import type { ActivityStore } from "../memory/activity/activity-store.js";
import type { ActivityAssetRef, ActivityThread } from "../memory/activity/types.js";

export interface SessionAttachmentServiceOptions {
  activityStore?: ActivityStore;
  preparedAttachmentRegistry: PreparedAttachmentRegistry;
  dataDir: string;
  fileLibrary?: FileLibrary;
  directoryLibrary?: DirectoryLibrary;
}

type RestoredActivitySource = {
  activityId: string;
  assetId: string;
};

export type RestoredAttachmentContext = RestoredActivitySource & (
  | {
    restored: boolean;
    attachmentKind: "document" | "dataset";
    manifest: ManagedDocumentManifest;
    summary: PreparedAttachmentSummary;
  }
  | {
    restored: boolean;
    attachmentKind: "file";
    fileId: string;
    displayName: string;
    kind: string;
  }
  | {
    restored: boolean;
    attachmentKind: "directory";
    directoryId: string;
    displayName: string;
    kind: "directory";
  }
);

interface ActivityAttachmentCandidate {
  activity: ActivityThread;
  asset: ActivityAssetRef;
}

export class SessionAttachmentService {
  private readonly activityStore?: ActivityStore;
  private readonly preparedAttachmentRegistry: PreparedAttachmentRegistry;
  private readonly dataDir: string;
  private readonly fileLibrary?: FileLibrary;
  private readonly directoryLibrary?: DirectoryLibrary;

  constructor(options: SessionAttachmentServiceOptions) {
    this.activityStore = options.activityStore;
    this.preparedAttachmentRegistry = options.preparedAttachmentRegistry;
    this.dataDir = options.dataDir;
    this.fileLibrary = options.fileLibrary;
    this.directoryLibrary = options.directoryLibrary;
  }

  async restoreAttachmentContext(input: {
    runId: string;
    clientId?: string;
    sessionId?: string;
    activityId?: string;
    assetId?: string;
    reference?: string;
  }): Promise<RestoredAttachmentContext> {
    const currentRunAttachments = this.preparedAttachmentRegistry.getRunAttachments(input.runId);
    if (!hasExplicitRestoreReference(input) && currentRunAttachments.length > 0) {
      throw new Error("Current run already has attachments. Use the current attachment, or specify the earlier file to restore.");
    }

    const source = this.resolveActivityAttachment(input);
    if (source.asset.kind === "file") {
      return this.restoreFileAttachment(input.runId, source);
    }
    if (source.asset.kind === "directory") {
      return this.restoreDirectoryAttachment(input.runId, source);
    }
    if (!source.asset.manifest || !source.asset.summary || !source.asset.summary.documentId) {
      throw new Error(`Activity asset is missing prepared metadata: ${assetDisplayName(source.asset)}`);
    }

    const existing = currentRunAttachments
      .find((record) => record.summary.documentId === source.asset.summary?.documentId);
    if (existing) {
      return {
        activityId: source.activity.activityId,
        assetId: source.asset.assetId,
        restored: false,
        attachmentKind: existing.summary.mode === "structured_data" ? "dataset" : "document",
        manifest: existing.manifest,
        summary: existing.summary,
      };
    }

    const runPath = resolve(this.dataDir, "runs", input.runId);
    const summary = cloneSummaryWithNewId(
      source.asset.summary,
      buildPreparedInputId(this.preparedAttachmentRegistry.getRunAttachments(input.runId).length + 1, source.asset.summary.documentId),
      runPath,
    );
    const restored: PreparedAttachmentRecord = {
      summary,
      manifest: source.asset.manifest,
      runPath,
      detail: {
        kind: source.asset.summary.mode,
        payload: buildRestoredDetailPayload(normalizeAssetDetail(source.asset.detail), summary),
      },
    };

    this.preparedAttachmentRegistry.upsertRunAttachment(input.runId, runPath, restored);
    await persistRestoredAttachmentArtifacts(runPath, this.preparedAttachmentRegistry.getRunAttachments(input.runId));

    return {
      activityId: source.activity.activityId,
      assetId: source.asset.assetId,
      restored: true,
      attachmentKind: restored.summary.mode === "structured_data" ? "dataset" : "document",
      manifest: restored.manifest,
      summary: restored.summary,
    };
  }

  private resolveActivityAttachment(input: {
    clientId?: string;
    sessionId?: string;
    activityId?: string;
    assetId?: string;
    reference?: string;
  }): ActivityAttachmentCandidate {
    const activityStore = this.requireActivityStore();
    const activities = this.resolveCandidateActivities(activityStore, input);
    const candidates = uniqueActivityCandidates(activities.flatMap((activity) => (
      activity.assets
        .filter(isRestorableActivityAttachmentAsset)
        .map((asset) => ({ activity, asset }))
    )));

    if (candidates.length === 0) {
      const labels = activities.map((activity) => activity.title).join(", ");
      throw new Error(labels
        ? `The selected activity has no restorable attachment assets: ${labels}.`
        : "No current activity is available for attachment restore. Pass activityId or select an activity first.");
    }

    return resolveActivityAttachmentCandidate(candidates, input);
  }

  private resolveCandidateActivities(
    activityStore: ActivityStore,
    input: { clientId?: string; sessionId?: string; activityId?: string },
  ): ActivityThread[] {
    const explicitActivityId = input.activityId?.trim();
    if (explicitActivityId) {
      const activity = activityStore.getActivity(explicitActivityId);
      if (!activity || (input.clientId && activity.clientId !== input.clientId)) {
        throw new Error(`Activity is not available for attachment restore: ${explicitActivityId}`);
      }
      return [activity];
    }

    if (!input.clientId) {
      throw new Error("Attachment restore requires a current activity or explicit clientId/activityId context.");
    }

    const recent = activityStore.listRecent(input.clientId, 1);
    if (recent.length === 0) {
      throw new Error("No current activity is available for attachment restore. Pass activityId.");
    }
    return uniqueActivityThreads(recent);
  }

  private requireActivityStore(): ActivityStore {
    if (!this.activityStore) {
      throw new Error("Attachment restore requires a configured ActivityStore.");
    }
    return this.activityStore;
  }

  private async restoreFileAttachment(runId: string, source: ActivityAttachmentCandidate): Promise<RestoredAttachmentContext> {
    if (!this.fileLibrary) {
      throw new Error("Managed file restoration is not configured.");
    }
    const fileId = source.asset.fileId;
    if (!fileId) {
      throw new Error(`Activity file asset is missing a fileId: ${assetDisplayName(source.asset)}`);
    }

    const currentFiles = await this.fileLibrary.listRunFiles(runId);
    const existing = currentFiles.find((file) => file.fileId === fileId);
    if (!existing) {
      await this.fileLibrary.touchRunFile(runId, fileId, "used");
    }
    const file = existing ?? await this.fileLibrary.getFile(fileId);
    return {
      activityId: source.activity.activityId,
      assetId: source.asset.assetId,
      restored: !existing,
      attachmentKind: "file",
      fileId: file.fileId,
      displayName: file.originalName,
      kind: file.kind,
    };
  }

  private async restoreDirectoryAttachment(runId: string, source: ActivityAttachmentCandidate): Promise<RestoredAttachmentContext> {
    if (!this.directoryLibrary) {
      throw new Error("Managed directory restoration is not configured.");
    }
    const directoryId = source.asset.directoryId;
    if (!directoryId) {
      throw new Error(`Activity directory asset is missing a directoryId: ${assetDisplayName(source.asset)}`);
    }

    const currentDirectories = await this.directoryLibrary.listRunDirectories(runId);
    const existing = currentDirectories.find((directory) => directory.directoryId === directoryId);
    if (!existing) {
      await this.directoryLibrary.touchRunDirectory(runId, directoryId, "used");
    }
    const directory = existing ?? await this.directoryLibrary.getDirectory(directoryId);
    return {
      activityId: source.activity.activityId,
      assetId: source.asset.assetId,
      restored: !existing,
      attachmentKind: "directory",
      directoryId: directory.directoryId,
      displayName: directory.name,
      kind: "directory",
    };
  }
}

function hasExplicitRestoreReference(input: {
  activityId?: string;
  assetId?: string;
  reference?: string;
}): boolean {
  return [input.activityId, input.assetId, input.reference].some((value) => typeof value === "string" && value.trim().length > 0);
}

function resolveActivityAttachmentCandidate(
  candidates: ActivityAttachmentCandidate[],
  input: { assetId?: string; reference?: string },
): ActivityAttachmentCandidate {
  const explicitAssetId = input.assetId?.trim();
  if (explicitAssetId) {
    const matches = candidates.filter((candidate) => candidate.asset.assetId === explicitAssetId);
    return pickResolvedCandidate(matches, candidates);
  }

  const normalizedReference = input.reference?.trim();
  if (!normalizedReference) {
    if (candidates.length === 1) {
      return candidates[0]!;
    }
    throw new Error(buildRestoreResolutionError(candidates));
  }

  const loweredReference = normalizedReference.toLowerCase();
  const strategies: Array<(candidate: ActivityAttachmentCandidate) => boolean> = [
    (candidate) => candidate.asset.preparedInputId === normalizedReference,
    (candidate) => candidate.asset.preparedInputId?.startsWith(normalizedReference) === true,
    (candidate) => candidate.asset.fileId === normalizedReference,
    (candidate) => candidate.asset.directoryId === normalizedReference,
    (candidate) => candidate.asset.assetId === normalizedReference,
    (candidate) => candidate.asset.documentId === normalizedReference,
    (candidate) => candidate.asset.documentId?.startsWith(normalizedReference) === true,
    (candidate) => candidate.asset.summary?.documentId === normalizedReference,
    (candidate) => candidate.asset.summary?.documentId.startsWith(normalizedReference) === true,
    (candidate) => assetDisplayName(candidate.asset).toLowerCase() === loweredReference,
    (candidate) => candidate.asset.manifest?.name.toLowerCase() === loweredReference,
    (candidate) => candidate.asset.manifest?.originalPath === normalizedReference,
    (candidate) => candidate.asset.manifest?.originalPath.toLowerCase().endsWith(loweredReference) === true,
    (candidate) => candidate.asset.path === normalizedReference,
    (candidate) => candidate.asset.path?.toLowerCase().endsWith(loweredReference) === true,
    (candidate) => candidate.asset.restore?.filePath === normalizedReference,
    (candidate) => candidate.asset.restore?.filePath?.toLowerCase().endsWith(loweredReference) === true,
    (candidate) => candidate.asset.restore?.directoryPath === normalizedReference,
    (candidate) => candidate.asset.restore?.directoryPath?.toLowerCase().endsWith(loweredReference) === true,
  ];

  for (const matcher of strategies) {
    const matches = candidates.filter(matcher);
    if (matches.length > 0) {
      return pickResolvedCandidate(matches, candidates);
    }
  }

  if (candidates.length === 1) {
    return candidates[0]!;
  }
  throw new Error(buildRestoreResolutionError(candidates));
}

function pickResolvedCandidate(
  matches: ActivityAttachmentCandidate[],
  allCandidates: ActivityAttachmentCandidate[],
): ActivityAttachmentCandidate {
  const unique = uniqueActivityCandidates(matches);
  if (unique.length === 1) {
    return unique[0]!;
  }
  throw new Error(buildRestoreResolutionError(unique.length > 0 ? unique : allCandidates));
}

function buildRestoreResolutionError(candidates: ActivityAttachmentCandidate[]): string {
  return `Unable to uniquely resolve the activity attachment. Available options: ${candidates.map(candidateReferenceLabel).join(", ")}`;
}

function candidateReferenceLabel(candidate: ActivityAttachmentCandidate): string {
  const asset = candidate.asset;
  const reference = asset.preparedInputId
    ?? asset.fileId
    ?? asset.directoryId
    ?? asset.assetId
    ?? asset.documentId
    ?? asset.summary?.documentId
    ?? asset.kind;
  return `${reference} (${assetDisplayName(asset)} in ${candidate.activity.title})`;
}

function uniqueActivityThreads(activities: ActivityThread[]): ActivityThread[] {
  const seen = new Set<string>();
  const output: ActivityThread[] = [];
  for (const activity of activities) {
    if (seen.has(activity.activityId)) {
      continue;
    }
    seen.add(activity.activityId);
    output.push(activity);
  }
  return output;
}

function uniqueActivityCandidates(candidates: ActivityAttachmentCandidate[]): ActivityAttachmentCandidate[] {
  const seen = new Set<string>();
  const output: ActivityAttachmentCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.activity.activityId}:${candidate.asset.assetId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(candidate);
  }
  return output;
}

function isRestorableActivityAttachmentAsset(asset: ActivityAssetRef): boolean {
  if ((asset.kind === "document" || asset.kind === "dataset") && asset.manifest && asset.summary) {
    return true;
  }
  if (asset.kind === "file" && typeof asset.fileId === "string" && asset.fileId.trim().length > 0) {
    return true;
  }
  return asset.kind === "directory" && typeof asset.directoryId === "string" && asset.directoryId.trim().length > 0;
}

function assetDisplayName(asset: ActivityAssetRef): string {
  return asset.displayName
    ?? asset.summary?.displayName
    ?? asset.path
    ?? asset.fileId
    ?? asset.directoryId
    ?? asset.documentId
    ?? asset.assetId;
}

function normalizeAssetDetail(detail: ActivityAssetRef["detail"]): Record<string, unknown> {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    return {};
  }
  const record = detail as Record<string, unknown>;
  const payload = record["payload"];
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return record;
}

function buildPreparedInputId(index: number, documentId: string): string {
  return `att_${index}_${documentId.slice(0, 8)}`;
}

function cloneSummaryWithNewId(
  summary: PreparedAttachmentSummary,
  preparedInputId: string,
  runPath: string,
): PreparedAttachmentSummary {
  const next: PreparedAttachmentSummary = {
    ...summary,
    preparedInputId,
    artifactPath: join(runPath, "attachments", `${preparedInputId}.json`),
  };
  if (next.structured) {
    next.structured = {
      ...next.structured,
      staged: false,
      stagingDbPath: join(runPath, "attachments", "staging.sqlite"),
      stagingTableName: `staging_${preparedInputId}`,
    };
  }
  return next;
}

async function persistRestoredAttachmentArtifacts(runPath: string, records: PreparedAttachmentRecord[]): Promise<void> {
  const attachmentsDir = join(runPath, "attachments");
  await mkdir(attachmentsDir, { recursive: true });
  for (const record of records) {
    await writeFile(record.summary.artifactPath, JSON.stringify(record.detail.payload, null, 2), "utf-8");
  }
  await writeFile(join(attachmentsDir, "index.json"), JSON.stringify({ attachments: records.map((record) => record.summary) }, null, 2), "utf-8");
}

function buildRestoredDetailPayload(detail: Record<string, unknown>, summary: PreparedAttachmentSummary): Record<string, unknown> {
  const payload = { ...detail };
  if (summary.structured) {
    payload["staged"] = false;
    payload["stagingDbPath"] = summary.structured.stagingDbPath;
    payload["stagingTableName"] = summary.structured.stagingTableName;
  }
  return payload;
}
