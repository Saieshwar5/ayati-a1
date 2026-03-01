import xlsx from "xlsx";
import type {
  DocumentKind,
  DocumentExtractor,
  ExtractorInput,
  ExtractorOutput,
} from "../types.js";

export class XlsxExtractor implements DocumentExtractor {
  supports(kind: DocumentKind): boolean {
    return kind === "xlsx" || kind === "csv";
  }

  async extract(input: ExtractorInput): Promise<ExtractorOutput> {
    const workbook = xlsx.read(input.bytes, { type: "buffer", dense: true });
    const segments = workbook.SheetNames.map((sheetName, index) => {
      const sheet = workbook.Sheets[sheetName];
      const csv = sheet ? xlsx.utils.sheet_to_csv(sheet, { blankrows: false }) : "";
      return {
        id: `sheet-${index + 1}`,
        location: `sheet:${sheetName}`,
        text: csv,
      };
    });

    return {
      kind: input.fileName.toLowerCase().endsWith(".csv") ? "csv" : "xlsx",
      segments,
    };
  }
}
