import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ActiveAttachmentRecord, SessionMemory } from "../memory/types.js";
import { PreparedAttachmentRegistry, type PreparedAttachmentRecord } from "./prepared-attachment-registry.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "./types.js";

export interface SessionAttachmentServiceOptions {
  sessionMemory: SessionMemory;
  preparedAttachmentRegistry: PreparedAttachmentRegistry;
  dataDir: string;
}

export class SessionAttachmentService {
  private readonly sessionMemory: SessionMemory;
  private readonly preparedAttachmentRegistry: PreparedAttachmentRegistry;
  private readonly dataDir: string;

  constructor(options: SessionAttachmentServiceOptions) {
    this.sessionMemory = options.sessionMemory;
    this.preparedAttachmentRegistry = options.preparedAttachmentRegistry;
    this.dataDir = options.dataDir;
  }

  listActiveAttachments(): Array<{
    documentId: string;
    displayName: string;
    kind: string;
    mode: string;
    runId: string;
    runPath: string;
    preparedInputId: string;
    lastUsedAt: string;
    lastAction: string;
  }> {
    return this.sessionMemory.getActiveAttachmentRecords?.().map((record) => ({
      documentId: record.documentId,
      displayName: record.displayName,
      kind: record.kind,
      mode: record.mode,
      runId: record.runId,
      runPath: record.runPath,
      preparedInputId: record.preparedInputId,
      lastUsedAt: record.lastUsedAt,
      lastAction: record.lastAction,
    })) ?? [];
  }

  async restoreAttachmentContext(input: {
    runId: string;
    reference?: string;
  }): Promise<{
    restored: boolean;
    manifest: ManagedDocumentManifest;
    summary: PreparedAttachmentSummary;
  }> {
    const activeRecords = this.sessionMemory.getActiveAttachmentRecords?.() ?? [];
    const sourceRecord = resolveActiveAttachment(activeRecords, input.reference);

    const existing = this.preparedAttachmentRegistry
      .getRunAttachments(input.runId)
      .find((record) => record.summary.documentId === sourceRecord.documentId);
    if (existing) {
      return {
        restored: false,
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
        payload: buildRestoredDetailPayload(sourceRecord.detail, summary),
      },
    };

    this.preparedAttachmentRegistry.upsertRunAttachment(input.runId, runPath, restored);
    await persistRestoredAttachmentArtifacts(runPath, this.preparedAttachmentRegistry.getRunAttachments(input.runId));

    return {
      restored: true,
      manifest: restored.manifest,
      summary: restored.summary,
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
    (record) => record.preparedInputId.startsWith(normalizedReference),
    (record) => record.documentId === normalizedReference,
    (record) => record.documentId.startsWith(normalizedReference),
    (record) => record.displayName.toLowerCase() === loweredReference,
    (record) => record.manifest.name.toLowerCase() === loweredReference,
    (record) => record.manifest.originalPath === normalizedReference,
    (record) => record.manifest.originalPath.toLowerCase().endsWith(loweredReference),
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

function buildRestoreResolutionError(records: Array<{ preparedInputId: string; displayName: string }>): string {
  return `Unable to uniquely resolve the active attachment. Available options: ${records.map((record) => `${record.preparedInputId} (${record.displayName})`).join(", ")}`;
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
