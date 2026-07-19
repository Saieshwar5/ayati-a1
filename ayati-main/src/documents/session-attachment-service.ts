import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ResourceRef, WorkstreamResourceBinding } from "ayati-git-context";
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

type RestoredWorkstreamResourceSource = {
  source: "workstream_resource";
  resourceId: string;
};

export type RestoredAttachmentContext = RestoredWorkstreamResourceSource & (
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
    resourceId?: string;
    reference?: string;
    workstreamResources?: WorkstreamResourceBinding[];
  }): Promise<RestoredAttachmentContext> {
    const currentRunAttachments = this.preparedAttachmentRegistry.getRunAttachments(input.runId);
    if (!hasExplicitRestoreReference(input) && currentRunAttachments.length > 0) {
      throw new Error("Current run already has attachments. Use the current attachment, or specify the earlier file to restore.");
    }

    const resource = resolveWorkstreamResource(input.workstreamResources ?? [], input);
    const normalizedKind = resource.kind.toLowerCase();
    if (normalizedKind === "directory") {
      return this.restoreDirectoryResource(resource);
    }
    if (normalizedKind === "file") {
      return this.restoreFileResource(resource);
    }
    return this.restorePreparedDocumentResource(input.runId, resource, currentRunAttachments);
  }

  private restoreFileResource(resource: ResourceRef): RestoredAttachmentContext {
    const path = requireResourcePath(resource);
    return {
      source: "workstream_resource",
      resourceId: resource.resourceId,
      restored: true,
      attachmentKind: "file",
      path,
      displayName: resource.displayName,
      kind: resource.kind,
    };
  }

  private restoreDirectoryResource(resource: ResourceRef): RestoredAttachmentContext {
    const path = requireResourcePath(resource);
    return {
      source: "workstream_resource",
      resourceId: resource.resourceId,
      restored: true,
      attachmentKind: "directory",
      path,
      displayName: resource.displayName,
      kind: "directory",
    };
  }

  private async restorePreparedDocumentResource(
    runId: string,
    resource: ResourceRef,
    currentRunAttachments: PreparedAttachmentRecord[],
  ): Promise<RestoredAttachmentContext> {
    if (!this.documentStore) {
      throw new Error("Attachment restore requires DocumentStore to prepare workstream document resources.");
    }

    const path = requireResourcePath(resource);
    const registered = await this.documentStore.registerAttachments([{ source: "cli", path, name: resource.displayName }]);
    if (registered.documents.length === 0) {
      throw new Error(registered.warnings[0] ?? `Unable to register workstream resource for restore: ${resource.displayName}`);
    }

    const manifest = registered.documents[0]!;
    const existing = currentRunAttachments.find((record) => record.summary.documentId === manifest.documentId);
    if (existing) {
      return {
        source: "workstream_resource",
        resourceId: resource.resourceId,
        restored: false,
        attachmentKind: existing.summary.mode === "structured_data" ? "dataset" : "document",
        manifest: existing.manifest,
        summary: existing.summary,
      };
    }

    const artifactRoot = resolve(this.dataDir, "prepared-attachments", sanitizeFileName(runId));
    const preparedInputId = buildPreparedInputId(currentRunAttachments.length + 1, manifest.documentId);
    const record = await this.prepareSingleAttachment(manifest, preparedInputId, artifactRoot);
    this.preparedAttachmentRegistry.upsertRunAttachment(runId, artifactRoot, record);
    await persistRestoredAttachmentArtifacts(artifactRoot, this.preparedAttachmentRegistry.getRunAttachments(runId));

    return {
      source: "workstream_resource",
      resourceId: resource.resourceId,
      restored: true,
      attachmentKind: record.summary.mode === "structured_data" ? "dataset" : "document",
      manifest: record.manifest,
      summary: record.summary,
    };
  }

  private async prepareSingleAttachment(
    manifest: ManagedDocumentManifest,
    preparedInputId: string,
    artifactRoot: string,
  ): Promise<PreparedAttachmentRecord> {
    const mode = resolvePreparedAttachmentMode(manifest.kind);
    if (mode === "structured_data") {
      return prepareStructuredAttachment({ manifest, preparedInputId, artifactRoot });
    }
    if (mode === "unstructured_text") {
      if (!this.documentStore) {
        throw new Error("DocumentStore is required to prepare text document assets.");
      }
      return prepareUnstructuredAttachment({
        manifest,
        preparedInputId,
        artifactRoot,
        documentStore: this.documentStore,
      });
    }
    throw new Error(`Workstream resource is not a restorable document or dataset: ${manifest.displayName}`);
  }
}

function hasExplicitRestoreReference(input: {
  resourceId?: string;
  reference?: string;
}): boolean {
  return [input.resourceId, input.reference].some((value) => typeof value === "string" && value.trim().length > 0);
}

function resolveWorkstreamResource(
  bindings: WorkstreamResourceBinding[],
  input: { resourceId?: string; reference?: string },
): ResourceRef {
  const candidates = bindings.map((binding) => binding.resource).filter(isRestorableResource);
  if (candidates.length === 0) {
    throw new Error("No workstream resources are available for attachment restore.");
  }

  const explicitResourceId = input.resourceId?.trim();
  if (explicitResourceId) {
    return pickResolvedResource(candidates.filter((resource) => resource.resourceId === explicitResourceId), candidates);
  }

  const normalizedReference = input.reference?.trim();
  if (!normalizedReference) {
    if (candidates.length === 1) {
      return candidates[0]!;
    }
    throw new Error(buildRestoreResolutionError(candidates));
  }

  const loweredReference = normalizedReference.toLowerCase();
  const matches = candidates.filter((resource) => {
    const path = resource.locator.kind === "filesystem" ? resource.locator.path.trim() : undefined;
    const labels = [
      resource.resourceId,
      resource.displayName,
      ...resource.aliases,
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

  return pickResolvedResource(matches, candidates);
}

function pickResolvedResource(
  matches: ResourceRef[],
  allCandidates: ResourceRef[],
): ResourceRef {
  const unique = dedupeResources(matches);
  if (unique.length === 1) {
    return unique[0]!;
  }
  throw new Error(buildRestoreResolutionError(unique.length > 0 ? unique : allCandidates));
}

function buildRestoreResolutionError(candidates: ResourceRef[]): string {
  return `Unable to uniquely resolve the workstream resource. Available options: ${candidates.map(candidateReferenceLabel).join(", ")}`;
}

function candidateReferenceLabel(resource: ResourceRef): string {
  const path = resource.locator.kind === "filesystem" ? resource.locator.path : undefined;
  return `${resource.resourceId} (${resource.displayName}${path ? ` at ${path}` : ""})`;
}

function dedupeResources(resources: ResourceRef[]): ResourceRef[] {
  const seen = new Set<string>();
  const output: ResourceRef[] = [];
  for (const resource of resources) {
    if (seen.has(resource.resourceId)) {
      continue;
    }
    seen.add(resource.resourceId);
    output.push(resource);
  }
  return output;
}

function isRestorableResource(resource: ResourceRef): boolean {
  const kind = resource.kind.toLowerCase();
  return ["document", "dataset", "file", "directory"].includes(kind)
    && resource.locator.kind === "filesystem"
    && resource.locator.path.trim().length > 0;
}

function requireResourcePath(resource: ResourceRef): string {
  if (resource.locator.kind !== "filesystem" || !resource.locator.path.trim()) {
    throw new Error(`Workstream resource is missing a restorable filesystem path: ${resource.displayName}`);
  }
  return resource.locator.path.trim();
}

function buildPreparedInputId(index: number, documentId: string): string {
  return `att_${index}_${documentId.slice(0, 8)}`;
}

async function persistRestoredAttachmentArtifacts(artifactRoot: string, records: PreparedAttachmentRecord[]): Promise<void> {
  await mkdir(artifactRoot, { recursive: true });
  for (const record of records) {
    await writeFile(record.summary.artifactPath, JSON.stringify(record.detail.payload, null, 2), "utf-8");
  }
  await writeFile(join(artifactRoot, "index.json"), JSON.stringify({ attachments: records.map((record) => record.summary) }, null, 2), "utf-8");
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "run";
}
