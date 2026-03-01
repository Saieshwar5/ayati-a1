import type {
  DocumentExtractor,
  DocumentKind,
  ExtractorInput,
  ExtractorOutput,
} from "../types.js";

interface PdfTextItem {
  str?: unknown;
}

export class PdfExtractor implements DocumentExtractor {
  supports(kind: DocumentKind): boolean {
    return kind === "pdf";
  }

  async extract(input: ExtractorInput): Promise<ExtractorOutput> {
    const module = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const getDocument = (module as { getDocument: (value: unknown) => { promise: Promise<unknown> } }).getDocument;

    const loadingTask = getDocument({
      data: new Uint8Array(input.bytes),
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
    });
    const pdfDoc = await loadingTask.promise as {
      numPages: number;
      getPage: (index: number) => Promise<{ getTextContent: () => Promise<{ items: PdfTextItem[] }> }>;
    };

    const segments: ExtractorOutput["segments"] = [];
    for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
      const page = await pdfDoc.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map((item) => (typeof item.str === "string" ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (text.length > 0) {
        segments.push({
          id: `page-${pageNumber}`,
          location: `page:${pageNumber}`,
          text,
        });
      }
    }

    const warnings: string[] = [];
    if (segments.length === 0) {
      warnings.push("No extractable text found in PDF. This may be a scanned document (OCR disabled).");
    }

    return {
      kind: "pdf",
      segments,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}
