import type { LlmProvider } from "../core/contracts/provider.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createTable,
  executeSql,
  insertRows,
  listTables,
  type DatabaseColumnInput,
} from "../database/sqlite-runtime.js";
import type { DocumentContextBackend } from "./document-context-backend.js";
import type { DocumentStore } from "./document-store.js";
import { coerceStructuredRows, readParsedStructuredData } from "./csv-utils.js";
import type { PreparedAttachmentRecord } from "./prepared-attachment-registry.js";
import { PreparedAttachmentRegistry } from "./prepared-attachment-registry.js";
import type { PreparedAttachmentMode } from "./types.js";

export interface PreparedAttachmentServiceOptions {
  registry: PreparedAttachmentRegistry;
  documentStore: DocumentStore;
  provider: LlmProvider;
  documentContextBackend?: DocumentContextBackend;
}

export class PreparedAttachmentService {
  private readonly registry: PreparedAttachmentRegistry;
  private readonly documentStore: DocumentStore;
  private readonly provider: LlmProvider;
  private readonly documentContextBackend?: DocumentContextBackend;

  constructor(options: PreparedAttachmentServiceOptions) {
    this.registry = options.registry;
    this.documentStore = options.documentStore;
    this.provider = options.provider;
    this.documentContextBackend = options.documentContextBackend;
  }

  async profileDataset(runId: string, preparedInputId?: string): Promise<Record<string, unknown>> {
    const record = this.getStructuredRecord(runId, preparedInputId);
    return {
      preparedInputId: record.summary.preparedInputId,
      displayName: record.summary.displayName,
      rowCount: record.summary.structured?.rowCount ?? 0,
      columns: record.summary.structured?.columns ?? [],
      inferredTypes: record.summary.structured?.inferredTypes ?? {},
      sheetName: record.summary.structured?.sheetName,
      sheetCount: record.summary.structured?.sheetCount,
      sampleRows: record.detail.payload["sampleRows"] ?? [],
      stagingDbPath: record.summary.structured?.stagingDbPath,
      stagingTableName: record.summary.structured?.stagingTableName,
      staged: record.summary.structured?.staged ?? false,
      warnings: record.summary.warnings,
    };
  }

  async queryDataset(input: {
    runId: string;
    preparedInputId?: string;
    sql: string;
    maxRows?: number;
  }): Promise<Record<string, unknown>> {
    const record = await this.stageDatasetIfNeeded(input.runId, input.preparedInputId);
    const result = executeSql({
      dbPath: record.summary.structured?.stagingDbPath,
      sql: input.sql,
      mode: "query",
      maxRows: input.maxRows,
    });
    if (!result.ok || !result.data) {
      throw new Error(result.error ?? "Failed to query staged dataset.");
    }
    return {
      preparedInputId: record.summary.preparedInputId,
      tableName: record.summary.structured?.stagingTableName,
      dbPath: result.data.dbPath,
      staged: record.summary.structured?.staged ?? false,
      columns: result.data.columns ?? [],
      rows: result.data.rows ?? [],
      rowCount: result.data.rowCount ?? 0,
      truncated: result.data.truncated ?? false,
    };
  }

  async promoteDataset(input: {
    runId: string;
    preparedInputId?: string;
    targetTable: string;
    targetDbPath?: string;
    ifExists?: "fail" | "replace" | "append";
  }): Promise<Record<string, unknown>> {
    const record = this.getStructuredRecord(input.runId, input.preparedInputId);
    const parsed = await readParsedStructuredData(record.manifest.storedPath, this.assertStructuredKind(record.manifest.kind));
    const rows = coerceStructuredRows(parsed.rows, record.summary.structured?.inferredTypes ?? {});
    const dbPath = input.targetDbPath;
    const targetTable = input.targetTable.trim();
    const ifExists = input.ifExists ?? "fail";
    const existing = listTables(dbPath);
    if (!existing.ok || !existing.data) {
      throw new Error(existing.error ?? "Failed to inspect target database.");
    }
    const tableExists = existing.data.tables.some((table) => table.name === targetTable);
    if (tableExists && ifExists === "fail") {
      throw new Error(`Target table already exists: ${targetTable}`);
    }
    if (tableExists && ifExists === "replace") {
      const dropResult = executeSql({
        dbPath,
        sql: `DROP TABLE IF EXISTS "${targetTable.replace(/"/g, '""')}"`,
        mode: "execute",
      });
      if (!dropResult.ok) {
        throw new Error(dropResult.error ?? `Failed to replace existing table ${targetTable}.`);
      }
    }
    if (!tableExists || ifExists === "replace") {
      const createResult = createTable({
        dbPath,
        table: targetTable,
        columns: buildDatabaseColumns(record),
        ifNotExists: true,
      });
      if (!createResult.ok) {
        throw new Error(createResult.error ?? `Failed to create table ${targetTable}.`);
      }
    }

    const insertResult = insertRows({
      dbPath,
      table: targetTable,
      rows,
    });
    if (!insertResult.ok || !insertResult.data) {
      throw new Error(insertResult.error ?? `Failed to insert rows into ${targetTable}.`);
    }

    return {
      preparedInputId: record.summary.preparedInputId,
      targetTable,
      dbPath: insertResult.data.dbPath,
      rowsCopied: insertResult.data.insertedRowCount,
      columns: insertResult.data.columns,
      sourceDisplayName: record.summary.displayName,
    };
  }

  async listDocumentSections(runId: string, preparedInputId?: string): Promise<Record<string, unknown>> {
    const record = this.getUnstructuredRecord(runId, preparedInputId);
    const prepared = await this.documentStore.prepareDocument(record.manifest);
    return {
      preparedInputId: record.summary.preparedInputId,
      displayName: record.summary.displayName,
      sectionCount: prepared.document.segments.length,
      sections: prepared.document.segments.map((segment) => ({
        id: segment.id,
        location: segment.location,
      })),
    };
  }

  async readDocumentSections(input: {
    runId: string;
    preparedInputId?: string;
    sectionIds: string[];
  }): Promise<Record<string, unknown>> {
    const record = this.getUnstructuredRecord(input.runId, input.preparedInputId);
    const prepared = await this.documentStore.prepareDocument(record.manifest);
    const wanted = new Set(input.sectionIds);
    const sections = prepared.document.segments.filter((segment) => wanted.has(segment.id));
    return {
      preparedInputId: record.summary.preparedInputId,
      displayName: record.summary.displayName,
      sections: sections.map((segment) => ({
        id: segment.id,
        location: segment.location,
        text: segment.text,
      })),
    };
  }

  async queryDocument(input: {
    runId: string;
    preparedInputId?: string;
    query: string;
  }): Promise<Record<string, unknown>> {
    const record = this.getUnstructuredRecord(input.runId, input.preparedInputId);
    if (this.documentContextBackend) {
      const result = await this.documentContextBackend.search({
        provider: this.provider,
        query: input.query,
        attachedDocuments: [record.manifest],
        requestedDocumentPaths: [record.manifest.originalPath],
      });
      return {
        preparedInputId: record.summary.preparedInputId,
        displayName: record.summary.displayName,
        context: result.context,
        sources: result.sources,
        confidence: result.confidence,
        documentState: result.documentState,
        indexed: this.isDocumentIndexed(record),
      };
    }

    const prepared = await this.documentStore.prepareDocument(record.manifest);
    const matched = prepared.document.segments.filter((segment) => segment.text.toLowerCase().includes(input.query.toLowerCase()));
    return {
      preparedInputId: record.summary.preparedInputId,
      displayName: record.summary.displayName,
      context: matched.slice(0, 5).map((segment) => `${segment.location}: ${segment.text}`).join("\n\n"),
      sources: [record.manifest.originalPath],
      confidence: matched.length > 0 ? 0.5 : 0,
      indexed: this.isDocumentIndexed(record),
      documentState: {
        status: matched.length > 0 ? "partial" : "empty",
        insufficientEvidence: matched.length === 0,
        warnings: [],
      },
    };
  }

  private async stageDatasetIfNeeded(runId: string, preparedInputId?: string): Promise<PreparedAttachmentRecord> {
    const record = this.getStructuredRecord(runId, preparedInputId);
    const structured = record.summary.structured;
    if (!structured) {
      throw new Error(`Prepared dataset metadata is missing for ${preparedInputId}.`);
    }
    if (structured.staged) {
      return record;
    }

    const parsed = await readParsedStructuredData(record.manifest.storedPath, this.assertStructuredKind(record.manifest.kind));
    const rows = coerceStructuredRows(parsed.rows, structured.inferredTypes);
    const createResult = createTable({
      dbPath: structured.stagingDbPath,
      table: structured.stagingTableName,
      columns: buildDatabaseColumns(record),
      ifNotExists: true,
    });
    if (!createResult.ok) {
      throw new Error(createResult.error ?? `Failed to create staging table ${structured.stagingTableName}.`);
    }

    const resetResult = executeSql({
      dbPath: structured.stagingDbPath,
      sql: `DELETE FROM "${structured.stagingTableName.replace(/"/g, '""')}"`,
      mode: "execute",
    });
    if (!resetResult.ok) {
      throw new Error(resetResult.error ?? `Failed to reset staging table ${structured.stagingTableName}.`);
    }

    const insertResult = insertRows({
      dbPath: structured.stagingDbPath,
      table: structured.stagingTableName,
      rows,
    });
    if (!insertResult.ok) {
      throw new Error(insertResult.error ?? `Failed to stage dataset into ${structured.stagingTableName}.`);
    }

    record.summary = {
      ...record.summary,
      structured: {
        ...structured,
        staged: true,
      },
    };
    record.detail.payload["staged"] = true;
    return record;
  }

  private getStructuredRecord(runId: string, preparedInputId?: string): PreparedAttachmentRecord {
    return this.resolveRecord(runId, preparedInputId, "structured_data");
  }

  private getUnstructuredRecord(runId: string, preparedInputId?: string): PreparedAttachmentRecord {
    return this.resolveRecord(runId, preparedInputId, "unstructured_text");
  }

  private resolveRecord(
    runId: string,
    reference: string | undefined,
    mode: Extract<PreparedAttachmentMode, "structured_data" | "unstructured_text">,
  ): PreparedAttachmentRecord {
    const candidates = this.registry
      .getRunAttachments(runId)
      .filter((record) => record.summary.mode === mode);

    if (candidates.length === 0) {
      throw new Error(`No prepared ${mode === "structured_data" ? "structured" : "document"} attachments are available for this run.`);
    }

    const normalizedReference = reference?.trim();
    if (!normalizedReference) {
      if (candidates.length === 1) {
        return candidates[0]!;
      }
      throw new Error(this.buildResolutionError(mode, candidates));
    }

    const loweredReference = normalizedReference.toLowerCase();
    const strategies: Array<(record: PreparedAttachmentRecord) => boolean> = [
      (record) => record.summary.preparedInputId === normalizedReference,
      (record) => record.summary.preparedInputId.startsWith(normalizedReference),
      (record) => record.summary.documentId === normalizedReference,
      (record) => record.summary.documentId.startsWith(normalizedReference),
      (record) => record.summary.displayName.toLowerCase() === loweredReference,
      (record) => record.manifest.name.toLowerCase() === loweredReference,
      (record) => record.summary.originalPath === normalizedReference,
      (record) => record.summary.originalPath.toLowerCase().endsWith(loweredReference),
    ];

    for (const matcher of strategies) {
      const matches = candidates.filter(matcher);
      if (matches.length === 1) {
        return matches[0]!;
      }
      if (matches.length > 1) {
        throw new Error(this.buildResolutionError(mode, matches));
      }
    }

    if (candidates.length === 1) {
      return candidates[0]!;
    }

    throw new Error(this.buildResolutionError(mode, candidates));
  }

  private buildResolutionError(
    mode: Extract<PreparedAttachmentMode, "structured_data" | "unstructured_text">,
    candidates: PreparedAttachmentRecord[],
  ): string {
    const label = mode === "structured_data" ? "structured attachment" : "document attachment";
    const choices = candidates
      .map((record) => `${record.summary.preparedInputId} (${record.summary.displayName})`)
      .join(", ");
    return `Unable to uniquely resolve the ${label}. Available options: ${choices}`;
  }

  private isDocumentIndexed(record: PreparedAttachmentRecord): boolean {
    return existsSync(join(this.documentStore.documentsDir, record.manifest.documentId, "vector-index.json"));
  }

  private assertStructuredKind(kind: PreparedAttachmentRecord["manifest"]["kind"]): Extract<PreparedAttachmentRecord["manifest"]["kind"], "csv" | "xlsx"> {
    if (kind === "csv" || kind === "xlsx") {
      return kind;
    }
    throw new Error(`Unsupported structured attachment kind: ${kind}`);
  }
}

function buildDatabaseColumns(record: PreparedAttachmentRecord): DatabaseColumnInput[] {
  const structured = record.summary.structured;
  if (!structured) {
    throw new Error(`Structured metadata missing for ${record.summary.preparedInputId}`);
  }
  return structured.columns.map((column) => ({
    name: column,
    type: mapColumnType(structured.inferredTypes[column] ?? "text"),
  }));
}

function mapColumnType(value: string): string {
  switch (value) {
    case "integer":
      return "INTEGER";
    case "real":
      return "REAL";
    case "boolean":
      return "INTEGER";
    default:
      return "TEXT";
  }
}
