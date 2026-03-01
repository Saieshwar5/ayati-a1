import type { LlmProvider } from "../../core/contracts/provider.js";
import { estimateTextTokens } from "../../prompt/token-estimator.js";
import type { ContextEvidenceItem, SourceChunk } from "./types.js";

export interface LeafExtractInput {
  provider: LlmProvider;
  query: string;
  chunks: SourceChunk[];
  maxItems: number;
}

export interface LeafExtractOutput {
  items: ContextEvidenceItem[];
  droppedNoiseCount: number;
  insufficientEvidence: boolean;
  inputTokens: number;
}

interface LeafRawItem {
  sourceId: string;
  fact: string;
  quote: string;
  relevance: number;
  confidence: number;
}

interface LeafRawOutput {
  items: LeafRawItem[];
  dropped_noise_count?: number;
  insufficient_evidence?: boolean;
}

export async function extractLeafEvidence(input: LeafExtractInput): Promise<LeafExtractOutput> {
  const sourceById = new Map<string, SourceChunk>();
  const sourceBlocks: string[] = [];
  let sourceTokens = 0;

  for (const chunk of input.chunks) {
    sourceById.set(chunk.sourceId, chunk);
    sourceTokens += chunk.tokens;
    sourceBlocks.push([
      `[SOURCE id=${chunk.sourceId}]`,
      `document: ${chunk.documentName}`,
      `path: ${chunk.documentPath}`,
      `location: ${chunk.location}`,
      "text:",
      chunk.text,
    ].join("\n"));
  }

  const prompt = [
    "You are a retrieval sub-agent.",
    "Extract only evidence relevant to the user query from the provided source blocks.",
    "Rules:",
    "- Do not answer the user.",
    "- Keep only grounded facts that are directly supported by the source text.",
    "- Every item must include sourceId and a direct quote copied from that source text.",
    "- Ignore irrelevant, repetitive, or noisy text.",
    `- Return at most ${input.maxItems} items.`,
    "Return JSON only (no markdown):",
    '{"items":[{"sourceId":"...","fact":"...","quote":"...","relevance":0.0,"confidence":0.0}],"dropped_noise_count":0,"insufficient_evidence":false}',
    "",
    `User query: ${input.query}`,
    "",
    sourceBlocks.join("\n\n"),
  ].join("\n");

  const turn = await input.provider.generateTurn({
    messages: [{ role: "user", content: prompt }],
  });

  if (turn.type !== "assistant") {
    return {
      items: [],
      droppedNoiseCount: 0,
      insufficientEvidence: true,
      inputTokens: sourceTokens,
    };
  }

  const parsed = safeParseJson<LeafRawOutput>(turn.content);
  if (!parsed) {
    return {
      items: [],
      droppedNoiseCount: 0,
      insufficientEvidence: true,
      inputTokens: sourceTokens,
    };
  }

  const dedup = new Set<string>();
  const items: ContextEvidenceItem[] = [];

  for (const row of parsed.items ?? []) {
    const source = sourceById.get(row.sourceId);
    if (!source) continue;

    const fact = row.fact?.trim();
    const quote = row.quote?.trim();
    if (!fact || !quote) continue;
    if (!containsQuote(source.text, quote)) continue;

    const key = `${row.sourceId}:${fact.toLowerCase()}`;
    if (dedup.has(key)) continue;
    dedup.add(key);

    items.push({
      fact,
      quote,
      sourceId: source.sourceId,
      citation: {
        documentName: source.documentName,
        documentPath: source.documentPath,
        location: source.location,
      },
      relevance: clampScore(row.relevance),
      confidence: clampScore(row.confidence),
    });
  }

  const droppedNoiseCount = Number(parsed.dropped_noise_count ?? 0);
  const insufficientEvidence = parsed.insufficient_evidence === true;

  return {
    items,
    droppedNoiseCount: Number.isFinite(droppedNoiseCount) ? Math.max(0, Math.floor(droppedNoiseCount)) : 0,
    insufficientEvidence,
    inputTokens: sourceTokens,
  };
}

function clampScore(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return Number(n.toFixed(3));
}

function containsQuote(source: string, quote: string): boolean {
  const normalizedSource = normalizeForMatch(source);
  const normalizedQuote = normalizeForMatch(quote);
  if (normalizedQuote.length === 0) return false;
  if (normalizedQuote.length < 12) {
    return normalizedSource.includes(normalizedQuote);
  }
  return normalizedSource.includes(normalizedQuote.slice(0, 80));
}

function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function safeParseJson<T>(text: string): T | null {
  const raw = text.trim();
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const payload = fenceMatch?.[1] ? fenceMatch[1].trim() : raw;

  try {
    return JSON.parse(payload) as T;
  } catch {
    const openIndex = payload.indexOf("{");
    const closeIndex = payload.lastIndexOf("}");
    if (openIndex >= 0 && closeIndex > openIndex) {
      try {
        return JSON.parse(payload.slice(openIndex, closeIndex + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function estimateChunkTokens(chunks: SourceChunk[]): number {
  return chunks.reduce((sum, chunk) => sum + estimateTextTokens(chunk.text), 0);
}
