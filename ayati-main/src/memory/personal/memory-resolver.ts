import { normalizeDecayMetadata, scoreMemory } from "./memory-scorer.js";
import { normalizeKind, normalizeSlot, PersonalMemoryStore } from "./personal-memory-store.js";
import type {
  MemoryCard,
  MemoryConsolidationJobPayload,
  MemoryPolicy,
  MemoryProposal,
  MemoryResolveResult,
  MemorySectionId,
  MemorySourceType,
  MemoryState,
} from "./types.js";
import { EVOLVING_MEMORY_SECTION_ID, TIME_BASED_SECTION_ID, USER_FACTS_SECTION_ID } from "./types.js";

export class MemoryResolver {
  private readonly store: PersonalMemoryStore;

  constructor(store: PersonalMemoryStore) {
    this.store = store;
  }

  resolve(
    userId: string,
    payload: MemoryConsolidationJobPayload,
    proposals: MemoryProposal[],
    policy: MemoryPolicy,
    nowIso = new Date().toISOString(),
  ): MemoryResolveResult {
    const result: MemoryResolveResult = {
      created: 0,
      confirmed: 0,
      superseded: 0,
      merged: 0,
      archived: 0,
      rejected: 0,
      reasons: [],
    };

    this.store.runInTransaction(() => {
      for (const rawProposal of proposals) {
        const proposal = normalizeProposal(rawProposal);
        const outcome = this.applyProposal(userId, payload, proposal, policy, nowIso);
        result[outcome.action] += 1;
        if (outcome.archived) {
          result.archived += outcome.archived;
        }
        if (outcome.reason) {
          result.reasons.push(outcome.reason);
        }
      }
    });

    return result;
  }

  private applyProposal(
    userId: string,
    payload: MemoryConsolidationJobPayload,
    proposal: MemoryProposal,
    policy: MemoryPolicy,
    nowIso: string,
  ): { action: Exclude<keyof MemoryResolveResult, "reasons" | "archived">; archived?: number; reason?: string } {
    if (proposal.text.length < 8 || proposal.evidence.length < 4) {
      return { action: "rejected", reason: `Rejected weak memory proposal slot=${proposal.slot}` };
    }
    if (looksLikeSecret(proposal.text) || looksLikeSecret(proposal.evidence)) {
      return { action: "rejected", reason: `Rejected secret-like memory proposal slot=${proposal.slot}` };
    }
    if (
      proposal.sectionId === USER_FACTS_SECTION_ID &&
      proposal.sourceType === "inferred" &&
      !policy.sections.userFacts.allowInferredFacts
    ) {
      return { action: "rejected", reason: `Rejected inferred user fact slot=${proposal.slot}` };
    }
    if (proposal.sectionId === TIME_BASED_SECTION_ID) {
      const expiresAt = proposal.expiresAt ? Date.parse(proposal.expiresAt) : NaN;
      if (!Number.isFinite(expiresAt)) {
        return { action: "rejected", reason: `Rejected timed memory without valid expiresAt slot=${proposal.slot}` };
      }
      if (expiresAt <= Date.parse(nowIso)) {
        return { action: "rejected", reason: `Rejected already-expired timed memory slot=${proposal.slot}` };
      }
      this.store.expireTimedCards(userId, new Date(nowIso));
    }

    const exactMatches = this.store.findCardsByAddress(
      userId,
      proposal.kind,
      proposal.slot,
      ["candidate", "active"],
      proposal.sectionId,
    );
    const same = exactMatches.find((memory) => sameMemory(memory, proposal));
    if (same) {
      this.store.confirmMemory(same, {
        memoryId: same.id,
        userId,
        sessionId: payload.sessionId,
        sessionPath: payload.sessionPath,
        evidenceType: "confirms",
        sourceText: proposal.evidence,
        createdAt: nowIso,
      }, {
        text: richerText(same.text, proposal.text),
        value: same.value ?? proposal.value ?? null,
        startsAt: proposal.startsAt ?? same.startsAt,
        eventAt: proposal.eventAt ?? same.eventAt,
        expiresAt: proposal.expiresAt ?? same.expiresAt,
        metadataJson: metadataForProposal(proposal, policy, same.metadataJson),
      });
      return { action: "confirmed", reason: `Confirmed memory slot=${proposal.slot}` };
    }

    if (exactMatches.length > 0 && !isMultiValueSlot(proposal)) {
      const strongest = exactMatches[0]!;
      if (isStrongCorrection(proposal)) {
        this.store.markSuperseded(strongest.id, "__pending__", nowIso);
        const card = this.store.createCard({
          userId,
          sectionId: proposal.sectionId,
          kind: proposal.kind,
          slot: proposal.slot,
          text: proposal.text,
          value: proposal.value,
          startsAt: proposal.startsAt,
          eventAt: proposal.eventAt,
          expiresAt: proposal.expiresAt,
          state: initialState(proposal, policy),
          confidence: proposal.confidence,
          importance: proposal.importance,
          sourceType: proposal.sourceType,
          sourceReliability: proposal.sourceReliability,
          metadataJson: metadataForProposal(proposal, policy),
          createdAt: nowIso,
        });
        this.store.markSuperseded(strongest.id, card.id, nowIso);
        this.store.addEvidence({
          memoryId: card.id,
          userId,
          sessionId: payload.sessionId,
          sessionPath: payload.sessionPath,
          evidenceType: "creates",
          sourceText: proposal.evidence,
          createdAt: nowIso,
        });
        this.store.addEvidence({
          memoryId: strongest.id,
          userId,
          sessionId: payload.sessionId,
          sessionPath: payload.sessionPath,
          evidenceType: "supersedes",
          sourceText: `Superseded by: ${proposal.text}`,
          createdAt: nowIso,
        });
        return { action: "superseded", reason: `Superseded memory slot=${proposal.slot}` };
      }

      this.store.recordContradiction(strongest, {
        memoryId: strongest.id,
        userId,
        sessionId: payload.sessionId,
        sessionPath: payload.sessionPath,
        evidenceType: "contradicts",
        sourceText: proposal.evidence,
        createdAt: nowIso,
      });
      return { action: "rejected", reason: `Rejected weak contradiction slot=${proposal.slot}` };
    }

    const candidates = this.store.findDedupCandidates(userId, proposal);
    const semanticSame = candidates.find((memory) => sameMemory(memory, proposal));
    if (semanticSame) {
      this.store.confirmMemory(semanticSame, {
        memoryId: semanticSame.id,
        userId,
        sessionId: payload.sessionId,
        sessionPath: payload.sessionPath,
        evidenceType: "confirms",
        sourceText: proposal.evidence,
        createdAt: nowIso,
      }, {
        text: richerText(semanticSame.text, proposal.text),
        value: semanticSame.value ?? proposal.value ?? null,
        startsAt: proposal.startsAt ?? semanticSame.startsAt,
        eventAt: proposal.eventAt ?? semanticSame.eventAt,
        expiresAt: proposal.expiresAt ?? semanticSame.expiresAt,
        metadataJson: metadataForProposal(proposal, policy, semanticSame.metadataJson),
      });
      return { action: "confirmed", reason: `Confirmed similar memory slot=${proposal.slot}` };
    }

    const admission = this.ensureCapacity(userId, proposal, policy, nowIso);
    if (!admission.allowed) {
      return { action: "rejected", reason: admission.reason };
    }

    const card = this.store.createCard({
      userId,
      sectionId: proposal.sectionId,
      kind: proposal.kind,
      slot: proposal.slot,
      text: proposal.text,
      value: proposal.value,
      startsAt: proposal.startsAt,
      eventAt: proposal.eventAt,
      expiresAt: proposal.expiresAt,
      state: initialState(proposal, policy),
      confidence: proposal.confidence,
      importance: proposal.importance,
      sourceType: proposal.sourceType,
      sourceReliability: proposal.sourceReliability,
      metadataJson: metadataForProposal(proposal, policy),
      createdAt: nowIso,
    });
    this.store.addEvidence({
      memoryId: card.id,
      userId,
      sessionId: payload.sessionId,
      sessionPath: payload.sessionPath,
      evidenceType: "creates",
      sourceText: proposal.evidence,
      createdAt: nowIso,
    });
    return {
      action: "created",
      archived: admission.archived,
      reason: `Created memory slot=${proposal.slot}`,
    };
  }

  private ensureCapacity(
    userId: string,
    proposal: MemoryProposal,
    policy: MemoryPolicy,
    nowIso: string,
  ): { allowed: true; archived: number } | { allowed: false; reason: string } {
    const sectionId = proposal.sectionId ?? USER_FACTS_SECTION_ID;
    const sectionPolicy = sectionCapacityPolicy(sectionId, policy);
    if (this.store.countLiveCards(userId, sectionId) < sectionPolicy.maxLiveCards) {
      return { allowed: true, archived: 0 };
    }

    const weakest = sectionId === TIME_BASED_SECTION_ID
      ? this.store.findWeakestRemovableTimed(userId, new Date(nowIso))
      : (sectionId === EVOLVING_MEMORY_SECTION_ID
        ? this.store.findWeakestRemovableEvolving(userId, new Date(nowIso), policy)
        : this.store.findWeakestRemovableFact(userId));
    if (!weakest) {
      return { allowed: false, reason: `Rejected memory because section is full and protected slot=${proposal.slot}` };
    }

    const newScore = proposalAdmissionScore(proposal, new Date(nowIso));
    const oldScore = scoreMemory(
      weakest,
      new Date(nowIso),
      { policy, activeSectionCount: this.store.countLiveCards(userId, sectionId) },
    ).retentionScore;
    if (newScore <= oldScore + sectionPolicy.admissionMargin) {
      return {
        allowed: false,
        reason: `Rejected low-value memory because section is full slot=${proposal.slot}`,
      };
    }

    this.store.archiveCard(weakest.id, nowIso);
    this.store.addEvidence({
      memoryId: weakest.id,
      userId,
      evidenceType: "archives",
      sourceText: `Archived to admit stronger memory: ${proposal.text}`,
      createdAt: nowIso,
    });
    return { allowed: true, archived: 1 };
  }
}

function normalizeProposal(raw: MemoryProposal): MemoryProposal {
  const sourceType = normalizeSourceType(raw.sourceType);
  const sectionId = normalizeSectionId(raw.sectionId);
  const confidence = clampUnit(
    Number.isFinite(raw.confidence) ? raw.confidence : defaultConfidence(sourceType),
  );
  return {
    text: normalizeText(raw.text),
    sectionId,
    lifecycle: lifecycleForSection(sectionId),
    kind: normalizeKind(raw.kind || kindFromSlot(raw.slot)),
    slot: normalizeSlot(raw.slot),
    value: normalizeNullableText(raw.value),
    startsAt: normalizeIsoOrNull(raw.startsAt),
    eventAt: normalizeIsoOrNull(raw.eventAt),
    expiresAt: normalizeIsoOrNull(raw.expiresAt),
    confidence,
    importance: clampUnit(raw.importance || defaultImportance(raw.slot, sectionId)),
    sourceType,
    sourceReliability: clampUnit(raw.sourceReliability || defaultSourceReliability(sourceType)),
    evidence: normalizeText(raw.evidence),
    reasoning: raw.reasoning,
    decay: raw.decay,
  };
}

function initialState(proposal: MemoryProposal, policy: MemoryPolicy): MemoryState {
  const minConfidence = proposal.sectionId === TIME_BASED_SECTION_ID
    ? policy.sections.timeBased.minActiveConfidence
    : (proposal.sectionId === EVOLVING_MEMORY_SECTION_ID
      ? policy.sections.evolvingMemory.minActiveConfidence
      : policy.sections.userFacts.minActiveConfidence);
  return proposal.confidence >= minConfidence ? "active" : "candidate";
}

function sameMemory(memory: MemoryCard, proposal: MemoryProposal): boolean {
  if (memory.sectionId !== proposal.sectionId) {
    return false;
  }
  if (proposal.sectionId === TIME_BASED_SECTION_ID) {
    return sameTimedMemory(memory, proposal);
  }
  if (memory.kind === proposal.kind && memory.slot === proposal.slot) {
    if (memory.value && proposal.value) {
      return normalizedValue(memory.value) === normalizedValue(proposal.value);
    }
    return contentSimilarity(memory.text, proposal.text) >= 0.58;
  }
  if (memory.value && proposal.value && normalizedValue(memory.value) === normalizedValue(proposal.value)) {
    return contentSimilarity(memory.text, proposal.text) >= 0.72;
  }
  return false;
}

function sameTimedMemory(memory: MemoryCard, proposal: MemoryProposal): boolean {
  if (memory.kind !== proposal.kind || memory.slot !== proposal.slot) {
    return false;
  }
  const memoryEvent = memory.eventAt ?? memory.expiresAt;
  const proposalEvent = proposal.eventAt ?? proposal.expiresAt;
  if (memoryEvent && proposalEvent) {
    return sameUtcDay(memoryEvent, proposalEvent);
  }
  if (memory.expiresAt && proposal.expiresAt) {
    return sameUtcDay(memory.expiresAt, proposal.expiresAt) && contentSimilarity(memory.text, proposal.text) >= 0.5;
  }
  return contentSimilarity(memory.text, proposal.text) >= 0.75;
}

function isStrongCorrection(proposal: MemoryProposal): boolean {
  return (
    proposal.sourceType === "manual_user_request" ||
    proposal.sourceType === "explicit_user_statement"
  ) && proposal.confidence >= 0.8;
}

function isMultiValueSlot(proposal: MemoryProposal): boolean {
  if (proposal.sectionId === TIME_BASED_SECTION_ID) {
    return false;
  }
  return /\b(friends?|siblings?|children|colleagues|contacts|important_people|family_members)\b/i.test(proposal.slot);
}

function richerText(left: string, right: string): string {
  return right.length > left.length + 12 ? right : left;
}

function lifecycleForSection(sectionId: MemorySectionId): MemoryProposal["lifecycle"] {
  if (sectionId === TIME_BASED_SECTION_ID) return "timed";
  if (sectionId === EVOLVING_MEMORY_SECTION_ID) return "evolving";
  return "fact";
}

function metadataForProposal(proposal: MemoryProposal, policy: MemoryPolicy, existingJson?: string | null): string {
  const metadata = parseMetadata(existingJson);
  if (proposal.reasoning) {
    metadata["reasoning"] = proposal.reasoning;
  } else if (!("reasoning" in metadata)) {
    metadata["reasoning"] = null;
  }
  if (proposal.sectionId === EVOLVING_MEMORY_SECTION_ID) {
    metadata["decay"] = normalizeDecayMetadata(proposal.kind, proposal.decay, policy);
  }
  return JSON.stringify(metadata);
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function kindFromSlot(slot: string): string {
  return normalizeKind(slot.split("/")[0] ?? "general");
}

function defaultImportance(slot: string, sectionId: MemorySectionId): number {
  const normalized = normalizeSlot(slot);
  if (sectionId === TIME_BASED_SECTION_ID) {
    if (/exam|deadline|interview/.test(normalized)) return 0.9;
    if (/travel|vacation|trip/.test(normalized)) return 0.75;
    if (/meeting|appointment/.test(normalized)) return 0.7;
    return 0.65;
  }
  if (sectionId === EVOLVING_MEMORY_SECTION_ID) {
    if (/constraint|permission|procedural/.test(normalized)) return 0.9;
    if (/preference|goal|current_project|decision/.test(normalized)) return 0.8;
    if (/skill|environment|routine/.test(normalized)) return 0.7;
    if (/feedback|relationship/.test(normalized)) return 0.65;
    return 0.6;
  }
  if (normalized === "identity/name" || normalized === "identity/date_of_birth") return 1;
  if (normalized === "identity/mother_tongue") return 0.9;
  if (/^family\/(?:mother|father|parent).*name/.test(normalized)) return 0.85;
  if (/friend|relationship/.test(normalized)) return 0.65;
  return 0.7;
}

function defaultConfidence(sourceType: MemorySourceType): number {
  if (sourceType === "manual_user_request") return 0.95;
  if (sourceType === "explicit_user_statement") return 0.85;
  if (sourceType === "agent_observation") return 0.65;
  return 0.5;
}

function defaultSourceReliability(sourceType: MemorySourceType): number {
  if (sourceType === "manual_user_request") return 0.98;
  if (sourceType === "explicit_user_statement") return 0.95;
  if (sourceType === "agent_observation") return 0.75;
  return 0.6;
}

function normalizeSourceType(value: unknown): MemorySourceType {
  if (
    value === "explicit_user_statement" ||
    value === "manual_user_request" ||
    value === "agent_observation" ||
    value === "inferred"
  ) {
    return value;
  }
  return "inferred";
}

function normalizeSectionId(value: unknown): MemorySectionId {
  if (value === TIME_BASED_SECTION_ID) {
    return TIME_BASED_SECTION_ID;
  }
  if (value === EVOLVING_MEMORY_SECTION_ID) {
    return EVOLVING_MEMORY_SECTION_ID;
  }
  return USER_FACTS_SECTION_ID;
}

function normalizeIsoOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeNullableText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : null;
}

function normalizedValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function sameUtcDay(left: string, right: string): boolean {
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  return Number.isFinite(leftDate.getTime()) &&
    Number.isFinite(rightDate.getTime()) &&
    leftDate.toISOString().slice(0, 10) === rightDate.toISOString().slice(0, 10);
}

function sectionCapacityPolicy(sectionId: MemorySectionId, policy: MemoryPolicy): {
  maxLiveCards: number;
  admissionMargin: number;
} {
  if (sectionId === TIME_BASED_SECTION_ID) {
    return policy.sections.timeBased;
  }
  if (sectionId === EVOLVING_MEMORY_SECTION_ID) {
    return policy.sections.evolvingMemory;
  }
  return policy.sections.userFacts;
}

function proposalAdmissionScore(proposal: MemoryProposal, now: Date): number {
  const base = proposal.confidence * proposal.importance;
  if (proposal.sectionId !== TIME_BASED_SECTION_ID || !proposal.expiresAt) {
    return base;
  }
  const expiresAt = Date.parse(proposal.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return base;
  }
  const daysLeft = Math.max(0, (expiresAt - now.getTime()) / 86_400_000);
  const urgencyBoost = daysLeft <= 1 ? 1.2 : (daysLeft <= 7 ? 1.1 : 1);
  return base * urgencyBoost;
}

function contentSimilarity(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap++;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function tokenize(value: string): Set<string> {
  const tokens = value.toLowerCase().match(/[a-z0-9_/-]{3,}/g) ?? [];
  return new Set(tokens.filter((token) => !STOPWORDS.has(token)));
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function looksLikeSecret(value: string): boolean {
  return /\b(password|passwd|secret|token|api[_-]?key|private[_-]?key|otp|credential)\b/i.test(value);
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "user",
  "users",
  "that",
  "this",
  "has",
  "have",
  "his",
  "her",
  "their",
  "name",
]);
