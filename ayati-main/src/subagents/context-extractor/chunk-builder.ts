import { estimateTextTokens } from "../../prompt/token-estimator.js";
import type { ProcessedDocument } from "../../documents/types.js";
import type { SourceChunk } from "./types.js";

const MIN_CHUNK_TOKENS = 400;

export function buildSourceChunks(documents: ProcessedDocument[], maxChunkTokens: number): SourceChunk[] {
  const safeChunkTokens = Math.max(MIN_CHUNK_TOKENS, maxChunkTokens);
  const chunks: SourceChunk[] = [];

  for (const document of documents) {
    for (const segment of document.segments) {
      const segmentChunks = splitSegment(document, segment.id, segment.location, segment.text, safeChunkTokens);
      chunks.push(...segmentChunks);
    }
  }

  return chunks;
}

function splitSegment(
  document: ProcessedDocument,
  segmentId: string,
  location: string,
  text: string,
  maxChunkTokens: number,
): SourceChunk[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (paragraphs.length === 0) {
    return [];
  }

  const chunks: SourceChunk[] = [];
  let currentParts: string[] = [];
  let currentTokens = 0;
  let chunkIndex = 1;

  const flush = (): void => {
    if (currentParts.length === 0) return;
    const joined = currentParts.join("\n\n").trim();
    if (joined.length === 0) return;
    const sourceId = `${document.id}:${segmentId}:chunk-${chunkIndex}`;
    chunks.push({
      sourceId,
      documentId: document.id,
      documentName: document.name,
      documentPath: document.path,
      location,
      text: joined,
      tokens: estimateTextTokens(joined),
    });
    chunkIndex++;
    currentParts = [];
    currentTokens = 0;
  };

  for (const paragraph of paragraphs) {
    const paragraphTokens = estimateTextTokens(paragraph);
    if (paragraphTokens > maxChunkTokens) {
      flush();
      const slices = splitLongParagraph(paragraph, maxChunkTokens);
      for (const slice of slices) {
        const sourceId = `${document.id}:${segmentId}:chunk-${chunkIndex}`;
        chunks.push({
          sourceId,
          documentId: document.id,
          documentName: document.name,
          documentPath: document.path,
          location,
          text: slice,
          tokens: estimateTextTokens(slice),
        });
        chunkIndex++;
      }
      continue;
    }

    if (currentTokens + paragraphTokens > maxChunkTokens && currentParts.length > 0) {
      flush();
    }

    currentParts.push(paragraph);
    currentTokens += paragraphTokens;
  }

  flush();
  return chunks;
}

function splitLongParagraph(text: string, maxChunkTokens: number): string[] {
  const words = text.split(/\s+/).filter((entry) => entry.length > 0);
  const slices: string[] = [];
  let currentWords: string[] = [];
  let currentTokens = 0;

  for (const word of words) {
    const tokenCost = estimateTextTokens(word) + 1;
    if (currentTokens + tokenCost > maxChunkTokens && currentWords.length > 0) {
      slices.push(currentWords.join(" "));
      currentWords = [word];
      currentTokens = tokenCost;
      continue;
    }

    currentWords.push(word);
    currentTokens += tokenCost;
  }

  if (currentWords.length > 0) {
    slices.push(currentWords.join(" "));
  }

  return slices;
}
