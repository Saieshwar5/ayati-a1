import mammoth from "mammoth";
import type {
  DocumentExtractor,
  DocumentKind,
  ExtractorInput,
  ExtractorOutput,
} from "../types.js";

export class DocxExtractor implements DocumentExtractor {
  supports(kind: DocumentKind): boolean {
    return kind === "docx";
  }

  async extract(input: ExtractorInput): Promise<ExtractorOutput> {
    const result = await mammoth.extractRawText({ buffer: input.bytes });
    const text = result.value ?? "";
    const warnings = (result.messages ?? []).map((entry) => entry.message).filter((entry) => entry.trim().length > 0);

    return {
      kind: "docx",
      segments: [
        {
          id: "segment-1",
          location: "body",
          text,
        },
      ],
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}
