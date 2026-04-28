import { readFile, writeFile } from "node:fs/promises";
import type { ProcessedDocument } from "../../documents/types.js";
import { buildSourceChunks } from "../../subagents/context-extractor/chunk-builder.js";
import type { ManagedFileRecord, PreparedTextData, PreparedTextSection } from "../types.js";

export async function prepareTextFile(input: {
  file: ManagedFileRecord;
  outputPath: string;
  chunksPath: string;
  maxChunkTokens: number;
}): Promise<PreparedTextData> {
  const raw = await readFile(input.file.storagePath, "utf-8");
  const text = normalizeText(input.file.kind === "json" ? normalizeJson(raw) : stripHtmlIfNeeded(raw, input.file.kind));
  const sections = splitTextSections(text, input.file.kind === "markdown");
  const document: ProcessedDocument = {
    id: input.file.fileId,
    name: input.file.safeName,
    path: input.file.storagePath,
    kind: mapFileKindToDocumentKind(input.file.kind),
    sizeBytes: input.file.sizeBytes,
    segments: sections.map((section) => ({
      id: section.id,
      location: section.location,
      text: section.text,
    })),
    warnings: [],
  };
  const sourceChunks = buildSourceChunks([document], input.maxChunkTokens);
  const chunks = sourceChunks.map((chunk, index) => ({
    id: chunk.sourceId || `chunk-${index + 1}`,
    location: chunk.location,
    text: chunk.text,
    tokens: chunk.tokens,
  }));
  const prepared: PreparedTextData = {
    extractor: "direct",
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
}

export function normalizeText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitTextSections(text: string, preferMarkdownHeadings: boolean): PreparedTextSection[] {
  if (preferMarkdownHeadings) {
    const markdownSections = splitMarkdownSections(text);
    if (markdownSections.length > 0) {
      return markdownSections;
    }
  }

  return text.length > 0
    ? [{ id: "section-1", location: "body", text }]
    : [];
}

function splitMarkdownSections(text: string): PreparedTextSection[] {
  const lines = text.split("\n");
  const sections: PreparedTextSection[] = [];
  let currentHeading = "body";
  let currentLines: string[] = [];
  let index = 1;

  const flush = (): void => {
    const body = currentLines.join("\n").trim();
    if (body.length === 0) return;
    sections.push({
      id: `section-${index}`,
      location: currentHeading,
      text: body,
    });
    index++;
    currentLines = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch?.[1]) {
      flush();
      currentHeading = `section:${headingMatch[1].trim().slice(0, 120)}`;
      continue;
    }
    currentLines.push(line);
  }

  flush();
  return sections;
}

function normalizeJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function stripHtmlIfNeeded(raw: string, kind: ManagedFileRecord["kind"]): string {
  if (kind !== "html") {
    return raw;
  }
  return raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function mapFileKindToDocumentKind(kind: ManagedFileRecord["kind"]): ProcessedDocument["kind"] {
  switch (kind) {
    case "image":
    case "pdf":
    case "docx":
    case "pptx":
    case "xlsx":
    case "csv":
    case "txt":
    case "markdown":
    case "json":
    case "html":
      return kind;
    default:
      return "unknown";
  }
}
