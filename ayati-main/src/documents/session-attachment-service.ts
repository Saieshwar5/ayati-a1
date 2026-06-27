import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { TaskAssetRecord } from "../context-engine/index.js";
import type { DirectoryLibrary } from "../files/directory-library.js";
import type { FileLibrary } from "../files/file-library.js";
import { resolvePreparedAttachmentMode } from "./document-routing.js";
import type { DocumentStore } from "./document-store.js";
import { PreparedAttachmentRegistry, type PreparedAttachmentRecord } from "./prepared-attachment-registry.js";
import { prepareStructuredAttachment } from "./structured-data-preparer.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "./types.js";
import { prepareUnstructuredAttachment } from "./unstructured-document-preparer.js";

export interface SessionAttachmentServiceOptions {
  preparedAttachmentRegistry: PreparedAttachmentRegistry;
  dataDir: string;
  documentStore?: DocumentStore;
  fileLibrary?: FileLibrary;
  directoryLibrary?: DirectoryLibrary;
}

type RestoredTaskAssetSource = {
  source: "task_asset";
  assetId: string;
};

export type RestoredAttachmentContext = RestoredTaskAssetSource & (
  | {
    restored: boolean;
    attachmentKind: "document" | "dataset";
    manifest: ManagedDocumentManifest;
    summary: PreparedAttachmentSummary;
  }
  | {
    restored: boolean;
    attachmentKind: "file";
    path: string;
    fileId?: string;
    displayName: string;
    kind: string;
  }
  | {
    restored: boolean;
    attachmentKind: "directory";
    path: string;
    directoryId?: string;
    displayName: string;
    kind: "directory";
  }
);

export class SessionAttachmentService {
  private readonly preparedAttachmentRegistry: PreparedAttachmentRegistry;
  private readonly dataDir: string;
  private readonly documentStore?: DocumentStore;

  constructor(options: SessionAttachmentServiceOptions) {
    this.preparedAttachmentRegistry = options.preparedAttachmentRegistry;
    this.dataDir = options.dataDir;
    this.documentStore = options.documentStore;
  }

  async restoreAttachmentContext(input: {
    runId: string;
    clientId?: string;
    sessionId?: string;
    assetId?: string;
    reference?: string;
    taskAssets?: TaskAssetRecord[];
  }): Promise<RestoredAttachmentContext> {
    const currentRunAttachments = this.preparedAttachmentRegistry.getRunAttachments(input.runId);
    if (!hasExplicitRestoreReference(input) && currentRunAttachments.length > 0) {
      throw new Error("Current run already has attachments. Use the current attachment, or specify the earlier file to restore.");
    }

    const asset = resolveTaskAsset(input.taskAssets ?? [], input);
    const normalizedKind = asset.kind.toLowerCase();
    if (normalizedKind === "directory") {
      return this.restoreDirectoryAsset(asset);
    }
    if (normalizedKind === "file") {
      return this.restoreFileAsset(asset);
    }
    return this.restorePreparedDocumentAsset(input.runId, asset, currentRunAttachments);
  }

  private restoreFileAsset(asset: TaskAssetRecord): RestoredAttachmentContext {
    const path = requireAssetPath(asset);
    return {
      source: "task_asset",
      assetId: asset.assetId,
      restored: true,
      attachmentKind: "file",
      path,
      displayName: asset.name,
      kind: asset.kind,
    };
  }

  private restoreDirectoryAsset(asset: TaskAssetRecord): RestoredAttachmentContext {
    const path = requireAssetPath(asset);
    return {
      source: "task_asset",
      assetId: asset.assetId,
      restored: true,
      attachmentKind: "directory",
      path,
      displayName: asset.name,
      kind: "directory",
    };
  }

  private async restorePreparedDocumentAsset(
    runId: string,
    asset: TaskAssetRecord,
    currentRunAttachments: PreparedAttachmentRecord[],
  ): Promise<RestoredAttachmentContext> {
    if (!this.documentStore) {
      throw new Error("Attachment restore requires DocumentStore to prepare git task document assets.");
    }

    const path = requireAssetPath(asset);
    const registered = await this.documentStore.registerAttachments([{ source: "cli", path, name: asset.name }]);
    if (registered.documents.length === 0) {
      throw new Error(registered.warnings[0] ?? `Unable to register task asset for restore: ${asset.name}`);
    }

    const manifest = registered.documents[0]!;
    const existing = currentRunAttachments.find((record) => record.summary.documentId === manifest.documentId);
    if (existing) {
      return {
        source: "task_asset",
        assetId: asset.assetId,
        restored: false,
        attachmentKind: existing.summary.mode === "structured_data" ? "dataset" : "document",
        manifest: existing.manifest,
        summary: existing.summary,
      };
    }

    const runPath = resolve(this.dataDir, "runs", runId);
    const preparedInputId = buildPreparedInputId(currentRunAttachments.length + 1, manifest.documentId);
    const record = await this.prepareSingleAttachment(manifest, preparedInputId, runPath);
    this.preparedAttachmentRegistry.upsertRunAttachment(runId, runPath, record);
    await persistRestoredAttachmentArtifacts(runPath, this.preparedAttachmentRegistry.getRunAttachments(runId));

    return {
      source: "task_asset",
      assetId: asset.assetId,
      restored: true,
      attachmentKind: record.summary.mode === "structured_data" ? "dataset" : "document",
      manifest: record.manifest,
      summary: record.summary,
    };
  }

  private async prepareSingleAttachment(
    manifest: ManagedDocumentManifest,
    preparedInputId: string,
    runPath: string,
  ): Promise<PreparedAttachmentRecord> {
    const mode = resolvePreparedAttachmentMode(manifest.kind);
    if (mode === "structured_data") {
      return prepareStructuredAttachment({ manifest, preparedInputId, runPath });
    }
    if (mode === "unstructured_text") {
      if (!this.documentStore) {
        throw new Error("DocumentStore is required to prepare text document assets.");
      }
      return prepareUnstructuredAttachment({
        manifest,
        preparedInputId,
        runPath,
        documentStore: this.documentStore,
      });
    }
    throw new Error(`Task asset is not a restorable document or dataset: ${manifest.displayName}`);
  }
}

function hasExplicitRestoreReference(input: {
  assetId?: string;
  reference?: string;
}): boolean {
  return [input.assetId, input.reference].some((value) => typeof value === "string" && value.trim().length > 0);
}

function resolveTaskAsset(
  assets: TaskAssetRecord[],
  input: { assetId?: string; reference?: string },
): TaskAssetRecord {
  const candidates = assets.filter(isRestorableTaskAsset);
  if (candidates.length === 0) {
    throw new Error("No git task assets are available for attachment restore.");
  }

  const explicitAssetId = input.assetId?.trim();
  if (explicitAssetId) {
    return pickResolvedTaskAsset(candidates.filter((asset) => asset.assetId === explicitAssetId), candidates);
  }

  const normalizedReference = input.reference?.trim();
  if (!normalizedReference) {
    if (candidates.length === 1) {
      return candidates[0]!;
    }
    throw new Error(buildRestoreResolutionError(candidates));
  }

  const loweredReference = normalizedReference.toLowerCase();
  const matches = candidates.filter((asset) => {
    const path = asset.path?.trim();
    const labels = [
      asset.assetId,
      asset.sessionAssetId,
      asset.name,
      path,
      path ? basename(path) : undefined,
    ].filter((value): value is string => Boolean(value && value.trim().length > 0));
    return labels.some((label) => {
      const lowered = label.toLowerCase();
      return label === normalizedReference
        || lowered === loweredReference
        || lowered.endsWith(loweredReference);
    });
  });

  return pickResolvedTaskAsset(matches, candidates);
}

function pickResolvedTaskAsset(
  matches: TaskAssetRecord[],
  allCandidates: TaskAssetRecord[],
): TaskAssetRecord {
  const unique = dedupeTaskAssets(matches);
  if (unique.length === 1) {
    return unique[0]!;
  }
  throw new Error(buildRestoreResolutionError(unique.length > 0 ? unique : allCandidates));
}

function buildRestoreResolutionError(candidates: TaskAssetRecord[]): string {
  return `Unable to uniquely resolve the git task asset. Available options: ${candidates.map(candidateReferenceLabel).join(", ")}`;
}

function candidateReferenceLabel(asset: TaskAssetRecord): string {
  return `${asset.assetId} (${asset.name}${asset.path ? ` at ${asset.path}` : ""})`;
}

function dedupeTaskAssets(assets: TaskAssetRecord[]): TaskAssetRecord[] {
  const seen = new Set<string>();
  const output: TaskAssetRecord[] = [];
  for (const asset of assets) {
    if (seen.has(asset.assetId)) {
      continue;
    }
    seen.add(asset.assetId);
    output.push(asset);
  }
  return output;
}

function isRestorableTaskAsset(asset: TaskAssetRecord): boolean {
  const kind = asset.kind.toLowerCase();
  return ["document", "dataset", "file", "directory"].includes(kind)
    && typeof asset.path === "string"
    && asset.path.trim().length > 0;
}

function requireAssetPath(asset: TaskAssetRecord): string {
  const path = asset.path?.trim();
  if (!path) {
    throw new Error(`Git task asset is missing a restorable path: ${asset.name}`);
  }
  return path;
}

function buildPreparedInputId(index: number, documentId: string): string {
  return `att_${index}_${documentId.slice(0, 8)}`;
}

async function persistRestoredAttachmentArtifacts(runPath: string, records: PreparedAttachmentRecord[]): Promise<void> {
  const attachmentsDir = join(runPath, "attachments");
  await mkdir(attachmentsDir, { recursive: true });
  for (const record of records) {
    await writeFile(record.summary.artifactPath, JSON.stringify(record.detail.payload, null, 2), "utf-8");
  }
  await writeFile(join(attachmentsDir, "index.json"), JSON.stringify({ attachments: records.map((record) => record.summary) }, null, 2), "utf-8");
}
