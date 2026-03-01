import jschardet from "jschardet";
import iconv from "iconv-lite";
import type {
  DocumentKind,
  DocumentExtractor,
  ExtractorInput,
  ExtractorOutput,
} from "../types.js";

const TEXT_KINDS = new Set<DocumentKind>(["txt", "markdown", "json", "html", "csv", "unknown"]);

export class TextExtractor implements DocumentExtractor {
  supports(kind: DocumentKind): boolean {
    return TEXT_KINDS.has(kind);
  }

  async extract(input: ExtractorInput): Promise<ExtractorOutput> {
    const decoded = decodeText(input.bytes);
    return {
      kind: inferKindFromName(input.fileName),
      segments: [
        {
          id: "segment-1",
          location: "body",
          text: decoded,
        },
      ],
    };
  }
}

function inferKindFromName(fileName: string): DocumentKind {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith(".md") || lowered.endsWith(".markdown")) return "markdown";
  if (lowered.endsWith(".json")) return "json";
  if (lowered.endsWith(".html") || lowered.endsWith(".htm")) return "html";
  if (lowered.endsWith(".csv")) return "csv";
  if (lowered.endsWith(".txt")) return "txt";
  return "unknown";
}

function decodeText(bytes: Buffer): string {
  const detection = jschardet.detect(bytes);
  const encoding = typeof detection.encoding === "string" ? detection.encoding : "utf-8";

  try {
    if (iconv.encodingExists(encoding)) {
      return iconv.decode(bytes, encoding);
    }
  } catch {
    // Fall back to UTF-8 below.
  }

  return bytes.toString("utf8");
}
