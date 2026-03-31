import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { readParsedStructuredData } from "../../src/documents/csv-utils.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-structured-data-"));
}

function writeWorkbook(filePath: string, sheets: Array<{ name: string; rows: unknown[][] }>): void {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  }
  XLSX.writeFile(workbook, filePath);
}

describe("structured data parsing", () => {
  it("parses the first xlsx sheet and preserves workbook metadata", async () => {
    const dataDir = makeTmpDir();
    const workbookPath = join(dataDir, "employees.xlsx");
    writeWorkbook(workbookPath, [
      {
        name: "Employees",
        rows: [
          ["name", "salary", "active", "started_at"],
          ["Lila", 42000, true, new Date("2024-01-01T00:00:00.000Z")],
          ["Asha", 39000, false, new Date("2024-02-01T00:00:00.000Z")],
        ],
      },
      {
        name: "Ignored",
        rows: [["name"], ["Noor"]],
      },
    ]);

    try {
      const parsed = await readParsedStructuredData(workbookPath, "xlsx");

      expect(parsed.headers).toEqual(["name", "salary", "active", "started_at"]);
      expect(parsed.rows).toHaveLength(2);
      expect(parsed.rows[0]?.record).toEqual({
        name: "Lila",
        salary: 42000,
        active: true,
        started_at: "2024-01-01T00:00:00.000Z",
      });
      expect(parsed.sheetName).toBe("Employees");
      expect(parsed.sheetCount).toBe(2);
      expect(parsed.warnings).toEqual(["Workbook has 2 sheets; using first sheet: Employees"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
