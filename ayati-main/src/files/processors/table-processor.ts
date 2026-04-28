import { rm, writeFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import {
  buildStructuredPreviewRows,
  coerceStructuredRows,
  inferStructuredColumnTypes,
  readParsedCsv,
  type ParsedStructuredDocument,
  type ParsedStructuredRow,
  type StructuredCellValue,
} from "../../documents/csv-utils.js";
import {
  createTable,
  executeSql,
  insertRows,
  type DatabaseColumnInput,
} from "../../database/sqlite-runtime.js";
import type { ManagedFileRecord, PreparedTableData } from "../types.js";

const DEFAULT_TABLE_NAME = "file_data";

export async function prepareTableFile(input: {
  file: ManagedFileRecord;
  profilePath: string;
  dbPath: string;
  sheetName?: string;
}): Promise<PreparedTableData> {
  const parsed = input.file.kind === "csv"
    ? await readParsedCsv(input.file.storagePath)
    : readParsedXlsx(input.file.storagePath, input.sheetName);
  const inferredTypes = inferStructuredColumnTypes(parsed.rows, parsed.headers);
  const sampleRows = buildStructuredPreviewRows(parsed.rows, 10);
  const warnings = [...parsed.warnings];

  await rm(input.dbPath, { force: true });
  const createResult = createTable({
    dbPath: input.dbPath,
    table: DEFAULT_TABLE_NAME,
    columns: parsed.headers.map((column) => ({
      name: column,
      type: mapColumnType(inferredTypes[column] ?? "text"),
    } satisfies DatabaseColumnInput)),
    ifNotExists: true,
  });
  if (!createResult.ok) {
    throw new Error(createResult.error ?? "Failed to create file table.");
  }

  const resetResult = executeSql({
    dbPath: input.dbPath,
    sql: `DELETE FROM "${DEFAULT_TABLE_NAME}"`,
    mode: "execute",
  });
  if (!resetResult.ok) {
    throw new Error(resetResult.error ?? "Failed to reset file table.");
  }

  const rows = coerceStructuredRows(parsed.rows, inferredTypes);
  if (rows.length > 0) {
    const insertResult = insertRows({
      dbPath: input.dbPath,
      table: DEFAULT_TABLE_NAME,
      rows,
    });
    if (!insertResult.ok) {
      throw new Error(insertResult.error ?? "Failed to insert file table rows.");
    }
  }

  const sheetNames = "sheetNames" in parsed && Array.isArray(parsed.sheetNames) ? parsed.sheetNames : undefined;
  const prepared: PreparedTableData = {
    tableName: DEFAULT_TABLE_NAME,
    dbPath: input.dbPath,
    columns: parsed.headers,
    inferredTypes,
    rowCount: parsed.rows.length,
    sampleRows,
    ...(parsed.sheetName ? { sheetName: parsed.sheetName } : {}),
    ...(sheetNames ? { sheetNames } : {}),
    warnings,
  };
  await writeFile(input.profilePath, JSON.stringify(prepared, null, 2), "utf-8");
  return prepared;
}

function readParsedXlsx(filePath: string, requestedSheetName?: string): ParsedStructuredDocument & { sheetNames?: string[] } {
  const workbook = XLSX.readFile(filePath, {
    cellDates: true,
    dense: true,
    raw: true,
  });
  const sheetNames = workbook.SheetNames;
  if (sheetNames.length === 0) {
    return {
      headers: [],
      rows: [],
      warnings: ["Workbook did not contain any sheets."],
      sheetCount: 0,
      sheetNames: [],
    };
  }

  const sheetName = requestedSheetName && sheetNames.includes(requestedSheetName)
    ? requestedSheetName
    : sheetNames[0]!;
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return {
      headers: [],
      rows: [],
      warnings: [`Workbook sheet was missing: ${sheetName}`],
      sheetName,
      sheetCount: sheetNames.length,
      sheetNames,
    };
  }

  const rawMatrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });
  const matrix = rawMatrix.map((row) =>
    Array.isArray(row) ? row.map((value) => normalizeStructuredCell(value)) : [],
  );
  const document = buildStructuredDocument(matrix);
  const warnings = requestedSheetName && !sheetNames.includes(requestedSheetName)
    ? [`Requested sheet "${requestedSheetName}" was not found; using first sheet: ${sheetName}`]
    : sheetNames.length > 1 && !requestedSheetName
      ? [`Workbook has ${sheetNames.length} sheets; using first sheet: ${sheetName}`]
      : [];

  return {
    ...document,
    sheetName,
    sheetCount: sheetNames.length,
    sheetNames,
    warnings,
  };
}

function buildStructuredDocument(matrix: StructuredCellValue[][]): ParsedStructuredDocument {
  const headers = normalizeHeaders((matrix[0] ?? []).map((value) => normalizeHeaderValue(value)));
  const rows: ParsedStructuredRow[] = matrix.slice(1)
    .filter((row) => row.some((cell) => !isEmptyStructuredValue(cell ?? null)))
    .map((row) => ({
      raw: row,
      record: headers.reduce<Record<string, StructuredCellValue>>((acc, header, index) => {
        const value = row[index] ?? null;
        acc[header] = isEmptyStructuredValue(value) ? null : value;
        return acc;
      }, {}),
    }));

  return {
    headers,
    rows,
    warnings: [],
  };
}

function normalizeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header, index) => {
    const base = header.trim().length > 0 ? header.trim() : `column_${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

function normalizeStructuredCell(value: unknown): StructuredCellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

function normalizeHeaderValue(value: StructuredCellValue): string {
  return value === null ? "" : String(value);
}

function isEmptyStructuredValue(value: StructuredCellValue): value is null | "" {
  return value === null || (typeof value === "string" && value.trim().length === 0);
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
