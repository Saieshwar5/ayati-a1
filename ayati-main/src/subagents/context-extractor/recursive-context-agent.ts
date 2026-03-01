import type { LlmProvider } from "../../core/contracts/provider.js";
import { estimateTextTokens } from "../../prompt/token-estimator.js";
import { buildSourceChunks } from "./chunk-builder.js";
import { extractLeafEvidence } from "./leaf-extractor.js";
import { reduceEvidenceItems } from "./merge-reducer.js";
import {
  clamp,
  collectDocumentWarnings,
  dedupeEvidence,
  emptyBundle,
  partitionChunks,
  partitionEvidence,
  scoreEvidence,
} from "./helpers.js";
import type {
  ContextBundle,
  ContextEvidenceItem,
  ContextExtractorInput,
  ContextExtractorResult,
  SourceChunk,
} from "./types.js";

const DEFAULT_MODEL_CONTEXT_TOKENS = 120_000;
const DEFAULT_CONTEXT_RATIO = 0.2;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_LEAF_ITEMS = 10;
const DEFAULT_MAX_FINAL_ITEMS = 12;
const SOURCE_RATIO_WITHIN_CALL = 0.65;

interface RecursiveStats {
  depthReached: number;
  recursionCalls: number;
  llmCalls: number;
  totalInputTokens: number;
  droppedNoiseCount: number;
  insufficientEvidenceSeen: boolean;
}

export interface RecursiveContextAgentOptions {
  provider: LlmProvider;
  modelContextTokens?: number;
  contextRatio?: number;
  maxDepth?: number;
  maxLeafItems?: number;
  maxFinalItems?: number;
}

export class RecursiveContextAgent {
  private readonly provider: LlmProvider;
  private readonly modelContextTokens: number;
  private readonly contextRatio: number;
  private readonly maxDepth: number;
  private readonly maxLeafItems: number;
  private readonly maxFinalItems: number;

  constructor(options: RecursiveContextAgentOptions) {
    this.provider = options.provider;
    this.modelContextTokens = Math.max(8_000, options.modelContextTokens ?? DEFAULT_MODEL_CONTEXT_TOKENS);
    this.contextRatio = clamp(options.contextRatio ?? DEFAULT_CONTEXT_RATIO, 0.08, 0.4);
    this.maxDepth = Math.max(1, options.maxDepth ?? DEFAULT_MAX_DEPTH);
    this.maxLeafItems = Math.max(3, options.maxLeafItems ?? DEFAULT_MAX_LEAF_ITEMS);
    this.maxFinalItems = Math.max(3, options.maxFinalItems ?? DEFAULT_MAX_FINAL_ITEMS);
  }

  async extractContext(input: ContextExtractorInput): Promise<ContextExtractorResult> {
    const query = input.query.trim();
    if (query.length === 0 || input.documents.length === 0) {
      return {
        contextBundle: emptyBundle(query),
        warnings: [],
      };
    }

    const perCallInputBudget = Math.max(1_500, Math.floor(this.modelContextTokens * this.contextRatio));
    const sourceBudget = Math.max(900, Math.floor(perCallInputBudget * SOURCE_RATIO_WITHIN_CALL));
    const chunkBudget = Math.max(600, Math.floor(sourceBudget / 3));

    const chunks = buildSourceChunks(input.documents, chunkBudget);
    if (chunks.length === 0) {
      return {
        contextBundle: {
          ...emptyBundle(query),
          insufficientEvidence: true,
        },
        warnings: ["No extractable document text was available for recursive context extraction."],
      };
    }

    const stats: RecursiveStats = {
      depthReached: 0,
      recursionCalls: 0,
      llmCalls: 0,
      totalInputTokens: 0,
      droppedNoiseCount: 0,
      insufficientEvidenceSeen: false,
    };

    const recursiveOutput = await this.processChunkGroup(query, chunks, sourceBudget, 1, stats);
    const finalItems = await this.recursivelyReduceEvidence(query, recursiveOutput.items, sourceBudget, stats);

    const topItems = dedupeEvidence(finalItems)
      .sort((a, b) => scoreEvidence(b) - scoreEvidence(a))
      .slice(0, this.maxFinalItems);

    const confidence = topItems.length === 0
      ? 0
      : Number((topItems.reduce((sum, item) => sum + item.confidence, 0) / topItems.length).toFixed(3));

    const bundle: ContextBundle = {
      query,
      items: topItems,
      confidence,
      insufficientEvidence: topItems.length === 0 || stats.insufficientEvidenceSeen,
      droppedNoiseCount: stats.droppedNoiseCount,
      trace: {
        depthReached: stats.depthReached,
        recursionCalls: stats.recursionCalls,
        llmCalls: stats.llmCalls,
        totalInputTokens: stats.totalInputTokens,
      },
    };

    const warnings = collectDocumentWarnings(input.documents);
    return {
      contextBundle: bundle,
      warnings,
    };
  }

  private async processChunkGroup(
    query: string,
    chunks: SourceChunk[],
    sourceBudget: number,
    depth: number,
    stats: RecursiveStats,
  ): Promise<{
    items: ContextEvidenceItem[];
    insufficientEvidence: boolean;
  }> {
    stats.recursionCalls++;
    stats.depthReached = Math.max(stats.depthReached, depth);

    const groupTokens = chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
    const shouldLeaf = depth >= this.maxDepth || groupTokens <= sourceBudget;

    if (shouldLeaf) {
      stats.llmCalls++;
      const leaf = await extractLeafEvidence({
        provider: this.provider,
        query,
        chunks,
        maxItems: this.maxLeafItems,
      });
      stats.totalInputTokens += leaf.inputTokens;
      stats.droppedNoiseCount += leaf.droppedNoiseCount;
      stats.insufficientEvidenceSeen = stats.insufficientEvidenceSeen || leaf.insufficientEvidence;

      return {
        items: leaf.items,
        insufficientEvidence: leaf.insufficientEvidence,
      };
    }

    const groups = partitionChunks(chunks, sourceBudget);
    const childItems: ContextEvidenceItem[] = [];
    let insufficientEvidence = false;

    for (const group of groups) {
      const child = await this.processChunkGroup(query, group, sourceBudget, depth + 1, stats);
      childItems.push(...child.items);
      insufficientEvidence = insufficientEvidence || child.insufficientEvidence;
    }

    const reduced = await this.recursivelyReduceEvidence(query, childItems, sourceBudget, stats);
    return {
      items: reduced,
      insufficientEvidence,
    };
  }

  private async recursivelyReduceEvidence(
    query: string,
    items: ContextEvidenceItem[],
    sourceBudget: number,
    stats: RecursiveStats,
  ): Promise<ContextEvidenceItem[]> {
    const cleaned = dedupeEvidence(items);
    if (cleaned.length <= this.maxLeafItems) {
      return cleaned;
    }

    let current = cleaned;
    let loops = 0;
    while (current.length > this.maxLeafItems && loops < this.maxDepth + 2) {
      loops++;
      const groups = partitionEvidence(current, sourceBudget);
      const nextRound: ContextEvidenceItem[] = [];

      for (const group of groups) {
        stats.llmCalls++;
        stats.totalInputTokens += estimateTextTokens(JSON.stringify(group));

        const reduced = await reduceEvidenceItems({
          provider: this.provider,
          query,
          items: group,
          maxItems: Math.min(this.maxLeafItems, Math.max(3, Math.ceil(group.length / 2))),
        });

        stats.droppedNoiseCount += reduced.droppedNoiseCount;
        stats.insufficientEvidenceSeen = stats.insufficientEvidenceSeen || reduced.insufficientEvidence;
        nextRound.push(...reduced.items);
      }

      current = dedupeEvidence(nextRound);
      if (groups.length <= 1) {
        break;
      }
    }

    if (current.length > this.maxFinalItems) {
      stats.llmCalls++;
      stats.totalInputTokens += estimateTextTokens(JSON.stringify(current));
      const finalReduce = await reduceEvidenceItems({
        provider: this.provider,
        query,
        items: current,
        maxItems: this.maxFinalItems,
      });
      stats.droppedNoiseCount += finalReduce.droppedNoiseCount;
      stats.insufficientEvidenceSeen = stats.insufficientEvidenceSeen || finalReduce.insufficientEvidence;
      return dedupeEvidence(finalReduce.items);
    }

    return current;
  }
}
