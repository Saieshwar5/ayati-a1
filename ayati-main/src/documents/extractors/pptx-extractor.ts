import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import type {
  DocumentKind,
  DocumentExtractor,
  ExtractorInput,
  ExtractorOutput,
} from "../types.js";

const SLIDE_PATH_RE = /^ppt\/slides\/slide(\d+)\.xml$/;

export class PptxExtractor implements DocumentExtractor {
  supports(kind: DocumentKind): boolean {
    return kind === "pptx";
  }

  async extract(input: ExtractorInput): Promise<ExtractorOutput> {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      trimValues: true,
    });
    const zip = await JSZip.loadAsync(input.bytes);

    const slideEntries = Object.keys(zip.files)
      .map((path) => {
        const match = path.match(SLIDE_PATH_RE);
        if (!match) return null;
        return { path, order: Number(match[1] ?? "0") };
      })
      .filter((entry): entry is { path: string; order: number } => entry !== null)
      .sort((a, b) => a.order - b.order);

    const segments: ExtractorOutput["segments"] = [];
    for (const slideEntry of slideEntries) {
      const file = zip.file(slideEntry.path);
      if (!file) continue;

      const xml = await file.async("text");
      const parsed = parser.parse(xml);
      const textParts = collectTextRuns(parsed);
      const text = textParts.join(" ").replace(/\s+/g, " ").trim();
      if (text.length === 0) continue;

      segments.push({
        id: `slide-${slideEntry.order}`,
        location: `slide:${slideEntry.order}`,
        text,
      });
    }

    return {
      kind: "pptx",
      segments,
    };
  }
}

function collectTextRuns(value: unknown): string[] {
  const out: string[] = [];
  walkXml(value, out);
  return out;
}

function walkXml(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      out.push(trimmed);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walkXml(item, out);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const row = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(row)) {
    if (key === "a:t" || key === "t") {
      walkXml(nested, out);
      continue;
    }

    walkXml(nested, out);
  }
}
