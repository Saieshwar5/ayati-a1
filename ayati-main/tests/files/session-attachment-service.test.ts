import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkstreamResourceBinding } from "ayati-context-engine";
import { afterEach, describe, expect, it } from "vitest";
import { DirectoryLibrary } from "../../src/files/directory-library.js";
import { FileLibrary } from "../../src/files/file-library.js";
import { SessionAttachmentService } from "../../src/files/session-attachment-service.js";

const NOW = "2026-08-06T10:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("SessionAttachmentService", () => {
  it("restores a workstream file into the current run with a managed file id", async () => {
    const root = createTemporaryDirectory();
    const sourcePath = join(root, "notes.txt");
    writeFileSync(sourcePath, "durable workstream notes", "utf-8");
    const { fileLibrary, service } = createService(root);

    const restored = await service.restoreAttachmentContext({
      runId: "RUN-file",
      resourceId: "RES-file",
      workstreamResources: [resourceBinding("RES-file", "file", sourcePath)],
    });

    expect(restored).toMatchObject({
      attachmentKind: "file",
      resourceId: "RES-file",
      restored: true,
      displayName: "notes.txt",
    });
    expect(restored.attachmentKind === "file" ? restored.fileId : undefined).toMatch(/^file_/);
    await expect(fileLibrary.listRunFiles("RUN-file")).resolves.toHaveLength(1);
  });

  it("restores a workstream directory into the current run with a managed directory id", async () => {
    const root = createTemporaryDirectory();
    const sourcePath = join(root, "research");
    mkdirSync(sourcePath);
    writeFileSync(join(sourcePath, "findings.md"), "verified findings", "utf-8");
    const { directoryLibrary, service } = createService(root);

    const restored = await service.restoreAttachmentContext({
      runId: "RUN-directory",
      reference: "research",
      workstreamResources: [resourceBinding("RES-directory", "directory", sourcePath)],
    });

    expect(restored).toMatchObject({
      attachmentKind: "directory",
      resourceId: "RES-directory",
      restored: true,
      displayName: "research",
      kind: "directory",
    });
    expect(restored.attachmentKind === "directory" ? restored.directoryId : undefined).toMatch(/^dir_/);
    await expect(directoryLibrary.listRunDirectories("RUN-directory")).resolves.toHaveLength(1);
  });
});

function createTemporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "ayati-session-attachment-"));
  temporaryDirectories.push(path);
  return path;
}

function createService(root: string): {
  fileLibrary: FileLibrary;
  directoryLibrary: DirectoryLibrary;
  service: SessionAttachmentService;
} {
  const dataDir = join(root, "data");
  const fileLibrary = new FileLibrary({ dataDir, now: () => new Date(NOW) });
  const directoryLibrary = new DirectoryLibrary({ dataDir, now: () => new Date(NOW) });
  return {
    fileLibrary,
    directoryLibrary,
    service: new SessionAttachmentService({ fileLibrary, directoryLibrary }),
  };
}

function resourceBinding(
  resourceId: string,
  kind: "file" | "directory",
  path: string,
): WorkstreamResourceBinding {
  const displayName = kind === "directory" ? "research" : "notes.txt";
  return {
    resource: {
      resourceId,
      kind,
      origin: "agent_created",
      displayName,
      description: `Restorable ${kind}.`,
      aliases: [displayName],
      locator: { kind: "filesystem", path },
      version: {
        key: `${kind}:test`,
        observedAt: NOW,
        exists: true,
        kind,
      },
      availability: "available",
      metadataStatus: "enriched",
      createdAt: NOW,
      updatedAt: NOW,
    },
    role: "primary",
    access: "read",
    primary: true,
    requestIds: ["REQ-1"],
    boundAt: NOW,
  };
}
