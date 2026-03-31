import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildStructuredPreviewRows,
  inferStructuredColumnTypes,
  readParsedStructuredData,
} from "./csv-utils.js";
import type { PreparedAttachmentRecord } from "./prepared-attachment-registry.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "./types.js";

export async function prepareStructuredAttachment(input: {
  manifest: ManagedDocumentManifest;
  preparedInputId: string;
  runPath: string;
}): Promise<PreparedAttachmentRecord> {
  const parsed = await readParsedStructuredData(input.manifest.storedPath, assertStructuredKind(input.manifest.kind));
  const inferredTypes = inferStructuredColumnTypes(parsed.rows, parsed.headers);
  const sampleRows = buildStructuredPreviewRows(parsed.rows, 5);
  const stagingDbPath = join(input.runPath, "attachments", "staging.sqlite");
  const stagingTableName = buildStagingTableName(input.preparedInputId);
  const artifactDir = join(input.runPath, "attachments");
  const artifactPath = join(artifactDir, `${input.preparedInputId}.json`);
  const summary: PreparedAttachmentSummary = {
    preparedInputId: input.preparedInputId,
    documentId: input.manifest.documentId,
    displayName: input.manifest.displayName,
    source: input.manifest.source,
    kind: input.manifest.kind,
    mode: "structured_data",
    sizeBytes: input.manifest.sizeBytes,
    checksum: input.manifest.checksum,
    originalPath: input.manifest.originalPath,
    status: "ready",
    warnings: parsed.warnings,
    artifactPath,
    structured: {
      columns: parsed.headers,
      inferredTypes,
      rowCount: parsed.rows.length,
      sampleRowCount: sampleRows.length,
      ...(parsed.sheetName ? { sheetName: parsed.sheetName } : {}),
      ...(parsed.sheetCount !== undefined ? { sheetCount: parsed.sheetCount } : {}),
      stagingDbPath,
      stagingTableName,
      staged: false,
    },
  };

  const detail = {
    kind: "structured_data" as const,
    payload: {
      sourcePath: input.manifest.storedPath,
      columns: parsed.headers,
      inferredTypes,
      rowCount: parsed.rows.length,
      sampleRows,
      ...(parsed.sheetName ? { sheetName: parsed.sheetName } : {}),
      ...(parsed.sheetCount !== undefined ? { sheetCount: parsed.sheetCount } : {}),
      warnings: parsed.warnings,
      stagingDbPath,
      stagingTableName,
      staged: false,
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

function buildStagingTableName(preparedInputId: string): string {
  return `staging_${preparedInputId.replace(/[^a-zA-Z0-9_]+/g, "_")}`;
}

function assertStructuredKind(kind: ManagedDocumentManifest["kind"]): Extract<ManagedDocumentManifest["kind"], "csv" | "xlsx"> {
  if (kind === "csv" || kind === "xlsx") {
    return kind;
  }
  throw new Error(`Unsupported structured attachment kind: ${kind}`);
}
