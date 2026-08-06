import { basename } from "node:path";
import type { ResourceRef, WorkstreamResourceBinding } from "ayati-context-engine";
import type { DirectoryLibrary } from "./directory-library.js";
import type { FileLibrary } from "./file-library.js";

export interface SessionAttachmentServiceOptions {
  fileLibrary: FileLibrary;
  directoryLibrary: DirectoryLibrary;
}

type RestoredWorkstreamResourceSource = {
  source: "workstream_resource";
  resourceId: string;
  restored: true;
};

export type RestoredAttachmentContext = RestoredWorkstreamResourceSource & (
  | {
    attachmentKind: "file";
    path: string;
    fileId: string;
    displayName: string;
    kind: string;
  }
  | {
    attachmentKind: "directory";
    path: string;
    directoryId: string;
    displayName: string;
    kind: "directory";
  }
);

export class SessionAttachmentService {
  private readonly fileLibrary: FileLibrary;
  private readonly directoryLibrary: DirectoryLibrary;

  constructor(options: SessionAttachmentServiceOptions) {
    this.fileLibrary = options.fileLibrary;
    this.directoryLibrary = options.directoryLibrary;
  }

  async restoreAttachmentContext(input: {
    runId: string;
    resourceId?: string;
    reference?: string;
    workstreamResources?: WorkstreamResourceBinding[];
  }): Promise<RestoredAttachmentContext> {
    if (!hasExplicitRestoreReference(input)) {
      const [files, directories] = await Promise.all([
        this.fileLibrary.listRunFiles(input.runId),
        this.directoryLibrary.listRunDirectories(input.runId),
      ]);
      if (files.length + directories.length > 0) {
        throw new Error("Current run already has attachments. Use the current attachment, or specify the earlier resource to restore.");
      }
    }

    const resource = resolveWorkstreamResource(input.workstreamResources ?? [], input);
    const path = requireResourcePath(resource);
    if (resource.kind.toLowerCase() === "directory") {
      const directory = await this.directoryLibrary.registerPath({
        path,
        name: resource.displayName,
        runId: input.runId,
      });
      return {
        source: "workstream_resource",
        resourceId: resource.resourceId,
        restored: true,
        attachmentKind: "directory",
        path: directory.rootPath,
        directoryId: directory.directoryId,
        displayName: directory.name,
        kind: "directory",
      };
    }

    const file = await this.fileLibrary.registerPath({
      path,
      name: resource.displayName,
      runId: input.runId,
      runRole: "used",
    });
    return {
      source: "workstream_resource",
      resourceId: resource.resourceId,
      restored: true,
      attachmentKind: "file",
      path: file.storagePath,
      fileId: file.fileId,
      displayName: file.originalName,
      kind: file.kind,
    };
  }
}

function hasExplicitRestoreReference(input: { resourceId?: string; reference?: string }): boolean {
  return [input.resourceId, input.reference]
    .some((value) => typeof value === "string" && value.trim().length > 0);
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
    return pickResolvedResource(
      candidates.filter((resource) => resource.resourceId === explicitResourceId),
      candidates,
    );
  }

  const normalizedReference = input.reference?.trim();
  if (!normalizedReference) {
    if (candidates.length === 1) return candidates[0]!;
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

function pickResolvedResource(matches: ResourceRef[], allCandidates: ResourceRef[]): ResourceRef {
  const unique = dedupeResources(matches);
  if (unique.length === 1) return unique[0]!;
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
  return resources.filter((resource) => {
    if (seen.has(resource.resourceId)) return false;
    seen.add(resource.resourceId);
    return true;
  });
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
