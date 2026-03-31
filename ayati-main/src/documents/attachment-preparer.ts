import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentStore } from "./document-store.js";
import { resolvePreparedAttachmentMode } from "./document-routing.js";
import type { PreparedAttachmentRecord, PreparedAttachmentRegistry } from "./prepared-attachment-registry.js";
import { prepareStructuredAttachment } from "./structured-data-preparer.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "./types.js";
import { prepareUnstructuredAttachment } from "./unstructured-document-preparer.js";

export interface PrepareIncomingAttachmentsResult {
  summaries: PreparedAttachmentSummary[];
  records: PreparedAttachmentRecord[];
}

export async function prepareIncomingAttachments(input: {
  attachedDocuments: ManagedDocumentManifest[];
  runId: string;
  runPath: string;
  documentStore: DocumentStore;
  registry: PreparedAttachmentRegistry;
}): Promise<PrepareIncomingAttachmentsResult> {
  const records: PreparedAttachmentRecord[] = [];

  for (const [index, manifest] of input.attachedDocuments.entries()) {
    const preparedInputId = `att_${index + 1}_${manifest.documentId.slice(0, 8)}`;
    const mode = resolvePreparedAttachmentMode(manifest.kind);
    if (mode === "structured_data") {
      records.push(await prepareStructuredAttachment({
        manifest,
        preparedInputId,
        runPath: input.runPath,
      }));
      continue;
    }

    if (mode === "unstructured_text") {
      records.push(await prepareUnstructuredAttachment({
        manifest,
        preparedInputId,
        runPath: input.runPath,
        documentStore: input.documentStore,
      }));
      continue;
    }

    records.push(await prepareUnsupportedAttachment({
      manifest,
      preparedInputId,
      runPath: input.runPath,
    }));
  }

  input.registry.registerRunAttachments(input.runId, input.runPath, records);
  await writeAttachmentIndexArtifact(input.runPath, records.map((record) => record.summary));

  return {
    summaries: records.map((record) => record.summary),
    records,
  };
}

async function prepareUnsupportedAttachment(input: {
  manifest: ManagedDocumentManifest;
  preparedInputId: string;
  runPath: string;
}): Promise<PreparedAttachmentRecord> {
  const artifactDir = join(input.runPath, "attachments");
  const artifactPath = join(artifactDir, `${input.preparedInputId}.json`);
  const payload = {
    sourcePath: input.manifest.storedPath,
    reason: `Unsupported attachment kind for prepared input pipeline: ${input.manifest.kind}`,
  };
  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, JSON.stringify(payload, null, 2), "utf-8");

  const summary: PreparedAttachmentSummary = {
    preparedInputId: input.preparedInputId,
    documentId: input.manifest.documentId,
    displayName: input.manifest.displayName,
    source: input.manifest.source,
    kind: input.manifest.kind,
    mode: "unsupported",
    sizeBytes: input.manifest.sizeBytes,
    checksum: input.manifest.checksum,
    originalPath: input.manifest.originalPath,
    status: "unsupported",
    warnings: [payload.reason],
    artifactPath,
  };

  return {
    summary,
    manifest: input.manifest,
    runPath: input.runPath,
    detail: {
      kind: "unsupported",
      payload,
    },
  };
}

async function writeAttachmentIndexArtifact(runPath: string, summaries: PreparedAttachmentSummary[]): Promise<void> {
  const artifactDir = join(runPath, "attachments");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "index.json"), JSON.stringify({ attachments: summaries }, null, 2), "utf-8");
}
