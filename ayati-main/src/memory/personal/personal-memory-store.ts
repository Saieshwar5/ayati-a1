import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { scoreMemory } from "./memory-scorer.js";
import type {
  MemoryCard,
  MemoryConsolidationJob,
  MemoryConsolidationJobPayload,
  MemoryEvidenceRecord,
  MemoryEvidenceType,
  MemoryPolicy,
  MemoryProposal,
  MemorySectionId,
  MemorySourceType,
  MemoryState,
  MemoryUsageOutcome,
} from "./types.js";
import { EVOLVING_MEMORY_SECTION_ID, TIME_BASED_SECTION_ID, USER_FACTS_SECTION_ID } from "./types.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..", "..");
const DEFAULT_DATA_DIR = resolve(projectRoot, "data", "memory");
const LIVE_STATES: MemoryState[] = ["candidate", "active"];
const DEFAULT_FACT_IMPORTANCE = 0.7;
const DEFAULT_TIMED_IMPORTANCE = 0.65;
const DEFAULT_EVOLVING_IMPORTANCE = 0.6;

export interface PersonalMemoryStoreOptions {
  dataDir?: string;
  dbPath?: string;
  now?: () => Date;
}

export interface MemoryAuditEvent {
  jobId?: string;
  userId?: string;
  sessionId?: string;
  sectionId?: MemorySectionId;
  event: string;
  memoryId?: string;
  action?: string;
  slot?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface CreateCardInput {
  userId: string;
  sectionId?: MemorySectionId;
  kind: string;
  slot: string;
  text: string;
  value?: string | null;
  startsAt?: string | null;
  eventAt?: string | null;
  expiresAt?: string | null;
  state: MemoryState;
  confidence: number;
  importance: number;
  sourceType: MemorySourceType;
  sourceReliability: number;
  metadataJson?: string | null;
  createdAt?: string;
}

export interface EvidenceInput {
  memoryId: string;
  userId: string;
  sessionId?: string | null;
  runId?: string | null;
  sessionPath?: string | null;
  runPath?: string | null;
  evidenceType: MemoryEvidenceType;
  sourceText: string;
  createdAt?: string;
}

export interface MemorySearchInput {
  query?: string;
  sectionId?: MemorySectionId;
  kind?: string;
  slot?: string;
  states?: MemoryState[];
  limit?: number;
}

export class PersonalMemoryStore {
  private readonly dbPath: string;
  private readonly nowProvider: () => Date;
  private db: DatabaseSync | null = null;

  constructor(options?: PersonalMemoryStoreOptions) {
    const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    this.dbPath = options?.dbPath ?? resolve(dataDir, "personal.sqlite");
    this.nowProvider = options?.now ?? (() => new Date());
  }

  start(_policy: MemoryPolicy): void {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.createSchema();
    this.ensureCardSchemaColumns();
  }

  stop(): void {
    this.db?.close();
    this.db = null;
  }

  createCard(input: CreateCardInput): MemoryCard {
    const now = input.createdAt ?? this.nowIso();
    const sectionId = input.sectionId ?? USER_FACTS_SECTION_ID;
    const card: MemoryCard = {
      id: `mem_${randomUUID()}`,
      userId: input.userId,
      sectionId,
      kind: normalizeKind(input.kind),
      slot: normalizeSlot(input.slot),
      lifecycle: lifecycleForSection(sectionId),
      text: normalizeText(input.text),
      value: normalizeNullableText(input.value),
      startsAt: normalizeIsoOrNull(input.startsAt),
      eventAt: normalizeIsoOrNull(input.eventAt),
      expiresAt: normalizeIsoOrNull(input.expiresAt),
      state: input.state,
      confidence: clampUnit(input.confidence),
      importance: clampUnit(input.importance || defaultImportanceForSection(sectionId)),
      confirmations: 0,
      corrections: 0,
      contradictions: 0,
      helpfulHits: 0,
      harmfulHits: 0,
      sourceType: normalizeSourceType(input.sourceType),
      sourceReliability: clampUnit(input.sourceReliability || defaultSourceReliability(input.sourceType)),
      createdAt: now,
      lastConfirmedAt: now,
      lastUsedAt: null,
      supersededById: null,
      mergedIntoId: null,
      metadataJson: input.metadataJson ?? null,
    };
    this.insertCard(card);
    return card;
  }

  listMemories(
    userId: string,
    states?: MemoryState[],
    limit = 200,
    sectionId: MemorySectionId = USER_FACTS_SECTION_ID,
  ): MemoryCard[] {
    const capped = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const memoryStates = states && states.length > 0 ? states : LIVE_STATES;
    const rows = this.requireDb().prepare(`
      SELECT *
      FROM memory_cards
      WHERE user_id = ?
        AND section_id = ?
        AND state IN (${memoryStates.map(() => "?").join(", ")})
      ORDER BY
        CASE state WHEN 'active' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
        confidence DESC,
        last_confirmed_at DESC,
        created_at DESC
      LIMIT ?
    `).all(userId, sectionId, ...memoryStates, capped) as Record<string, unknown>[];
    return rows.map(mapCardRow);
  }

  getMemory(memoryId: string): MemoryCard | null {
    const row = this.requireDb()
      .prepare("SELECT * FROM memory_cards WHERE id = ?")
      .get(memoryId) as Record<string, unknown> | undefined;
    return row ? mapCardRow(row) : null;
  }

  searchMemories(userId: string, input: MemorySearchInput): MemoryCard[] {
    const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 10)));
    const sectionId = input.sectionId ?? USER_FACTS_SECTION_ID;
    const states = input.states && input.states.length > 0 ? input.states : LIVE_STATES;
    const kind = input.kind ? normalizeKind(input.kind) : "";
    const slot = input.slot ? normalizeSlot(input.slot) : "";
    const query = input.query?.trim() ?? "";

    if (query.length > 0) {
      const ftsQuery = toFtsQuery([query, kind, slot]);
      if (ftsQuery) {
        const rows = this.requireDb().prepare(`
          SELECT c.*
          FROM memory_cards_fts
          JOIN memory_cards c ON c.id = memory_cards_fts.card_id
          WHERE memory_cards_fts MATCH ?
            AND c.user_id = ?
            AND c.section_id = ?
            AND c.state IN (${states.map(() => "?").join(", ")})
            ${kind ? "AND c.kind = ?" : ""}
            ${slot ? "AND c.slot = ?" : ""}
          ORDER BY bm25(memory_cards_fts), c.confidence DESC
          LIMIT ?
        `).all(
          ftsQuery,
          userId,
          sectionId,
          ...states,
          ...(kind ? [kind] : []),
          ...(slot ? [slot] : []),
          limit,
        ) as Record<string, unknown>[];
        return rows.map(mapCardRow);
      }
    }

    const clauses = [
      "user_id = ?",
      "section_id = ?",
      `state IN (${states.map(() => "?").join(", ")})`,
    ];
    const params: SQLInputValue[] = [userId, sectionId, ...states];
    if (kind) {
      clauses.push("kind = ?");
      params.push(kind);
    }
    if (slot) {
      clauses.push("slot = ?");
      params.push(slot);
    }
    params.push(limit);
    const rows = this.requireDb().prepare(`
      SELECT *
      FROM memory_cards
      WHERE ${clauses.join(" AND ")}
      ORDER BY confidence DESC, last_confirmed_at DESC, created_at DESC
      LIMIT ?
    `).all(...params) as Record<string, unknown>[];
    return rows.map(mapCardRow);
  }

  findCardsByAddress(
    userId: string,
    kind: string,
    slot: string,
    states: MemoryState[] = LIVE_STATES,
    sectionId: MemorySectionId = USER_FACTS_SECTION_ID,
  ): MemoryCard[] {
    const rows = this.requireDb().prepare(`
      SELECT *
      FROM memory_cards
      WHERE user_id = ?
        AND section_id = ?
        AND kind = ?
        AND slot = ?
        AND state IN (${states.map(() => "?").join(", ")})
      ORDER BY confidence DESC, last_confirmed_at DESC, created_at DESC
    `).all(
      userId,
      sectionId,
      normalizeKind(kind),
      normalizeSlot(slot),
      ...states,
    ) as Record<string, unknown>[];
    return rows.map(mapCardRow);
  }

  findMemoriesBySlot(
    userId: string,
    slotName: string,
    states: MemoryState[] = LIVE_STATES,
    sectionId: MemorySectionId = USER_FACTS_SECTION_ID,
  ): MemoryCard[] {
    const slot = normalizeSlot(slotName);
    const rows = this.requireDb().prepare(`
      SELECT *
      FROM memory_cards
      WHERE user_id = ?
        AND section_id = ?
        AND slot = ?
        AND state IN (${states.map(() => "?").join(", ")})
      ORDER BY confidence DESC, last_confirmed_at DESC, created_at DESC
    `).all(userId, sectionId, slot, ...states) as Record<string, unknown>[];
    return rows.map(mapCardRow);
  }

  findDedupCandidates(userId: string, proposal: MemoryProposal, limit = 20): MemoryCard[] {
    const candidates = new Map<string, MemoryCard>();
    const add = (cards: MemoryCard[]): void => {
      for (const card of cards) {
        if (!candidates.has(card.id)) {
          candidates.set(card.id, card);
        }
      }
    };

    const sectionId = proposal.sectionId ?? USER_FACTS_SECTION_ID;
    add(this.findCardsByAddress(userId, proposal.kind, proposal.slot, LIVE_STATES, sectionId));
    add(this.findMemoriesBySlot(userId, proposal.slot, LIVE_STATES, sectionId));
    add(this.searchMemories(userId, {
      query: [proposal.kind, proposal.slot, proposal.value ?? "", proposal.text].join(" "),
      sectionId,
      states: LIVE_STATES,
      limit,
    }));
    add(this.listMemories(userId, LIVE_STATES, Math.min(10, limit), sectionId));

    return [...candidates.values()].slice(0, limit);
  }

  confirmMemory(
    memory: MemoryCard,
    evidence?: EvidenceInput,
    updates?: {
      text?: string;
      value?: string | null;
      startsAt?: string | null;
      eventAt?: string | null;
      expiresAt?: string | null;
      metadataJson?: string | null;
    },
  ): MemoryCard {
    const now = evidence?.createdAt ?? this.nowIso();
    const nextConfidence = Math.min(0.99, memory.confidence + 0.04);
    const nextState: MemoryState = nextConfidence >= 0.8 ? "active" : memory.state;
    const nextText = normalizeText(updates?.text ?? memory.text);
    const nextValue = normalizeNullableText(updates?.value ?? memory.value);
    const nextStartsAt = normalizeIsoOrNull(updates?.startsAt ?? memory.startsAt);
    const nextEventAt = normalizeIsoOrNull(updates?.eventAt ?? memory.eventAt);
    const nextExpiresAt = normalizeIsoOrNull(updates?.expiresAt ?? memory.expiresAt);
    const nextMetadataJson = updates && "metadataJson" in updates ? updates.metadataJson ?? null : memory.metadataJson ?? null;
    this.requireDb().prepare(`
      UPDATE memory_cards
      SET text = ?,
          value = ?,
          starts_at = ?,
          event_at = ?,
          expires_at = ?,
          metadata_json = ?,
          state = ?,
          confidence = ?,
          confirmations = confirmations + 1,
          last_confirmed_at = ?
      WHERE id = ?
    `).run(
      nextText,
      nextValue,
      nextStartsAt,
      nextEventAt,
      nextExpiresAt,
      nextMetadataJson,
      nextState,
      nextConfidence,
      now,
      memory.id,
    );
    if (evidence) {
      this.addEvidence({ ...evidence, evidenceType: "confirms", createdAt: now });
    }
    const updated = this.getMemory(memory.id);
    if (!updated) {
      throw new Error(`Memory disappeared after confirm: ${memory.id}`);
    }
    this.upsertFts(updated);
    return updated;
  }

  recordContradiction(memory: MemoryCard, evidence?: EvidenceInput): MemoryCard {
    const now = evidence?.createdAt ?? this.nowIso();
    const nextConfidence = Math.max(0.05, memory.confidence - 0.2);
    const nextState: MemoryState = nextConfidence < 0.25 && memory.state === "candidate" ? "rejected" : memory.state;
    this.requireDb().prepare(`
      UPDATE memory_cards
      SET confidence = ?,
          state = ?,
          contradictions = contradictions + 1,
          last_confirmed_at = ?
      WHERE id = ?
    `).run(nextConfidence, nextState, now, memory.id);
    if (evidence) {
      this.addEvidence({ ...evidence, evidenceType: "contradicts", createdAt: now });
    }
    const updated = this.getMemory(memory.id);
    if (!updated) {
      throw new Error(`Memory disappeared after contradiction: ${memory.id}`);
    }
    return updated;
  }

  markSuperseded(memoryId: string, supersededById: string, now = this.nowIso()): void {
    this.requireDb().prepare(`
      UPDATE memory_cards
      SET state = 'superseded',
          corrections = corrections + 1,
          superseded_by_id = ?,
          last_confirmed_at = ?
      WHERE id = ?
    `).run(supersededById, now, memoryId);
  }

  mergeCards(sourceId: string, targetId: string, now = this.nowIso()): void {
    this.requireDb().prepare(`
      UPDATE memory_cards
      SET state = 'merged',
          merged_into_id = ?,
          last_confirmed_at = ?
      WHERE id = ?
    `).run(targetId, now, sourceId);
  }

  updateMemoryState(memoryId: string, state: MemoryState): void {
    this.requireDb().prepare("UPDATE memory_cards SET state = ? WHERE id = ?").run(state, memoryId);
  }

  archiveCard(memoryId: string, now = this.nowIso()): void {
    this.requireDb().prepare(`
      UPDATE memory_cards
      SET state = 'archived',
          last_confirmed_at = ?
      WHERE id = ?
    `).run(now, memoryId);
  }

  countLiveCards(userId: string, sectionId: MemorySectionId = USER_FACTS_SECTION_ID): number {
    const row = this.requireDb().prepare(`
      SELECT COUNT(*) AS count
      FROM memory_cards
      WHERE user_id = ?
        AND section_id = ?
        AND state IN ('candidate', 'active')
    `).get(userId, sectionId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  findWeakestRemovableFact(userId: string): MemoryCard | null {
    const cards = this.listMemories(userId, LIVE_STATES, 500, USER_FACTS_SECTION_ID)
      .filter((card) => !isProtectedFact(card))
      .map((card) => ({ card, score: removableScore(card) }))
      .sort((a, b) => a.score - b.score);
    return cards[0]?.card ?? null;
  }

  findWeakestRemovableTimed(userId: string, now = this.nowProvider()): MemoryCard | null {
    const cards = this.listMemories(userId, LIVE_STATES, 500, TIME_BASED_SECTION_ID)
      .map((card) => ({ card, score: timedRemovableScore(card, now) }))
      .sort((a, b) => a.score - b.score);
    return cards[0]?.card ?? null;
  }

  findWeakestRemovableEvolving(userId: string, now = this.nowProvider(), policy?: MemoryPolicy): MemoryCard | null {
    const activeCount = this.countLiveCards(userId, EVOLVING_MEMORY_SECTION_ID);
    const cards = this.listMemories(userId, LIVE_STATES, 1_000, EVOLVING_MEMORY_SECTION_ID)
      .map((card) => ({
        card,
        score: scoreMemory(card, now, { policy, activeSectionCount: activeCount }).retentionScore,
      }))
      .sort((a, b) => a.score - b.score);
    return cards[0]?.card ?? null;
  }

  expireTimedCards(userId: string, now = this.nowProvider()): number {
    const nowIso = now.toISOString();
    const result = this.requireDb().prepare(`
      UPDATE memory_cards
      SET state = 'expired',
          last_confirmed_at = ?
      WHERE user_id = ?
        AND section_id = ?
        AND state IN ('candidate', 'active')
        AND expires_at IS NOT NULL
        AND expires_at <= ?
    `).run(nowIso, userId, TIME_BASED_SECTION_ID, nowIso);
    return Number(result.changes ?? 0);
  }

  archiveLowScoringEvolvingCards(userId: string, now = this.nowProvider(), policy?: MemoryPolicy): number {
    const activeCount = this.countLiveCards(userId, EVOLVING_MEMORY_SECTION_ID);
    let archived = 0;
    for (const card of this.listMemories(userId, LIVE_STATES, 1_000, EVOLVING_MEMORY_SECTION_ID)) {
      const score = scoreMemory(card, now, { policy, activeSectionCount: activeCount });
      if (score.retentionScore < score.archiveThreshold) {
        this.archiveCard(card.id, now.toISOString());
        archived++;
      }
    }
    return archived;
  }

  addEvidence(input: EvidenceInput): void {
    const now = input.createdAt ?? this.nowIso();
    this.requireDb().prepare(`
      INSERT INTO memory_evidence (
        id,
        memory_id,
        user_id,
        session_id,
        run_id,
        session_path,
        run_path,
        evidence_type,
        source_text,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `ev_${randomUUID()}`,
      input.memoryId,
      input.userId,
      input.sessionId ?? null,
      input.runId ?? null,
      input.sessionPath ?? null,
      input.runPath ?? null,
      input.evidenceType,
      input.sourceText,
      now,
    );
  }

  listEvidence(memoryId: string, limit = 20): MemoryEvidenceRecord[] {
    const capped = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.requireDb().prepare(`
      SELECT *
      FROM memory_evidence
      WHERE memory_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(memoryId, capped) as Record<string, unknown>[];
    return rows.map(mapEvidenceRow);
  }

  recordUsage(memoryId: string, runId: string | null, outcome: MemoryUsageOutcome): void {
    const normalized = outcome === "failure" || outcome === "harmful" ? "harmful" : "helpful";
    const now = this.nowIso();
    this.requireDb().prepare(`
      INSERT INTO memory_usage (id, memory_id, run_id, used_at, outcome)
      VALUES (?, ?, ?, ?, ?)
    `).run(`use_${randomUUID()}`, memoryId, runId, now, normalized);
    this.requireDb().prepare(`
      UPDATE memory_cards
      SET helpful_hits = helpful_hits + ?,
          harmful_hits = harmful_hits + ?,
          last_used_at = ?
      WHERE id = ?
    `).run(normalized === "helpful" ? 1 : 0, normalized === "harmful" ? 1 : 0, now, memoryId);
  }

  enqueueConsolidationJob(payload: MemoryConsolidationJobPayload, now = this.nowIso()): string {
    const jobId = `session:${payload.userId}:${payload.sessionId}`;
    this.requireDb().prepare(`
      INSERT INTO memory_consolidation_jobs (
        job_id,
        user_id,
        session_id,
        session_path,
        handoff_summary,
        payload_json,
        status,
        attempts,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        payload_json = excluded.payload_json,
        status = 'pending',
        handoff_summary = excluded.handoff_summary,
        last_error = NULL
    `).run(
      jobId,
      payload.userId,
      payload.sessionId,
      payload.sessionPath,
      payload.handoffSummary ?? null,
      JSON.stringify(payload),
      now,
    );
    return jobId;
  }

  hasPendingJobs(): boolean {
    const row = this.requireDb()
      .prepare("SELECT 1 AS found FROM memory_consolidation_jobs WHERE status = 'pending' LIMIT 1")
      .get() as { found?: number } | undefined;
    return row?.found === 1;
  }

  claimNextJob(now = this.nowIso()): MemoryConsolidationJob | null {
    const row = this.requireDb().prepare(`
      SELECT *
      FROM memory_consolidation_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    const job = mapJobRow(row);
    this.requireDb().prepare(`
      UPDATE memory_consolidation_jobs
      SET status = 'running',
          attempts = attempts + 1,
          started_at = ?
      WHERE job_id = ?
    `).run(now, job.jobId);
    return { ...job, status: "running", attempts: job.attempts + 1, startedAt: now };
  }

  markJobDone(jobId: string, now = this.nowIso()): void {
    this.requireDb().prepare(`
      UPDATE memory_consolidation_jobs
      SET status = 'done',
          completed_at = ?,
          last_error = NULL
      WHERE job_id = ?
    `).run(now, jobId);
  }

  markJobFailed(jobId: string, error: string, now = this.nowIso()): void {
    this.requireDb().prepare(`
      UPDATE memory_consolidation_jobs
      SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
          completed_at = ?,
          last_error = ?
      WHERE job_id = ?
    `).run(now, error, jobId);
  }

  updateSnapshot(userId: string, content: string, memoryIds: string[], now = this.nowIso()): void {
    this.requireDb().prepare(`
      INSERT INTO memory_snapshot (user_id, content, memory_ids_json, generated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        content = excluded.content,
        memory_ids_json = excluded.memory_ids_json,
        generated_at = excluded.generated_at
    `).run(userId, content, JSON.stringify(memoryIds), now);
  }

  getSnapshot(userId: string): string {
    const row = this.requireDb()
      .prepare("SELECT content FROM memory_snapshot WHERE user_id = ?")
      .get(userId) as { content?: string } | undefined;
    return row?.content ?? "";
  }

  writeAuditEvent(input: MemoryAuditEvent): void {
    const level = process.env["MEMORY_EVOLUTION_LOG_LEVEL"] ?? "summary";
    if (/^(?:0|false|no|off)$/i.test(level)) {
      return;
    }
    const now = this.nowIso();
    const logDir = resolve(dirname(this.dbPath), "logs");
    mkdirSync(logDir, { recursive: true });
    const day = now.slice(0, 10);
    appendFileSync(resolve(logDir, `evolution-${day}.jsonl`), `${JSON.stringify({
      ts: now,
      ...input,
    })}\n`);
  }

  archiveExpiredAndPrune(userId: string, _now = new Date(), policy?: MemoryPolicy): number {
    const now = _now;
    let archived = this.expireTimedCards(userId, now);
    archived += this.archiveLowScoringEvolvingCards(userId, now, policy);
    const maxFacts = policy?.sections.userFacts.maxLiveCards ?? 50;
    const maxTimed = policy?.sections.timeBased.maxLiveCards ?? 50;
    const maxEvolving = policy?.sections.evolvingMemory.maxLiveCards ?? 300;
    while (this.countLiveCards(userId, USER_FACTS_SECTION_ID) > maxFacts) {
      const weakest = this.findWeakestRemovableFact(userId);
      if (!weakest) break;
      this.archiveCard(weakest.id);
      archived++;
    }
    while (this.countLiveCards(userId, TIME_BASED_SECTION_ID) > maxTimed) {
      const weakest = this.findWeakestRemovableTimed(userId, now);
      if (!weakest) break;
      this.archiveCard(weakest.id);
      archived++;
    }
    while (this.countLiveCards(userId, EVOLVING_MEMORY_SECTION_ID) > maxEvolving) {
      const weakest = this.findWeakestRemovableEvolving(userId, now, policy);
      if (!weakest) break;
      this.archiveCard(weakest.id);
      archived++;
    }
    return archived;
  }

  archiveUserFactsOverLimit(userId: string, maxLive: number): number {
    let archived = 0;
    while (this.countLiveCards(userId, USER_FACTS_SECTION_ID) > maxLive) {
      const weakest = this.findWeakestRemovableFact(userId);
      if (!weakest) break;
      this.archiveCard(weakest.id);
      archived++;
    }
    return archived;
  }

  runInTransaction<T>(fn: () => T): T {
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  private insertCard(card: MemoryCard): void {
    this.requireDb().prepare(`
      INSERT INTO memory_cards (
        id,
        user_id,
        section_id,
        kind,
        slot,
        lifecycle,
        text,
        value,
        starts_at,
        event_at,
        expires_at,
        state,
        confidence,
        importance,
        confirmations,
        corrections,
        contradictions,
        helpful_hits,
        harmful_hits,
        source_type,
        source_reliability,
        created_at,
        last_confirmed_at,
        last_used_at,
        superseded_by_id,
        merged_into_id,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      card.id,
      card.userId,
      card.sectionId,
      card.kind,
      card.slot,
      card.lifecycle,
      card.text,
      card.value ?? null,
      card.startsAt ?? null,
      card.eventAt ?? null,
      card.expiresAt ?? null,
      card.state,
      card.confidence,
      card.importance,
      card.confirmations,
      card.corrections,
      card.contradictions,
      card.helpfulHits,
      card.harmfulHits,
      card.sourceType,
      card.sourceReliability,
      card.createdAt,
      card.lastConfirmedAt,
      card.lastUsedAt ?? null,
      card.supersededById ?? null,
      card.mergedIntoId ?? null,
      card.metadataJson ?? null,
    );
    this.upsertFts(card);
  }

  private upsertFts(card: MemoryCard): void {
    this.requireDb().prepare("DELETE FROM memory_cards_fts WHERE card_id = ?").run(card.id);
    this.requireDb().prepare(`
      INSERT INTO memory_cards_fts (card_id, user_id, section_id, kind, slot, text, value)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      card.id,
      card.userId,
      card.sectionId,
      card.kind,
      card.slot,
      card.text,
      card.value ?? "",
    );
  }

  private createSchema(): void {
    this.requireDb().exec(`
      CREATE TABLE IF NOT EXISTS memory_cards (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        section_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        slot TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        text TEXT NOT NULL,
        value TEXT,
        starts_at TEXT,
        event_at TEXT,
        expires_at TEXT,
        state TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        confirmations INTEGER NOT NULL DEFAULT 0,
        corrections INTEGER NOT NULL DEFAULT 0,
        contradictions INTEGER NOT NULL DEFAULT 0,
        helpful_hits INTEGER NOT NULL DEFAULT 0,
        harmful_hits INTEGER NOT NULL DEFAULT 0,
        source_type TEXT NOT NULL,
        source_reliability REAL NOT NULL,
        created_at TEXT NOT NULL,
        last_confirmed_at TEXT NOT NULL,
        last_used_at TEXT,
        superseded_by_id TEXT,
        merged_into_id TEXT,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memory_cards_user_address
        ON memory_cards(user_id, section_id, kind, slot, state);
      CREATE INDEX IF NOT EXISTS idx_memory_cards_user_state
        ON memory_cards(user_id, section_id, state, confidence, last_confirmed_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_cards_fts USING fts5(
        card_id UNINDEXED,
        user_id UNINDEXED,
        section_id UNINDEXED,
        kind,
        slot,
        text,
        value
      );

      CREATE TABLE IF NOT EXISTS memory_evidence (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT,
        run_id TEXT,
        session_path TEXT,
        run_path TEXT,
        evidence_type TEXT NOT NULL,
        source_text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_evidence_memory
        ON memory_evidence(memory_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_usage (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        run_id TEXT,
        used_at TEXT NOT NULL,
        outcome TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_consolidation_jobs (
        job_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        session_path TEXT NOT NULL,
        handoff_summary TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memory_consolidation_jobs_status
        ON memory_consolidation_jobs(status, created_at);

      CREATE TABLE IF NOT EXISTS memory_snapshot (
        user_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        memory_ids_json TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );
    `);
  }

  private ensureCardSchemaColumns(): void {
    for (const column of [
      { name: "starts_at", ddl: "ALTER TABLE memory_cards ADD COLUMN starts_at TEXT" },
      { name: "event_at", ddl: "ALTER TABLE memory_cards ADD COLUMN event_at TEXT" },
      { name: "expires_at", ddl: "ALTER TABLE memory_cards ADD COLUMN expires_at TEXT" },
    ]) {
      if (!this.memoryCardsColumnExists(column.name)) {
        this.requireDb().exec(column.ddl);
      }
    }
  }

  private memoryCardsColumnExists(columnName: string): boolean {
    const rows = this.requireDb()
      .prepare("PRAGMA table_info(memory_cards)")
      .all() as Array<{ name?: string }>;
    return rows.some((row) => row.name === columnName);
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("PersonalMemoryStore not started");
    }
    return this.db;
  }

  private nowIso(): string {
    return this.nowProvider().toISOString();
  }
}

export function normalizeSlot(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9_/-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[/_]+|[/_]+$/g, "");
}

export function normalizeKind(value: string): string {
  const normalized = normalizeSlot(value).replace(/\//g, "_");
  return normalized || "general";
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

function defaultImportanceForSection(sectionId: MemorySectionId): number {
  if (sectionId === TIME_BASED_SECTION_ID) {
    return DEFAULT_TIMED_IMPORTANCE;
  }
  if (sectionId === EVOLVING_MEMORY_SECTION_ID) {
    return DEFAULT_EVOLVING_IMPORTANCE;
  }
  return DEFAULT_FACT_IMPORTANCE;
}

function lifecycleForSection(sectionId: MemorySectionId): MemoryCard["lifecycle"] {
  if (sectionId === TIME_BASED_SECTION_ID) {
    return "timed";
  }
  if (sectionId === EVOLVING_MEMORY_SECTION_ID) {
    return "evolving";
  }
  return "fact";
}

function defaultSourceReliability(sourceType: MemorySourceType): number {
  if (sourceType === "manual_user_request") return 0.98;
  if (sourceType === "explicit_user_statement") return 0.95;
  if (sourceType === "agent_observation") return 0.75;
  return 0.6;
}

function mapCardRow(row: Record<string, unknown>): MemoryCard {
  return {
    id: String(row["id"]),
    userId: String(row["user_id"]),
    sectionId: normalizeSectionId(row["section_id"]),
    kind: String(row["kind"]),
    slot: String(row["slot"]),
    lifecycle: row["lifecycle"] === "timed"
      ? "timed"
      : (row["lifecycle"] === "evolving" ? "evolving" : "fact"),
    text: String(row["text"]),
    value: nullableString(row["value"]),
    startsAt: nullableString(row["starts_at"]),
    eventAt: nullableString(row["event_at"]),
    expiresAt: nullableString(row["expires_at"]),
    state: normalizeState(row["state"]),
    confidence: Number(row["confidence"] ?? 0),
    importance: Number(row["importance"] ?? 0),
    confirmations: Number(row["confirmations"] ?? 0),
    corrections: Number(row["corrections"] ?? 0),
    contradictions: Number(row["contradictions"] ?? 0),
    helpfulHits: Number(row["helpful_hits"] ?? 0),
    harmfulHits: Number(row["harmful_hits"] ?? 0),
    sourceType: normalizeSourceType(row["source_type"]),
    sourceReliability: Number(row["source_reliability"] ?? 0.75),
    createdAt: String(row["created_at"]),
    lastConfirmedAt: String(row["last_confirmed_at"]),
    lastUsedAt: nullableString(row["last_used_at"]),
    supersededById: nullableString(row["superseded_by_id"]),
    mergedIntoId: nullableString(row["merged_into_id"]),
    metadataJson: nullableString(row["metadata_json"]),
  };
}

function mapEvidenceRow(row: Record<string, unknown>): MemoryEvidenceRecord {
  return {
    id: String(row["id"]),
    memoryId: String(row["memory_id"]),
    userId: String(row["user_id"]),
    sessionId: nullableString(row["session_id"]),
    runId: nullableString(row["run_id"]),
    sessionPath: nullableString(row["session_path"]),
    runPath: nullableString(row["run_path"]),
    evidenceType: normalizeEvidenceType(row["evidence_type"]),
    sourceText: String(row["source_text"]),
    createdAt: String(row["created_at"]),
  };
}

function mapJobRow(row: Record<string, unknown>): MemoryConsolidationJob {
  const status = row["status"] === "running" || row["status"] === "done" || row["status"] === "failed"
    ? row["status"]
    : "pending";
  return {
    jobId: String(row["job_id"]),
    userId: String(row["user_id"]),
    sessionId: String(row["session_id"]),
    sessionPath: String(row["session_path"]),
    handoffSummary: nullableString(row["handoff_summary"]),
    payloadJson: String(row["payload_json"]),
    status,
    attempts: Number(row["attempts"] ?? 0),
    createdAt: String(row["created_at"]),
    startedAt: nullableString(row["started_at"]),
    completedAt: nullableString(row["completed_at"]),
    lastError: nullableString(row["last_error"]),
  };
}

function normalizeState(value: unknown): MemoryState {
  if (
    value === "candidate" ||
    value === "active" ||
    value === "archived" ||
    value === "superseded" ||
    value === "merged" ||
    value === "expired" ||
    value === "rejected"
  ) {
    return value;
  }
  return "candidate";
}

function normalizeEvidenceType(value: unknown): MemoryEvidenceType {
  if (
    value === "creates" ||
    value === "confirms" ||
    value === "contradicts" ||
    value === "supersedes" ||
    value === "merges" ||
    value === "archives" ||
    value === "rejects"
  ) {
    return value;
  }
  return "creates";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function toFtsQuery(parts: string[]): string {
  const tokens = parts
    .join(" ")
    .toLowerCase()
    .replace(/[/-]/g, " ")
    .match(/[a-z0-9_]{3,}/g)
    ?.map((token) => token.replace(/[^a-z0-9_]/g, ""))
    .filter((token) => token.length > 0 && !STOPWORDS.has(token))
    .slice(0, 12) ?? [];
  return [...new Set(tokens)].map((token) => `${token}*`).join(" OR ");
}

function removableScore(card: MemoryCard): number {
  const score = scoreMemory(card).retentionScore;
  const stateBoost = card.state === "active" ? 0.15 : 0;
  const manualBoost = card.sourceType === "manual_user_request" ? 0.5 : 0;
  return score + stateBoost + manualBoost;
}

function timedRemovableScore(card: MemoryCard, now: Date): number {
  const base = scoreMemory(card).retentionScore;
  const expiresAt = card.expiresAt ? Date.parse(card.expiresAt) : NaN;
  if (!Number.isFinite(expiresAt)) {
    return base - 0.25;
  }
  const daysLeft = Math.max(0, (expiresAt - now.getTime()) / 86_400_000);
  const urgencyBoost = daysLeft <= 1 ? 0.25 : (daysLeft <= 7 ? 0.15 : 0);
  return base + urgencyBoost;
}

function isProtectedFact(card: MemoryCard): boolean {
  if (card.sourceType === "manual_user_request" && card.confidence >= 0.8) {
    return true;
  }
  if (card.state === "active" && card.confidence >= 0.8 && CORE_IDENTITY_SLOTS.has(card.slot)) {
    return true;
  }
  return false;
}

const CORE_IDENTITY_SLOTS = new Set([
  "identity/name",
  "identity/date_of_birth",
  "identity/mother_tongue",
]);

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
