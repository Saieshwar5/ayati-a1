import { writeFile } from "node:fs/promises";
import type { ProcessedDocument } from "../../documents/types.js";
import { extractTextWithPandoc } from "../../documents/cli/pandoc-cli.js";
import { extractTextWithTika } from "../../documents/cli/tika-cli.js";
import { buildSourceChunks } from "../../subagents/context-extractor/chunk-builder.js";
import type { ManagedFileRecord, PreparedTextData } from "../types.js";
import { normalizeText, splitTextSections } from "./text-processor.js";

type DocumentExtractor = "pandoc" | "tika";

export async function prepareDocumentFile(input: {
  file: ManagedFileRecord;
  outputPath: string;
  chunksPath: string;
  maxChunkTokens: number;
}): Promise<PreparedTextData> {
  const failures: string[] = [];
  for (const extractor of selectExtractors(input.file.kind)) {
    try {
      const raw = extractor === "pandoc"
        ? await extractTextWithPandoc({ filePath: input.file.storagePath, to: "gfm" })
        : await extractTextWithTika({ filePath: input.file.storagePath });
      const normalized = normalizeText(raw);
      if (normalized.length === 0) {
        throw new Error("Extracted text was empty.");
      }

      const sections = splitTextSections(normalized, extractor === "pandoc");
      const document: ProcessedDocument = {
        id: input.file.fileId,
        name: input.file.safeName,
        path: input.file.storagePath,
        kind: input.file.kind === "pdf" || input.file.kind === "docx" || input.file.kind === "pptx" ? input.file.kind : "unknown",
        sizeBytes: input.file.sizeBytes,
        segments: sections,
        warnings: [],
      };
      const chunks = buildSourceChunks([document], input.maxChunkTokens).map((chunk, index) => ({
        id: chunk.sourceId || `chunk-${index + 1}`,
        location: chunk.location,
        text: chunk.text,
        tokens: chunk.tokens,
      }));
      const prepared: PreparedTextData = {
        extractor,
        sectionCount: sections.length,
        chunkCount: chunks.length,
        sections,
        chunks,
        warnings: [],
      };
      await Promise.all([
        writeFile(input.outputPath, JSON.stringify(prepared, null, 2), "utf-8"),
        writeFile(input.chunksPath, JSON.stringify({ chunks }, null, 2), "utf-8"),
      ]);
      return prepared;
    } catch (err) {
      failures.push(`${extractor}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`Unable to extract text from ${input.file.originalName}. ${failures.join(" | ")}`);
}

function selectExtractors(kind: ManagedFileRecord["kind"]): DocumentExtractor[] {
  switch (kind) {
    case "docx":
      return ["pandoc", "tika"];
    case "pdf":
    case "pptx":
      return ["tika"];
    default:
      return ["tika", "pandoc"];
  }
}
