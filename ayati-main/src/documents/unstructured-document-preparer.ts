import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentStore } from "./document-store.js";
import type { PreparedAttachmentRecord } from "./prepared-attachment-registry.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "./types.js";

export async function prepareUnstructuredAttachment(input: {
  manifest: ManagedDocumentManifest;
  preparedInputId: string;
  runPath: string;
  documentStore: DocumentStore;
}): Promise<PreparedAttachmentRecord> {
  const prepared = await input.documentStore.prepareDocument(input.manifest);
  const artifactDir = join(input.runPath, "attachments");
  const artifactPath = join(artifactDir, `${input.preparedInputId}.json`);
  const sectionHints = prepared.document.segments.slice(0, 8).map((segment) => segment.location);
  const indexed = existsSync(join(input.documentStore.documentsDir, input.manifest.documentId, "vector-index.json"));
  const summary: PreparedAttachmentSummary = {
    preparedInputId: input.preparedInputId,
    documentId: input.manifest.documentId,
    displayName: input.manifest.displayName,
    source: input.manifest.source,
    kind: input.manifest.kind,
    mode: "unstructured_text",
    sizeBytes: input.manifest.sizeBytes,
    checksum: input.manifest.checksum,
    originalPath: input.manifest.originalPath,
    status: "ready",
    warnings: [...prepared.document.warnings],
    artifactPath,
    unstructured: {
      extractorUsed: prepared.extractorUsed,
      sectionCount: prepared.document.segments.length,
      chunkCount: prepared.chunks.length,
      sectionHints,
      indexed,
    },
  };

  const detail = {
    kind: "unstructured_text" as const,
    payload: {
      sourcePath: input.manifest.storedPath,
      extractorUsed: prepared.extractorUsed,
      sectionCount: prepared.document.segments.length,
      chunkCount: prepared.chunks.length,
      sectionHints,
      sections: prepared.document.segments.map((segment) => ({
        id: segment.id,
        location: segment.location,
      })),
      indexed,
    },
  };

  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, JSON.stringify(detail.payload, null, 2), "utf-8");

  return {
    summary,
    manifest: input.manifest,
    runPath: input.runPath,
    detail,
  };
}
