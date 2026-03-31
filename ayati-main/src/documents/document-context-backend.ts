import type { LlmProvider } from "../core/contracts/provider.js";
import { extractLeafEvidence } from "../subagents/context-extractor/leaf-extractor.js";
import type { SourceChunk } from "../subagents/context-extractor/types.js";
import type { ScoutResult, DocumentScoutStatus } from "../ivec/types.js";
import { devLog, devWarn } from "../shared/index.js";
import type { ManagedDocumentManifest } from "./types.js";
import { DocumentStore } from "./document-store.js";
import type { DocumentIndexer } from "./document-indexer.js";
import type { DocumentRetriever } from "./document-retriever.js";

export interface DocumentContextBackendOptions {
  store: DocumentStore;
  maxRetrievedChunks?: number;
  maxEvidenceItems?: number;
  documentIndexer?: DocumentIndexer;
  documentRetriever?: DocumentRetriever;
  largeDocumentMinChunks?: number;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "document",
  "explain",
  "for",
  "from",
  "give",
  "in",
  "is",
  "it",
  "me",
  "of",
  "on",
  "please",
  "show",
  "summarize",
  "summary",
  "tell",
  "the",
  "this",
  "to",
  "what",
  "with",
]);

export class DocumentContextBackend {
  private readonly store: DocumentStore;
  private readonly maxRetrievedChunks: number;
  private readonly maxEvidenceItems: number;
  private readonly documentIndexer?: DocumentIndexer;
  private readonly documentRetriever?: DocumentRetriever;
  private readonly largeDocumentMinChunks: number;

  constructor(options: DocumentContextBackendOptions) {
    this.store = options.store;
    this.maxRetrievedChunks = Math.max(4, options.maxRetrievedChunks ?? 8);
    this.maxEvidenceItems = Math.max(3, options.maxEvidenceItems ?? 6);
    this.documentIndexer = options.documentIndexer;
    this.documentRetriever = options.documentRetriever;
    this.largeDocumentMinChunks = Math.max(1, options.largeDocumentMinChunks ?? 40);
  }

  async search(input: {
    provider: LlmProvider;
    query: string;
    attachedDocuments: ManagedDocumentManifest[];
    requestedDocumentPaths?: string[];
  }): Promise<ScoutResult> {
    const requestedDocuments = filterDocuments(input.attachedDocuments, input.requestedDocumentPaths);
    devLog(
      `[document-search] start query="${truncate(input.query.replace(/\s+/g, " ").trim(), 140)}" attached=${input.attachedDocuments.length} requested=${requestedDocuments.length}`,
    );
    if (requestedDocuments.length === 0) {
      devLog("[document-search] no matching attached documents for query");
      return buildDocumentResult({
        context: "No attached documents matched this document query.",
        sources: [],
        confidence: 0,
        status: "empty",
        insufficientEvidence: true,
      });
    }

    let prepared;
    try {
      prepared = await this.store.prepareDocuments(requestedDocuments);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      devLog(`[document-search] preparation unavailable error=${truncate(message, 180)}`);
      return buildDocumentResult({
        context: "The attached document could not be prepared for retrieval.",
        sources: requestedDocuments.map((entry) => entry.originalPath),
        confidence: 0,
        status: "unavailable",
        insufficientEvidence: true,
        warnings: [message],
      });
    }
    const allChunks = prepared.flatMap((entry) => entry.chunks);
    devLog(
      `[document-search] prepared documents=${prepared.length} chunks=${allChunks.length} docs=${prepared.map((entry) => entry.manifest.name).join(", ")}`,
    );
    if (allChunks.length === 0) {
      devLog("[document-search] prepared documents had no chunks");
      return buildDocumentResult({
        context: "The attached document was processed, but no readable text chunks were available.",
        sources: requestedDocuments.map((entry) => entry.originalPath),
        confidence: 0,
        status: "empty",
        insufficientEvidence: true,
      });
    }

    const selection = await this.selectDocumentChunks(input.query, prepared, allChunks);
    const selectedChunks = selection.chunks;
    devLog(
      `[document-search] selected strategy=${selection.strategy} chunks=${selectedChunks.length}/${allChunks.length} tokens=${selection.queryTokens.length} sample=${selectedChunks.slice(0, 4).map((chunk) => `${chunk.documentName}@${chunk.location}`).join(" | ")}`,
    );
    if (selectedChunks.length === 0) {
      devLog("[document-search] no chunks selected for query");
      return buildDocumentResult({
        context: "No relevant document context was found for this query.",
        sources: requestedDocuments.map((entry) => entry.originalPath),
        confidence: 0,
        status: "empty",
        insufficientEvidence: true,
      });
    }

    const evidence = await extractLeafEvidence({
      provider: input.provider,
      query: input.query,
      chunks: selectedChunks,
      maxItems: this.maxEvidenceItems,
    });
    devLog(
      `[document-search] evidence items=${evidence.items.length} dropped_noise=${evidence.droppedNoiseCount} insufficient=${evidence.insufficientEvidence}`,
    );

    if (evidence.items.length > 0) {
      const averageConfidence = evidence.items.reduce((sum, item) => sum + item.confidence, 0) / evidence.items.length;
      const status = classifyDocumentEvidence({
        hasSummary: true,
        confidence: averageConfidence,
        evidenceItems: evidence.items.length,
        insufficientEvidence: evidence.insufficientEvidence,
      });
      const result = {
        context: formatEvidenceSummary(evidence.items),
        sources: [...new Set(evidence.items.map((item) => item.citation.documentPath))],
        confidence: averageConfidence,
        documentState: {
          status,
          insufficientEvidence: evidence.insufficientEvidence,
          warnings: [],
        },
      };
      devLog(
        `[document-search] returning grounded evidence status=${status} sources=${result.sources.length} confidence=${result.confidence.toFixed(3)}`,
      );
      return result;
    }

    const fallbackSummary = formatFallbackSummary(selectedChunks);
    const fallbackStatus: DocumentScoutStatus = fallbackSummary.trim().length > 0 ? "partial" : "empty";
    const result = {
      context: fallbackSummary || "No relevant grounded context was found in the attached document.",
      sources: [...new Set(selectedChunks.map((chunk) => chunk.documentPath))],
      confidence: 0.35,
      documentState: {
        status: fallbackStatus,
        insufficientEvidence: true,
        warnings: [],
      },
    };
    devLog(
      `[document-search] returning fallback summary status=${fallbackStatus} sources=${result.sources.length} confidence=${result.confidence.toFixed(3)}`,
    );
    return result;
  }

  private async selectDocumentChunks(
    query: string,
    preparedDocuments: Awaited<ReturnType<DocumentStore["prepareDocuments"]>>,
    allChunks: SourceChunk[],
  ): Promise<{
    chunks: SourceChunk[];
    strategy: "coverage:summary" | "coverage:empty-tokens" | "coverage:multi-topic" | "ranked" | "vector" | "vector+ranked";
    queryTokens: string[];
  }> {
    const lexicalSelection = selectChunksForQuery(query, allChunks, this.maxRetrievedChunks);
    const useVector = this.shouldUseVectorRetrieval(preparedDocuments, allChunks, lexicalSelection.strategy);
    if (!useVector || !this.documentIndexer || !this.documentRetriever) {
      return lexicalSelection;
    }

    try {
      await this.documentIndexer.ensureIndexed(preparedDocuments);
      const vectorResult = await this.documentRetriever.search({
        query,
        documents: preparedDocuments,
        limit: this.maxRetrievedChunks,
      });
      if (vectorResult.chunks.length === 0) {
        return lexicalSelection;
      }

      const lexicalSupplement = lexicalSelection.chunks.filter((chunk) => !vectorResult.chunks.some((candidate) => candidate.sourceId === chunk.sourceId));
      const merged = [...vectorResult.chunks];
      for (const chunk of lexicalSupplement) {
        if (merged.length >= this.maxRetrievedChunks) {
          break;
        }
        merged.push(chunk);
      }

      return {
        chunks: merged,
        strategy: merged.length > vectorResult.chunks.length ? "vector+ranked" : "vector",
        queryTokens: lexicalSelection.queryTokens,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      devWarn(`[document-search] vector retrieval failed, falling back to lexical selection: ${truncate(message, 180)}`);
      return lexicalSelection;
    }
  }

  private shouldUseVectorRetrieval(
    preparedDocuments: Awaited<ReturnType<DocumentStore["prepareDocuments"]>>,
    allChunks: SourceChunk[],
    lexicalStrategy: ReturnType<typeof selectChunksForQuery>["strategy"],
  ): boolean {
    if (!this.documentIndexer || !this.documentRetriever) {
      return false;
    }

    if (lexicalStrategy === "coverage:summary" || lexicalStrategy === "coverage:multi-topic") {
      return false;
    }

    const largestDocumentChunkCount = preparedDocuments.reduce(
      (max, document) => Math.max(max, document.chunks.length),
      0,
    );
    return allChunks.length >= this.largeDocumentMinChunks || largestDocumentChunkCount >= this.largeDocumentMinChunks;
  }
}

function buildDocumentResult(input: {
  context: string;
  sources: string[];
  confidence: number;
  status: DocumentScoutStatus;
  insufficientEvidence: boolean;
  warnings?: string[];
}): ScoutResult {
  return {
    context: input.context,
    sources: input.sources,
    confidence: input.confidence,
    documentState: {
      status: input.status,
      insufficientEvidence: input.insufficientEvidence,
      warnings: input.warnings ?? [],
    },
  };
}

function filterDocuments(
  documents: ManagedDocumentManifest[],
  requestedDocumentPaths?: string[],
): ManagedDocumentManifest[] {
  if (!requestedDocumentPaths || requestedDocumentPaths.length === 0) {
    return documents;
  }

  const requested = new Set(requestedDocumentPaths.map(normalizePath));
  return documents.filter((document) => {
    const original = normalizePath(document.originalPath);
    const stored = normalizePath(document.storedPath);
    return requested.has(original) || requested.has(stored);
  });
}

function selectChunksForQuery(
  query: string,
  chunks: SourceChunk[],
  limit: number,
): { chunks: SourceChunk[]; strategy: "coverage:summary" | "coverage:empty-tokens" | "coverage:multi-topic" | "ranked"; queryTokens: string[] } {
  const summaryReason = getBroadSummaryReason(query);
  if (summaryReason) {
    return {
      chunks: selectCoverageChunks(chunks, limit),
      strategy: summaryReason,
      queryTokens: tokenizeQuery(query),
    };
  }

  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    return {
      chunks: selectCoverageChunks(chunks, limit),
      strategy: "coverage:empty-tokens",
      queryTokens: tokens,
    };
  }

  const ranked = chunks
    .map((chunk) => ({ chunk, score: scoreChunk(tokens, query, chunk) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.chunk.tokens - b.chunk.tokens;
    })
    .slice(0, limit)
    .map((row) => row.chunk);

  return {
    chunks: ranked.length > 0 ? ranked : selectCoverageChunks(chunks, limit),
    strategy: "ranked",
    queryTokens: tokens,
  };
}

function scoreChunk(tokens: string[], query: string, chunk: SourceChunk): number {
  const haystack = `${chunk.documentName}\n${chunk.location}\n${chunk.text}`.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  let score = 0;

  if (normalizedQuery.length >= 8 && haystack.includes(normalizedQuery)) {
    score += 12;
  }

  for (const token of tokens) {
    const matches = haystack.match(new RegExp(`\\b${escapeRegex(token)}\\b`, "g"));
    if (!matches) continue;
    score += 2 + Math.min(4, matches.length);
    if (chunk.documentName.toLowerCase().includes(token)) score += 1;
    if (chunk.location.toLowerCase().includes(token)) score += 1;
  }

  return score;
}

function selectCoverageChunks(chunks: SourceChunk[], limit: number): SourceChunk[] {
  if (chunks.length <= limit) return chunks;

  const selected: SourceChunk[] = [];
  const step = (chunks.length - 1) / Math.max(1, limit - 1);
  for (let i = 0; i < limit; i++) {
    const index = Math.min(chunks.length - 1, Math.round(i * step));
    selected.push(chunks[index]!);
  }

  return [...new Map(selected.map((chunk) => [chunk.sourceId, chunk])).values()];
}

function classifyDocumentEvidence(input: {
  hasSummary: boolean;
  confidence: number;
  evidenceItems: number;
  insufficientEvidence: boolean;
}): DocumentScoutStatus {
  if (!input.hasSummary || input.evidenceItems === 0) {
    return "empty";
  }

  if (!input.insufficientEvidence && input.confidence >= 0.8) {
    return "sufficient";
  }

  return "partial";
}

function formatEvidenceSummary(
  items: Array<{
    fact: string;
    quote: string;
    citation: { documentPath: string; location: string };
  }>,
): string {
  return items
    .map((item, index) => [
      `${index + 1}. ${item.fact}`,
      `   Quote: "${truncate(item.quote, 220)}"`,
      `   Source: ${item.citation.documentPath} (${item.citation.location})`,
    ].join("\n"))
    .join("\n");
}

function formatFallbackSummary(chunks: SourceChunk[]): string {
  return chunks
    .slice(0, 3)
    .map((chunk, index) => `${index + 1}. ${truncate(chunk.text.replace(/\s+/g, " ").trim(), 220)}\n   Source: ${chunk.documentPath} (${chunk.location})`)
    .join("\n");
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function getBroadSummaryReason(query: string): "coverage:summary" | "coverage:multi-topic" | null {
  if (/(summari[sz]e|summary|overview|main points|what is this about|explain this|analyze this)/i.test(query)) {
    return "coverage:summary";
  }

  const categoryPatterns = [
    /\bskill[s]?\b/i,
    /\bqualification[s]?\b/i,
    /\beducation\b/i,
    /\bexperience\b/i,
    /\bproject[s]?\b/i,
    /\bcertificate[s]?\b/i,
    /\bcertification[s]?\b/i,
    /\blanguage[s]?\b/i,
    /\binterest[s]?\b/i,
  ];
  const matchedCategories = categoryPatterns.filter((pattern) => pattern.test(query)).length;
  if (matchedCategories >= 2) {
    return "coverage:multi-topic";
  }

  if (/\b(resume|cv|profile)\b/i.test(query) && matchedCategories >= 1) {
    return "coverage:multi-topic";
  }

  return null;
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}...`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}
