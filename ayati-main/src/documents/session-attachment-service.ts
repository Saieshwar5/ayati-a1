import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ActiveAttachmentRecord, SessionMemory } from "../memory/types.js";
import { PreparedAttachmentRegistry, type PreparedAttachmentRecord } from "./prepared-attachment-registry.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "./types.js";
import type { DirectoryLibrary } from "../files/directory-library.js";
import type { FileLibrary } from "../files/file-library.js";

export interface SessionAttachmentServiceOptions {
  sessionMemory: SessionMemory;
  preparedAttachmentRegistry: PreparedAttachmentRegistry;
  dataDir: string;
  fileLibrary?: FileLibrary;
  directoryLibrary?: DirectoryLibrary;
}

export type RestoredAttachmentContext =
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
  };

export class SessionAttachmentService {
  private readonly sessionMemory: SessionMemory;
  private readonly preparedAttachmentRegistry: PreparedAttachmentRegistry;
  private readonly dataDir: string;
  private readonly fileLibrary?: FileLibrary;
  private readonly directoryLibrary?: DirectoryLibrary;

  constructor(options: SessionAttachmentServiceOptions) {
    this.sessionMemory = options.sessionMemory;
    this.preparedAttachmentRegistry = options.preparedAttachmentRegistry;
    this.dataDir = options.dataDir;
    this.fileLibrary = options.fileLibrary;
    this.directoryLibrary = options.directoryLibrary;
  }

  listActiveAttachments(): Array<{
    attachmentKind: string;
    assetId?: string;
    documentId?: string;
    fileId?: string;
    directoryId?: string;
    displayName: string;
    kind: string;
    mode?: string;
    capabilities?: string[];
    runId: string;
    runPath: string;
    preparedInputId?: string;
    path?: string;
    lastUsedAt: string;
    lastAction: string;
  }> {
    return this.sessionMemory.getActiveAttachmentRecords?.().map((record) => ({
      attachmentKind: record.attachmentKind,
      ...(record.assetId ? { assetId: record.assetId } : {}),
      ...(record.documentId ? { documentId: record.documentId } : {}),
      ...(record.fileId ? { fileId: record.fileId } : {}),
      ...(record.directoryId ? { directoryId: record.directoryId } : {}),
      displayName: record.displayName,
      kind: record.kind,
      ...(record.mode ? { mode: record.mode } : {}),
      ...(record.capabilities?.length ? { capabilities: record.capabilities } : {}),
      runId: record.runId,
      runPath: record.runPath,
      ...(record.preparedInputId ? { preparedInputId: record.preparedInputId } : {}),
      ...(record.path ? { path: record.path } : {}),
      lastUsedAt: record.lastUsedAt,
      lastAction: record.lastAction,
    })) ?? [];
  }

  async restoreAttachmentContext(input: {
    runId: string;
    reference?: string;
  }): Promise<RestoredAttachmentContext> {
    const currentRunAttachments = this.preparedAttachmentRegistry.getRunAttachments(input.runId);
    if ((input.reference?.trim().length ?? 0) === 0 && currentRunAttachments.length > 0) {
      throw new Error("Current run already has attachments. Use the current attachment, or specify the earlier file to restore.");
    }

    const activeRecords = this.sessionMemory.getActiveAttachmentRecords?.() ?? [];
    const sourceRecord = resolveActiveAttachment(activeRecords, input.reference);
    if (sourceRecord.attachmentKind === "file") {
      return this.restoreFileAttachment(input.runId, sourceRecord);
    }
    if (sourceRecord.attachmentKind === "directory") {
      return this.restoreDirectoryAttachment(input.runId, sourceRecord);
    }
    if (!sourceRecord.manifest || !sourceRecord.summary || !sourceRecord.documentId) {
      throw new Error(`Active attachment is missing prepared metadata: ${sourceRecord.displayName}`);
    }

    const existing = currentRunAttachments
      .find((record) => record.summary.documentId === sourceRecord.documentId);
    if (existing) {
      return {
        restored: false,
        attachmentKind: existing.summary.mode === "structured_data" ? "dataset" : "document",
        manifest: existing.manifest,
        summary: existing.summary,
      };
    }

    const runPath = resolve(this.dataDir, "runs", input.runId);
    const summary = cloneSummaryWithNewId(
      sourceRecord.summary,
      buildPreparedInputId(this.preparedAttachmentRegistry.getRunAttachments(input.runId).length + 1, sourceRecord.documentId),
      runPath,
    );
    const restored: PreparedAttachmentRecord = {
      summary,
      manifest: sourceRecord.manifest,
      runPath,
      detail: {
        kind: sourceRecord.summary.mode,
        payload: buildRestoredDetailPayload(sourceRecord.detail ?? {}, summary),
      },
    };

    this.preparedAttachmentRegistry.upsertRunAttachment(input.runId, runPath, restored);
    await persistRestoredAttachmentArtifacts(runPath, this.preparedAttachmentRegistry.getRunAttachments(input.runId));

    return {
      restored: true,
      attachmentKind: restored.summary.mode === "structured_data" ? "dataset" : "document",
      manifest: restored.manifest,
      summary: restored.summary,
    };
  }

  private async restoreFileAttachment(runId: string, sourceRecord: ActiveAttachmentRecord): Promise<RestoredAttachmentContext> {
    if (!this.fileLibrary) {
      throw new Error("Managed file restoration is not configured.");
    }
    const fileId = sourceRecord.fileId;
    if (!fileId) {
      throw new Error(`Active file attachment is missing a fileId: ${sourceRecord.displayName}`);
    }

    const currentFiles = await this.fileLibrary.listRunFiles(runId);
    const existing = currentFiles.find((file) => file.fileId === fileId);
    if (!existing) {
      await this.fileLibrary.touchRunFile(runId, fileId, "used");
    }
    const file = existing ?? await this.fileLibrary.getFile(fileId);
    return {
      restored: !existing,
      attachmentKind: "file",
      fileId: file.fileId,
      displayName: file.originalName,
      kind: file.kind,
    };
  }

  private async restoreDirectoryAttachment(runId: string, sourceRecord: ActiveAttachmentRecord): Promise<RestoredAttachmentContext> {
    if (!this.directoryLibrary) {
      throw new Error("Managed directory restoration is not configured.");
    }
    const directoryId = sourceRecord.directoryId;
    if (!directoryId) {
      throw new Error(`Active directory attachment is missing a directoryId: ${sourceRecord.displayName}`);
    }

    const currentDirectories = await this.directoryLibrary.listRunDirectories(runId);
    const existing = currentDirectories.find((directory) => directory.directoryId === directoryId);
    if (!existing) {
      await this.directoryLibrary.touchRunDirectory(runId, directoryId, "used");
    }
    const directory = existing ?? await this.directoryLibrary.getDirectory(directoryId);
    return {
      restored: !existing,
      attachmentKind: "directory",
      directoryId: directory.directoryId,
      displayName: directory.name,
      kind: "directory",
    };
  }
}

function resolveActiveAttachment(
  records: ActiveAttachmentRecord[],
  reference?: string,
): ActiveAttachmentRecord {
  if (records.length === 0) {
    throw new Error("No active session attachments are available to restore.");
  }

  const normalizedReference = reference?.trim();
  if (!normalizedReference) {
    if (records.length === 1) {
      return records[0]!;
    }
    throw new Error(buildRestoreResolutionError(records));
  }

  const loweredReference = normalizedReference.toLowerCase();
  const strategies: Array<(record: NonNullable<(typeof records)[number]>) => boolean> = [
    (record) => record.preparedInputId === normalizedReference,
    (record) => record.preparedInputId?.startsWith(normalizedReference) === true,
    (record) => record.fileId === normalizedReference,
    (record) => record.directoryId === normalizedReference,
    (record) => record.assetId === normalizedReference,
    (record) => record.documentId === normalizedReference,
    (record) => record.documentId?.startsWith(normalizedReference) === true,
    (record) => record.displayName.toLowerCase() === loweredReference,
    (record) => record.manifest?.name.toLowerCase() === loweredReference,
    (record) => record.manifest?.originalPath === normalizedReference,
    (record) => record.manifest?.originalPath.toLowerCase().endsWith(loweredReference) === true,
    (record) => record.path === normalizedReference,
    (record) => record.path?.toLowerCase().endsWith(loweredReference) === true,
  ];

  for (const matcher of strategies) {
    const matches = records.filter(matcher);
    if (matches.length === 1) {
      return matches[0]!;
    }
    if (matches.length > 1) {
      throw new Error(buildRestoreResolutionError(matches));
    }
  }

  if (records.length === 1) {
    return records[0]!;
  }
  throw new Error(buildRestoreResolutionError(records));
}

function buildRestoreResolutionError(records: ActiveAttachmentRecord[]): string {
  return `Unable to uniquely resolve the active attachment. Available options: ${records.map((record) => `${attachmentReferenceLabel(record)} (${record.displayName})`).join(", ")}`;
}

function attachmentReferenceLabel(record: ActiveAttachmentRecord): string {
  return record.preparedInputId
    ?? record.fileId
    ?? record.directoryId
    ?? record.assetId
    ?? record.documentId
    ?? record.attachmentKind;
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
