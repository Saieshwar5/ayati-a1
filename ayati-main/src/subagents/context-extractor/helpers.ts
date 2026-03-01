import { estimateTextTokens } from "../../prompt/token-estimator.js";
import type { ProcessedDocument } from "../../documents/types.js";
import type { ContextBundle, ContextEvidenceItem, SourceChunk } from "./types.js";

export function partitionChunks(chunks: SourceChunk[], maxTokens: number): SourceChunk[][] {
  const groups: SourceChunk[][] = [];
  let current: SourceChunk[] = [];
  let currentTokens = 0;

  for (const chunk of chunks) {
    if (chunk.tokens > maxTokens) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
        currentTokens = 0;
      }
      groups.push([chunk]);
      continue;
    }

    if (currentTokens + chunk.tokens > maxTokens && current.length > 0) {
      groups.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(chunk);
    currentTokens += chunk.tokens;
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups.length > 0 ? groups : [chunks];
}

export function partitionEvidence(items: ContextEvidenceItem[], maxTokens: number): ContextEvidenceItem[][] {
  const groups: ContextEvidenceItem[][] = [];
  let current: ContextEvidenceItem[] = [];
  let currentTokens = 0;

  for (const item of items) {
    const cost = estimateTextTokens(JSON.stringify(item));
    if (cost > maxTokens) {
      if (current.length > 0) {
        groups.push(current);
        current = [];
        currentTokens = 0;
      }
      groups.push([item]);
      continue;
    }

    if (currentTokens + cost > maxTokens && current.length > 0) {
      groups.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(item);
    currentTokens += cost;
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups.length > 0 ? groups : [items];
}

export function dedupeEvidence(items: ContextEvidenceItem[]): ContextEvidenceItem[] {
  const seen = new Set<string>();
  const deduped: ContextEvidenceItem[] = [];

  for (const item of items) {
    const key = `${item.sourceId}:${item.fact.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

export function scoreEvidence(item: ContextEvidenceItem): number {
  return (item.relevance * 0.7) + (item.confidence * 0.3);
}

export function collectDocumentWarnings(documents: ProcessedDocument[]): string[] {
  const warnings: string[] = [];
  for (const document of documents) {
    for (const warning of document.warnings) {
      warnings.push(`${document.name}: ${warning}`);
    }
  }
  return warnings;
}

export function emptyBundle(query: string): ContextBundle {
  return {
    query,
    items: [],
    confidence: 0,
    insufficientEvidence: true,
    droppedNoiseCount: 0,
    trace: {
      depthReached: 0,
      recursionCalls: 0,
      llmCalls: 0,
      totalInputTokens: 0,
    },
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
