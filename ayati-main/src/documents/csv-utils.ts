import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";
import type { DocumentKind } from "./types.js";

export type StructuredCellValue = string | number | boolean | null;

export interface ParsedStructuredRow {
  raw: StructuredCellValue[];
  record: Record<string, StructuredCellValue>;
}

export interface ParsedStructuredDocument {
  headers: string[];
  rows: ParsedStructuredRow[];
  warnings: string[];
  sheetName?: string;
  sheetCount?: number;
}

export type ParsedCsvRow = ParsedStructuredRow;
export type ParsedCsvDocument = ParsedStructuredDocument;

const MAX_PREVIEW_ROWS = 25;

export async function readParsedStructuredData(
  filePath: string,
  kind: Extract<DocumentKind, "csv" | "xlsx">,
): Promise<ParsedStructuredDocument> {
  switch (kind) {
    case "csv":
      return readParsedCsv(filePath);
    case "xlsx":
      return readParsedXlsx(filePath);
  }
}

export async function readParsedCsv(filePath: string): Promise<ParsedCsvDocument> {
  const raw = await readFile(filePath, "utf-8");
  return parseCsv(raw);
}

export function parseCsv(raw: string): ParsedCsvDocument {
  const matrix = parseCsvMatrix(raw);
  return buildStructuredDocument(matrix);
}

export async function readParsedXlsx(filePath: string): Promise<ParsedStructuredDocument> {
  const workbook = XLSX.readFile(filePath, {
    cellDates: true,
    dense: true,
    raw: true,
  });
  const sheetNames = workbook.SheetNames;
  const sheetCount = sheetNames.length;
  if (sheetCount === 0) {
    return {
      headers: [],
      rows: [],
      warnings: ["Workbook did not contain any sheets."],
      sheetCount: 0,
    };
  }

  const sheetName = sheetNames[0]!;
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return {
      headers: [],
      rows: [],
      warnings: [`Workbook sheet was missing: ${sheetName}`],
      sheetName,
      sheetCount,
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
  return {
    ...document,
    sheetName,
    sheetCount,
    warnings: sheetCount > 1
      ? [`Workbook has ${sheetCount} sheets; using first sheet: ${sheetName}`]
      : [],
  };
}

export function inferStructuredColumnTypes(rows: ParsedStructuredRow[], headers: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of headers) {
    const values = rows
      .map((row) => row.record[header])
      .filter((value): value is Exclude<StructuredCellValue, null> => !isEmptyStructuredValue(value ?? null));
    result[header] = inferColumnType(values);
  }
  return result;
}

export function inferCsvColumnTypes(rows: ParsedCsvRow[], headers: string[]): Record<string, string> {
  return inferStructuredColumnTypes(rows, headers);
}

export function buildStructuredPreviewRows(
  rows: ParsedStructuredRow[],
  limit = MAX_PREVIEW_ROWS,
): Array<Record<string, StructuredCellValue>> {
  return rows.slice(0, Math.max(1, limit)).map((row) => row.record);
}

export function buildCsvPreviewRows(rows: ParsedCsvRow[], limit = MAX_PREVIEW_ROWS): Array<Record<string, StructuredCellValue>> {
  return buildStructuredPreviewRows(rows, limit);
}

export function coerceStructuredRows(
  rows: ParsedStructuredRow[],
  inferredTypes: Record<string, string>,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row.record)) {
      output[key] = coerceStructuredValue(value, inferredTypes[key] ?? "text");
    }
    return output;
  });
}

export function coerceCsvRows(
  rows: ParsedCsvRow[],
  inferredTypes: Record<string, string>,
): Array<Record<string, unknown>> {
  return coerceStructuredRows(rows, inferredTypes);
}

function buildStructuredDocument(matrix: StructuredCellValue[][]): ParsedStructuredDocument {
  const headers = normalizeHeaders((matrix[0] ?? []).map((value) => normalizeHeaderValue(value)));
  const rows = matrix.slice(1)
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

function parseCsvMatrix(raw: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let inQuotes = false;

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index] ?? "";
    const next = raw[index + 1] ?? "";

    if (char === '"') {
      if (inQuotes && next === '"') {
        currentCell += '"';
        index++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ",") {
      currentRow.push(currentCell);
      currentCell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        index++;
      }
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = "";
      continue;
    }

    currentCell += char;
  }

  currentRow.push(currentCell);
  if (currentRow.length > 1 || (currentRow[0] ?? "").length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

function inferColumnType(values: Array<Exclude<StructuredCellValue, null>>): string {
  if (values.length === 0) {
    return "text";
  }

  let allIntegers = true;
  let allNumbers = true;
  let allBooleans = true;

  for (const value of values) {
    if (!isIntegerValue(value)) {
      allIntegers = false;
    }
    if (!isNumericValue(value)) {
      allNumbers = false;
    }
    if (!isBooleanValue(value)) {
      allBooleans = false;
    }
  }

  if (allIntegers) return "integer";
  if (allNumbers) return "real";
  if (allBooleans) return "boolean";
  return "text";
}

function coerceStructuredValue(value: StructuredCellValue, inferredType: string): unknown {
  if (value === null) return null;

  switch (inferredType) {
    case "integer": {
      if (typeof value === "number" && Number.isInteger(value)) return value;
      if (typeof value === "string") {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : value;
      }
      return value;
    }
    case "real": {
      if (typeof value === "number") return value;
      if (typeof value === "string") {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : value;
      }
      return value;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (typeof value === "number") {
        if (value === 1) return true;
        if (value === 0) return false;
        return value;
      }
      if (typeof value === "string") {
        if (/^(?:true|yes|1)$/i.test(value)) return true;
        if (/^(?:false|no|0)$/i.test(value)) return false;
      }
      return value;
    }
    default:
      return value;
  }
}

function normalizeStructuredCell(value: unknown): StructuredCellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

function normalizeHeaderValue(value: StructuredCellValue): string {
  if (value === null) {
    return "";
  }
  return typeof value === "string" ? value : String(value);
}

function isEmptyStructuredValue(value: StructuredCellValue): value is null | "" {
  return value === null || (typeof value === "string" && value.trim().length === 0);
}

function isIntegerValue(value: Exclude<StructuredCellValue, null>): boolean {
  if (typeof value === "number") {
    return Number.isInteger(value);
  }
  return typeof value === "string" && /^-?\d+$/.test(value);
}

function isNumericValue(value: Exclude<StructuredCellValue, null>): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  return typeof value === "string" && /^-?(?:\d+|\d*\.\d+)$/.test(value);
}

function isBooleanValue(value: Exclude<StructuredCellValue, null>): boolean {
  if (typeof value === "boolean") {
    return true;
  }
  return typeof value === "string" && /^(?:true|false|yes|no|0|1)$/i.test(value);
}
