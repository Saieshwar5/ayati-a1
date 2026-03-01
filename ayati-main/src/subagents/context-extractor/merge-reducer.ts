import type { LlmProvider } from "../../core/contracts/provider.js";
import type { ContextEvidenceItem } from "./types.js";

export interface MergeReducerInput {
  provider: LlmProvider;
  query: string;
  items: ContextEvidenceItem[];
  maxItems: number;
}

export interface MergeReducerOutput {
  items: ContextEvidenceItem[];
  droppedNoiseCount: number;
  insufficientEvidence: boolean;
}

interface RawMergeItem {
  sourceId: string;
  fact: string;
  quote: string;
  relevance: number;
  confidence: number;
}

interface RawMergeOutput {
  items: RawMergeItem[];
  dropped_noise_count?: number;
  insufficient_evidence?: boolean;
}

export async function reduceEvidenceItems(input: MergeReducerInput): Promise<MergeReducerOutput> {
  if (input.items.length === 0) {
    return {
      items: [],
      droppedNoiseCount: 0,
      insufficientEvidence: true,
    };
  }

  const sourceById = new Map<string, ContextEvidenceItem>();
  const evidencePayload = input.items.map((item) => {
    sourceById.set(item.sourceId, item);
    return {
      sourceId: item.sourceId,
      fact: item.fact,
      quote: item.quote,
      citation: item.citation,
      relevance: item.relevance,
      confidence: item.confidence,
    };
  });

  const prompt = [
    "You are a recursive merge reducer for document context retrieval.",
    "Given candidate evidence items, keep only query-relevant, non-duplicate, grounded items.",
    "Rules:",
    "- Never invent new facts.",
    "- Keep sourceId unchanged.",
    "- Keep only items with strong relevance to the query.",
    "- Return at most the requested number of items.",
    "Return JSON only (no markdown):",
    '{"items":[{"sourceId":"...","fact":"...","quote":"...","relevance":0.0,"confidence":0.0}],"dropped_noise_count":0,"insufficient_evidence":false}',
    `User query: ${input.query}`,
    `Max items: ${input.maxItems}`,
    `Candidate items: ${JSON.stringify(evidencePayload)}`,
  ].join("\n\n");

  const turn = await input.provider.generateTurn({
    messages: [{ role: "user", content: prompt }],
  });

  if (turn.type !== "assistant") {
    return {
      items: fallbackTopItems(input.items, input.maxItems),
      droppedNoiseCount: Math.max(0, input.items.length - input.maxItems),
      insufficientEvidence: input.items.length === 0,
    };
  }

  const parsed = safeParseJson<RawMergeOutput>(turn.content);
  if (!parsed) {
    return {
      items: fallbackTopItems(input.items, input.maxItems),
      droppedNoiseCount: Math.max(0, input.items.length - input.maxItems),
      insufficientEvidence: false,
    };
  }

  const dedup = new Set<string>();
  const reduced: ContextEvidenceItem[] = [];

  for (const row of parsed.items ?? []) {
    const source = sourceById.get(row.sourceId);
    if (!source) continue;
    const fact = row.fact?.trim();
    const quote = row.quote?.trim();
    if (!fact || !quote) continue;

    const key = `${row.sourceId}:${fact.toLowerCase()}`;
    if (dedup.has(key)) continue;
    dedup.add(key);

    reduced.push({
      fact,
      quote,
      sourceId: row.sourceId,
      citation: source.citation,
      relevance: normalizeScore(row.relevance, source.relevance),
      confidence: normalizeScore(row.confidence, source.confidence),
    });
    if (reduced.length >= input.maxItems) break;
  }

  if (reduced.length === 0) {
    return {
      items: fallbackTopItems(input.items, input.maxItems),
      droppedNoiseCount: Math.max(0, input.items.length - input.maxItems),
      insufficientEvidence: input.items.length === 0,
    };
  }

  return {
    items: reduced,
    droppedNoiseCount: Math.max(0, Number(parsed.dropped_noise_count ?? 0) || 0),
    insufficientEvidence: parsed.insufficient_evidence === true,
  };
}

function fallbackTopItems(items: ContextEvidenceItem[], maxItems: number): ContextEvidenceItem[] {
  return [...items]
    .sort((a, b) => {
      const left = a.relevance + a.confidence;
      const right = b.relevance + b.confidence;
      return right - left;
    })
    .slice(0, Math.max(1, maxItems));
}

function normalizeScore(value: unknown, fallback: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  if (numberValue < 0) return 0;
  if (numberValue > 1) return 1;
  return Number(numberValue.toFixed(3));
}

function safeParseJson<T>(text: string): T | null {
  const raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const payload = fence?.[1] ? fence[1].trim() : raw;

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
