import type { LlmMessage } from "../core/contracts/llm-protocol.js";
import type { LlmProvider } from "../core/contracts/provider.js";
import type {
  ConversationTurn,
  PromptMemoryContext,
  RecalledContextEvidence,
  SessionMemory,
  SessionSummarySearchHit,
} from "../memory/types.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import { devWarn } from "../shared/index.js";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "we",
  "were",
  "with",
  "you",
  "your",
]);

const HISTORY_QUERY_PATTERN =
  /\b(previous|earlier|before|last time|last session|prior|past conversation|past interaction|we discussed|we talked|as discussed|from our chat|remember)\b/i;
const REFERENTIAL_PATTERN =
  /\b(it|that|those|same|again|continue|resume|follow up|follow-up)\b/i;

export interface ContextRecallLimits {
  maxMatchedSessions: number;
  recursionDepth: number;
  maxTurnsPerSession: number;
  evidenceTokenBudget: number;
  totalRecallMs: number;
  maxEvidenceItems: number;
  maxModelCalls: number;
  maxChunkSelections: number;
  maxChunkBranches: number;
  maxLeafTurns: number;
  maxEvidencePerLeaf: number;
  decisionContextTurns: number;
}

export interface ContextRecallOptions {
  enabled?: boolean;
  limits?: Partial<ContextRecallLimits>;
  now?: () => number;
}

export interface ContextRecallInvocationOptions {
  invocationMode?: "auto" | "explicit";
  searchQuery?: string;
}

export interface ContextRecallResult {
  status: "skipped" | "not_found" | "found" | "partial";
  reason: string;
  evidence: RecalledContextEvidence[];
  searchedSessionIds: string[];
  elapsedMs: number;
  modelCalls: number;
  triggerReason?: string;
}

interface IndexedTurn {
  index: number;
  turn: ConversationTurn;
}

interface RecallDecisionPayload {
  needs_recall?: boolean;
  reason?: string;
  search_query?: string;
}

interface ChunkSelectionItem {
  id?: string;
  reason?: string;
  confidence?: number;
}

interface ChunkSelectionPayload {
  selected?: ChunkSelectionItem[];
}

interface LeafEvidenceItem {
  turn_ref?: string;
  snippet?: string;
  why_relevant?: string;
  confidence?: number;
}

interface LeafEvidencePayload {
  evidence?: LeafEvidenceItem[];
}

interface RerankPayload {
  selected_keys?: string[];
}

interface ChunkCandidate {
  id: string;
  turns: IndexedTurn[];
  summary: string;
}

interface RecallRuntimeState {
  startedAt: number;
  remainingTokens: number;
  modelCalls: number;
  truncated: boolean;
  triggerReason?: string;
}

interface RecallDecision {
  needsRecall: boolean;
  reason: string;
  searchQuery: string;
}

interface ChunkSelection {
  id: string;
  reason: string;
  confidence: number;
}

const DEFAULT_LIMITS: ContextRecallLimits = {
  maxMatchedSessions: 4,
  recursionDepth: 4,
  maxTurnsPerSession: 10_000,
  evidenceTokenBudget: 2_500,
  totalRecallMs: 2_500,
  maxEvidenceItems: 12,
  maxModelCalls: 14,
  maxChunkSelections: 2,
  maxChunkBranches: 4,
  maxLeafTurns: 28,
  maxEvidencePerLeaf: 3,
  decisionContextTurns: 6,
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toKeywords(text: string): string[] {
  const unique = new Set<string>();
  for (const raw of normalize(text).split(" ")) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    unique.add(raw);
  }
  return [...unique];
}

function compactSnippet(text: string, maxChars = 320): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxChars - 3))}...`;
}

function clampConfidence(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function parseJson<T>(text: string): T | null {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

export class ContextRecallService {
  private readonly enabled: boolean;
  private readonly limits: ContextRecallLimits;
  private readonly now: () => number;

  constructor(
    private readonly sessionMemory: SessionMemory,
    private readonly provider?: LlmProvider,
    options?: ContextRecallOptions,
  ) {
    this.enabled = options?.enabled ?? true;
    this.limits = {
      ...DEFAULT_LIMITS,
      ...(options?.limits ?? {}),
    };
    this.now = options?.now ?? (() => Date.now());
  }

  shouldTrigger(query: string, memoryContext: PromptMemoryContext): boolean {
    if (!this.enabled) return false;

    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) return false;
    if (HISTORY_QUERY_PATTERN.test(trimmedQuery)) return true;

    if (
      memoryContext.conversationTurns.length <= 2 &&
      trimmedQuery.length <= 220 &&
      REFERENTIAL_PATTERN.test(trimmedQuery)
    ) {
      return true;
    }

    return false;
  }

  async recall(
    query: string,
    memoryContext: PromptMemoryContext,
    activeSessionId?: string,
    options?: ContextRecallInvocationOptions,
  ): Promise<ContextRecallResult> {
    const startedAt = this.now();
    const invocationMode = options?.invocationMode ?? "auto";
    const state: RecallRuntimeState = {
      startedAt,
      remainingTokens: this.limits.evidenceTokenBudget,
      modelCalls: 0,
      truncated: false,
    };

    if (!this.enabled) {
      return {
        status: "skipped",
        reason: "Context recall is disabled",
        evidence: [],
        searchedSessionIds: [],
        elapsedMs: 0,
        modelCalls: 0,
      };
    }

    if (invocationMode === "auto" && !this.shouldTrigger(query, memoryContext)) {
      return {
        status: "skipped",
        reason: "Recall trigger conditions not met",
        evidence: [],
        searchedSessionIds: [],
        elapsedMs: 0,
        modelCalls: 0,
      };
    }

    if (!this.provider) {
      return {
        status: "skipped",
        reason: "Context recall agent unavailable: no LLM provider",
        evidence: [],
        searchedSessionIds: [],
        elapsedMs: 0,
        modelCalls: 0,
      };
    }

    try {
      const decision =
        invocationMode === "explicit"
          ? this.explicitDecision(query, options?.searchQuery)
          : await this.decideRecall(query, memoryContext, state);
      state.triggerReason = decision.reason;
      if (!decision.needsRecall) {
        return {
          status: "skipped",
          reason: decision.reason,
          evidence: [],
          searchedSessionIds: [],
          elapsedMs: this.now() - startedAt,
          modelCalls: state.modelCalls,
          triggerReason: decision.reason,
        };
      }

      const candidates = this.sessionMemory
        .searchSessionSummaries(decision.searchQuery, this.limits.maxMatchedSessions + 2)
        .filter((hit) => hit.sessionId !== activeSessionId)
        .slice(0, this.limits.maxMatchedSessions);

      if (candidates.length === 0) {
        return {
          status: "not_found",
          reason: "No relevant historical sessions matched",
          evidence: [],
          searchedSessionIds: [],
          elapsedMs: this.now() - startedAt,
          modelCalls: state.modelCalls,
          triggerReason: decision.reason,
        };
      }

      const queryTerms = toKeywords(query);
      const evidence: RecalledContextEvidence[] = [];
      const searchedSessionIds: string[] = [];

      for (const hit of candidates) {
        if (this.isDeadlineExceeded(startedAt)) {
          state.truncated = true;
          break;
        }

        searchedSessionIds.push(hit.sessionId);
        const allTurns = this.sessionMemory.loadSessionTurns(hit.sessionId);
        if (allTurns.length === 0) continue;

        const turns = this.applyTurnLimit(allTurns, state);
        const indexedTurns = turns.map((turn, index) => ({ turn, index }));
        const sessionEvidence = await this.extractSessionEvidence(
          query,
          queryTerms,
          hit,
          indexedTurns,
          this.limits.recursionDepth,
          state,
        );

        for (const item of sessionEvidence) {
          const cost = this.estimateEvidenceCost(item);
          if (cost > state.remainingTokens) {
            state.truncated = true;
            continue;
          }

          evidence.push(item);
          state.remainingTokens -= cost;
          if (
            state.remainingTokens <= 0 ||
            evidence.length >= this.limits.maxEvidenceItems
          ) {
            state.truncated = true;
            break;
          }
        }

        if (state.remainingTokens <= 0 || evidence.length >= this.limits.maxEvidenceItems) {
          break;
        }
      }

      let deduped = this.dedupeEvidence(evidence);
      if (deduped.length > 1) {
        deduped = await this.rerankEvidence(query, deduped, state);
      }

      const elapsedMs = this.now() - startedAt;
      if (deduped.length === 0) {
        return {
          status: "not_found",
          reason: state.truncated
            ? "Recall ran but produced no useful evidence within limits"
            : "Sessions matched but no relevant evidence passed filters",
          evidence: [],
          searchedSessionIds,
          elapsedMs,
          modelCalls: state.modelCalls,
          triggerReason: decision.reason,
        };
      }

      return {
        status: state.truncated ? "partial" : "found",
        reason: state.truncated
          ? "Relevant evidence found, but retrieval hit time/token/model-call limits"
          : "Relevant evidence found",
        evidence: deduped,
        searchedSessionIds,
        elapsedMs,
        modelCalls: state.modelCalls,
        triggerReason: decision.reason,
      };
    } catch (err) {
      devWarn(
        "Context recall failed:",
        err instanceof Error ? err.message : String(err),
      );
      return {
        status: "not_found",
        reason: "Context recall failed unexpectedly",
        evidence: [],
        searchedSessionIds: [],
        elapsedMs: this.now() - startedAt,
        modelCalls: state.modelCalls,
        triggerReason: state.triggerReason,
      };
    }
  }

  private explicitDecision(query: string, searchQuery?: string): RecallDecision {
    return {
      needsRecall: true,
      reason: "explicit context_recall_agent tool invocation",
      searchQuery:
        typeof searchQuery === "string" && searchQuery.trim().length > 0
          ? searchQuery.trim()
          : query,
    };
  }

  private async decideRecall(
    query: string,
    memoryContext: PromptMemoryContext,
    state: RecallRuntimeState,
  ): Promise<RecallDecision> {
    const fallback = this.fallbackDecision(query, memoryContext);
    const messages = this.buildDecisionMessages(query, memoryContext);
    const parsed = await this.callModelJson<RecallDecisionPayload>(
      "DECIDE",
      messages,
      state,
    );
    if (!parsed || typeof parsed.needs_recall !== "boolean") {
      return fallback;
    }

    const reason = typeof parsed.reason === "string" && parsed.reason.trim().length > 0
      ? parsed.reason.trim()
      : fallback.reason;
    const searchQuery = typeof parsed.search_query === "string" && parsed.search_query.trim().length > 0
      ? parsed.search_query.trim()
      : query;

    return {
      needsRecall: parsed.needs_recall,
      reason,
      searchQuery,
    };
  }

  private buildDecisionMessages(
    query: string,
    memoryContext: PromptMemoryContext,
  ): LlmMessage[] {
    const recentTurns = memoryContext.conversationTurns
      .slice(-this.limits.decisionContextTurns)
      .map((turn, index) => ({
        id: `recent-${index + 1}`,
        role: turn.role,
        text: compactSnippet(turn.content, 260),
      }));

    const payload = {
      query,
      previous_session_summary: compactSnippet(memoryContext.previousSessionSummary, 380),
      recent_turns: recentTurns,
      policy: "Set needs_recall=true if prior-session memory is likely required for correctness.",
    };

    return [
      {
        role: "system",
        content:
          "You are context-recall-agent, a built-in retrieval sub-agent. MODE=DECIDE. Return strict JSON only.",
      },
      {
        role: "user",
        content: [
          "Return JSON with keys:",
          "{\"needs_recall\":true|false,\"reason\":\"string\",\"search_query\":\"string\"}",
          "Set search_query to concise retrieval keywords.",
          "Payload:",
          JSON.stringify(payload),
        ].join("\n"),
      },
    ];
  }

  private fallbackDecision(
    query: string,
    memoryContext: PromptMemoryContext,
  ): RecallDecision {
    const trimmedQuery = query.trim();
    if (HISTORY_QUERY_PATTERN.test(trimmedQuery)) {
      return {
        needsRecall: true,
        reason: "history-reference detected in user query",
        searchQuery: query,
      };
    }

    if (
      memoryContext.conversationTurns.length <= 2 &&
      trimmedQuery.length <= 220 &&
      REFERENTIAL_PATTERN.test(trimmedQuery)
    ) {
      return {
        needsRecall: true,
        reason: "short referential query with limited active context",
        searchQuery: query,
      };
    }

    return {
      needsRecall: false,
      reason: "no clear history dependency detected",
      searchQuery: query,
    };
  }

  private async extractSessionEvidence(
    query: string,
    queryTerms: string[],
    sessionHit: SessionSummarySearchHit,
    turns: IndexedTurn[],
    depth: number,
    state: RecallRuntimeState,
  ): Promise<RecalledContextEvidence[]> {
    if (turns.length === 0 || this.isDeadlineExceeded(state.startedAt)) return [];

    if (turns.length <= this.limits.maxLeafTurns || depth <= 1) {
      return this.extractLeafEvidence(query, queryTerms, sessionHit, turns, state);
    }

    const chunks = this.splitIntoChunks(turns);
    const selectedChunks = await this.selectRelevantChunks(
      query,
      queryTerms,
      sessionHit,
      chunks,
      state,
    );

    if (selectedChunks.length === 0) {
      return this.extractLeafEvidence(query, queryTerms, sessionHit, turns, state);
    }

    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const collected: RecalledContextEvidence[] = [];

    for (const selected of selectedChunks) {
      if (this.isDeadlineExceeded(state.startedAt)) {
        state.truncated = true;
        break;
      }

      const chunk = chunkMap.get(selected.id);
      if (!chunk) continue;

      const nested = await this.extractSessionEvidence(
        query,
        queryTerms,
        sessionHit,
        chunk.turns,
        depth - 1,
        state,
      );
      collected.push(...nested);

      if (collected.length >= this.limits.maxEvidenceItems) {
        state.truncated = true;
        break;
      }
    }

    if (collected.length > 0) return this.dedupeEvidence(collected);
    return this.extractLeafEvidence(query, queryTerms, sessionHit, turns, state);
  }

  private splitIntoChunks(turns: IndexedTurn[]): ChunkCandidate[] {
    if (turns.length === 0) return [];
    if (turns.length <= this.limits.maxLeafTurns) {
      const first = turns[0];
      const last = turns[turns.length - 1];
      if (!first || !last) return [];
      return [{
        id: `chunk-${first.index + 1}-${last.index + 1}`,
        turns,
        summary: this.summarizeChunk(turns),
      }];
    }

    const chunkCount = Math.max(
      2,
      Math.min(this.limits.maxChunkBranches, Math.ceil(turns.length / this.limits.maxLeafTurns)),
    );
    const chunkSize = Math.max(1, Math.ceil(turns.length / chunkCount));

    const chunks: ChunkCandidate[] = [];
    for (let i = 0; i < turns.length; i += chunkSize) {
      const chunkTurns = turns.slice(i, i + chunkSize);
      const first = chunkTurns[0];
      const last = chunkTurns[chunkTurns.length - 1];
      if (!first || !last) continue;
      chunks.push({
        id: `chunk-${first.index + 1}-${last.index + 1}`,
        turns: chunkTurns,
        summary: this.summarizeChunk(chunkTurns),
      });
    }

    return chunks;
  }

  private summarizeChunk(turns: IndexedTurn[]): string {
    const head = turns.slice(0, 2);
    const tail = turns.slice(-2);
    const rows = [...head, ...tail]
      .filter((entry, index, arr) => arr.findIndex((item) => item.index === entry.index) === index)
      .map(
        (entry) =>
          `turn-${entry.index + 1} (${entry.turn.role}): ${compactSnippet(entry.turn.content, 120)}`,
      );
    return rows.join(" | ");
  }

  private async selectRelevantChunks(
    query: string,
    queryTerms: string[],
    sessionHit: SessionSummarySearchHit,
    chunks: ChunkCandidate[],
    state: RecallRuntimeState,
  ): Promise<ChunkSelection[]> {
    if (chunks.length === 0) return [];
    if (chunks.length === 1) {
      return [{
        id: chunks[0]!.id,
        reason: "single chunk",
        confidence: 0.8,
      }];
    }

    const payload = {
      query,
      session_id: sessionHit.sessionId,
      session_summary: compactSnippet(sessionHit.summaryText, 280),
      chunks: chunks.map((chunk) => ({
        id: chunk.id,
        turn_start: `turn-${chunk.turns[0]!.index + 1}`,
        turn_end: `turn-${chunk.turns[chunk.turns.length - 1]!.index + 1}`,
        summary: chunk.summary,
      })),
      max_select: this.limits.maxChunkSelections,
    };

    const messages: LlmMessage[] = [
      {
        role: "system",
        content:
          "You are context-recall-agent, a built-in retrieval sub-agent. MODE=SELECT_CHUNKS. Return strict JSON only.",
      },
      {
        role: "user",
        content: [
          "Return JSON with key `selected`.",
          "`selected` is an array of:",
          "{\"id\":\"chunk-id\",\"reason\":\"string\",\"confidence\":0.0}",
          "Pick only chunks relevant to answering the query.",
          "Payload:",
          JSON.stringify(payload),
        ].join("\n"),
      },
    ];

    const parsed = await this.callModelJson<ChunkSelectionPayload>(
      "SELECT_CHUNKS",
      messages,
      state,
    );

    const validIds = new Set(chunks.map((chunk) => chunk.id));
    const selected = (parsed?.selected ?? [])
      .filter((item) => typeof item.id === "string" && validIds.has(item.id))
      .map((item) => ({
        id: item.id as string,
        reason: typeof item.reason === "string" && item.reason.trim().length > 0
          ? item.reason.trim()
          : "Model-selected relevant chunk",
        confidence: clampConfidence(item.confidence, 0.65),
      }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, this.limits.maxChunkSelections);

    if (selected.length > 0) return selected;
    return this.fallbackChunkSelection(queryTerms, chunks);
  }

  private fallbackChunkSelection(
    queryTerms: string[],
    chunks: ChunkCandidate[],
  ): ChunkSelection[] {
    return chunks
      .map((chunk) => ({
        id: chunk.id,
        reason: "Keyword overlap fallback",
        confidence: Math.min(0.85, 0.2 + this.scoreText(queryTerms, chunk.summary) / 5),
        score: this.scoreText(queryTerms, chunk.summary),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.limits.maxChunkSelections)
      .map(({ id, reason, confidence }) => ({ id, reason, confidence }));
  }

  private async extractLeafEvidence(
    query: string,
    queryTerms: string[],
    sessionHit: SessionSummarySearchHit,
    turns: IndexedTurn[],
    state: RecallRuntimeState,
  ): Promise<RecalledContextEvidence[]> {
    if (turns.length === 0) return [];

    const payload = {
      query,
      session_id: sessionHit.sessionId,
      turns: turns.slice(0, this.limits.maxLeafTurns).map((entry) => ({
        turn_ref: `turn-${entry.index + 1}`,
        role: entry.turn.role,
        timestamp: entry.turn.timestamp,
        content: compactSnippet(entry.turn.content, 420),
      })),
      max_evidence: this.limits.maxEvidencePerLeaf,
    };

    const messages: LlmMessage[] = [
      {
        role: "system",
        content:
          "You are context-recall-agent, a built-in retrieval sub-agent. MODE=EXTRACT_EVIDENCE. Return strict JSON only.",
      },
      {
        role: "user",
        content: [
          "Return JSON with key `evidence`.",
          "`evidence` is an array of:",
          "{\"turn_ref\":\"turn-N\",\"snippet\":\"string\",\"why_relevant\":\"string\",\"confidence\":0.0}",
          "Use only provided turns and keep snippet concise.",
          "Payload:",
          JSON.stringify(payload),
        ].join("\n"),
      },
    ];

    const parsed = await this.callModelJson<LeafEvidencePayload>(
      "EXTRACT_EVIDENCE",
      messages,
      state,
    );

    const turnByRef = new Map<string, IndexedTurn>(
      turns.map((entry) => [`turn-${entry.index + 1}`, entry]),
    );

    const extracted = (parsed?.evidence ?? [])
      .map((item) => {
        const turnRef = typeof item.turn_ref === "string" ? item.turn_ref.trim() : "";
        const matched = turnByRef.get(turnRef);
        if (!matched) return null;

        const snippet = typeof item.snippet === "string" && item.snippet.trim().length > 0
          ? compactSnippet(item.snippet, 320)
          : compactSnippet(matched.turn.content, 320);
        const whyRelevant =
          typeof item.why_relevant === "string" && item.why_relevant.trim().length > 0
            ? compactSnippet(item.why_relevant, 220)
            : "Model-selected relevant context";

        return {
          sessionId: sessionHit.sessionId,
          turnRef,
          timestamp: matched.turn.timestamp,
          snippet,
          whyRelevant,
          confidence: Number(clampConfidence(item.confidence, 0.7).toFixed(2)),
        } as RecalledContextEvidence;
      })
      .filter((item): item is RecalledContextEvidence => !!item)
      .slice(0, this.limits.maxEvidencePerLeaf);

    if (extracted.length > 0) return extracted;
    return this.fallbackLeafEvidence(queryTerms, sessionHit, turns);
  }

  private fallbackLeafEvidence(
    queryTerms: string[],
    sessionHit: SessionSummarySearchHit,
    turns: IndexedTurn[],
  ): RecalledContextEvidence[] {
    return turns
      .map((entry) => ({
        indexed: entry,
        score: this.scoreText(queryTerms, entry.turn.content),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.limits.maxEvidencePerLeaf)
      .map((item) => ({
        sessionId: sessionHit.sessionId,
        turnRef: `turn-${item.indexed.index + 1}`,
        timestamp: item.indexed.turn.timestamp,
        snippet: compactSnippet(item.indexed.turn.content, 320),
        whyRelevant: "Keyword-overlap fallback selection",
        confidence: Number(Math.min(0.85, 0.25 + item.score / 6).toFixed(2)),
      }));
  }

  private async rerankEvidence(
    query: string,
    evidence: RecalledContextEvidence[],
    state: RecallRuntimeState,
  ): Promise<RecalledContextEvidence[]> {
    if (!this.canCallModel(state)) {
      return evidence
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, this.limits.maxEvidenceItems);
    }

    const keyed = evidence.map((item) => ({
      key: `${item.sessionId}:${item.turnRef}`,
      sessionId: item.sessionId,
      turnRef: item.turnRef,
      timestamp: item.timestamp,
      snippet: compactSnippet(item.snippet, 220),
      whyRelevant: compactSnippet(item.whyRelevant, 160),
      confidence: item.confidence,
    }));

    const messages: LlmMessage[] = [
      {
        role: "system",
        content:
          "You are context-recall-agent, a built-in retrieval sub-agent. MODE=RERANK_EVIDENCE. Return strict JSON only.",
      },
      {
        role: "user",
        content: [
          "Return JSON with key `selected_keys` (ordered list).",
          "Select the strongest evidence keys for answering the query.",
          `Limit to at most ${this.limits.maxEvidenceItems} keys.`,
          "Payload:",
          JSON.stringify({ query, evidence: keyed }),
        ].join("\n"),
      },
    ];

    const parsed = await this.callModelJson<RerankPayload>(
      "RERANK_EVIDENCE",
      messages,
      state,
    );
    const selectedKeys = (parsed?.selected_keys ?? []).filter(
      (value): value is string => typeof value === "string",
    );

    if (selectedKeys.length === 0) {
      return evidence
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, this.limits.maxEvidenceItems);
    }

    const evidenceByKey = new Map(
      evidence.map((item) => [`${item.sessionId}:${item.turnRef}`, item]),
    );
    const reranked: RecalledContextEvidence[] = [];
    for (const key of selectedKeys) {
      const item = evidenceByKey.get(key);
      if (!item) continue;
      reranked.push(item);
      if (reranked.length >= this.limits.maxEvidenceItems) break;
    }

    if (reranked.length > 0) return reranked;
    return evidence
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, this.limits.maxEvidenceItems);
  }

  private async callModelJson<T>(
    mode: string,
    messages: LlmMessage[],
    state: RecallRuntimeState,
  ): Promise<T | null> {
    if (!this.canCallModel(state)) return null;
    if (!this.provider) return null;

    state.modelCalls += 1;
    try {
      const output = await this.provider.generateTurn({ messages });
      if (output.type !== "assistant") return null;
      return parseJson<T>(output.content);
    } catch (err) {
      devWarn(
        `Context recall model call failed (${mode}):`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  private applyTurnLimit(turns: ConversationTurn[], state: RecallRuntimeState): ConversationTurn[] {
    if (this.limits.maxTurnsPerSession <= 0) return turns;
    if (turns.length <= this.limits.maxTurnsPerSession) return turns;
    state.truncated = true;
    return turns.slice(0, this.limits.maxTurnsPerSession);
  }

  private scoreText(queryTerms: string[], text: string): number {
    if (queryTerms.length === 0) return 0;
    const terms = new Set(toKeywords(text));
    if (terms.size === 0) return 0;
    let score = 0;
    for (const term of queryTerms) {
      if (terms.has(term)) score += 1.25;
    }
    return score;
  }

  private dedupeEvidence(
    evidence: RecalledContextEvidence[],
  ): RecalledContextEvidence[] {
    const deduped = new Map<string, RecalledContextEvidence>();
    for (const item of evidence) {
      const key = `${item.sessionId}:${item.turnRef}`;
      const existing = deduped.get(key);
      if (!existing || existing.confidence < item.confidence) {
        deduped.set(key, item);
      }
    }
    return [...deduped.values()]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, this.limits.maxEvidenceItems);
  }

  private estimateEvidenceCost(item: RecalledContextEvidence): number {
    return (
      18 +
      estimateTextTokens(item.sessionId) +
      estimateTextTokens(item.turnRef) +
      estimateTextTokens(item.timestamp) +
      estimateTextTokens(item.snippet) +
      estimateTextTokens(item.whyRelevant)
    );
  }

  private canCallModel(state: RecallRuntimeState): boolean {
    if (!this.provider) return false;
    if (state.modelCalls >= this.limits.maxModelCalls) return false;
    if (this.isDeadlineExceeded(state.startedAt)) return false;
    return true;
  }

  private isDeadlineExceeded(startedAt: number): boolean {
    return this.now() - startedAt > this.limits.totalRecallMs;
  }
}
