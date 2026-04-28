import type { LlmMessage } from "../../core/contracts/llm-protocol.js";
import type { LlmProvider } from "../../core/contracts/provider.js";
import { formatConversationTurnInline } from "../conversation-turn-format.js";
import { devLog, devWarn } from "../../shared/index.js";
import { loadMemoryPolicy } from "./memory-policy.js";
import { MemoryResolver } from "./memory-resolver.js";
import type { PersonalMemoryStore } from "./personal-memory-store.js";
import type {
  MemoryCard,
  MemoryConsolidationJob,
  MemoryConsolidationJobPayload,
  MemoryPolicy,
  MemoryProposal,
  MemorySectionId,
  MemorySourceType,
} from "./types.js";
import { EVOLVING_MEMORY_SECTION_ID, TIME_BASED_SECTION_ID, USER_FACTS_SECTION_ID } from "./types.js";
import { ProfileProjector, type SnapshotProjectionResult } from "./profile-projector.js";

export interface MemoryConsolidatorOptions {
  provider: LlmProvider;
  store: PersonalMemoryStore;
  projectRoot: string;
  now?: () => Date;
  onSnapshotRegenerated?: (
    userId: string,
    snapshot: string,
    result: SnapshotProjectionResult,
  ) => void | Promise<void>;
}

export class MemoryConsolidator {
  private readonly provider: LlmProvider;
  private readonly store: PersonalMemoryStore;
  private readonly resolver: MemoryResolver;
  private readonly projectRoot: string;
  private readonly nowProvider: () => Date;
  private readonly onSnapshotRegenerated?: (
    userId: string,
    snapshot: string,
    result: SnapshotProjectionResult,
  ) => void | Promise<void>;
  private processingPromise: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(options: MemoryConsolidatorOptions) {
    this.provider = options.provider;
    this.store = options.store;
    this.resolver = new MemoryResolver(options.store);
    this.projectRoot = options.projectRoot;
    this.nowProvider = options.now ?? (() => new Date());
    this.onSnapshotRegenerated = options.onSnapshotRegenerated;
  }

  enqueueSession(payload: MemoryConsolidationJobPayload): string {
    const jobId = this.store.enqueueConsolidationJob(payload, this.nowIso());
    this.scheduleProcessing();
    return jobId;
  }

  scheduleProcessing(): void {
    if (this.processingPromise || this.shuttingDown) {
      return;
    }
    this.processingPromise = this.processJobs()
      .catch((err) => devWarn("Personal memory worker failed:", err instanceof Error ? err.message : String(err)))
      .finally(() => {
        this.processingPromise = null;
        if (!this.shuttingDown && this.store.hasPendingJobs()) {
          this.scheduleProcessing();
        }
      });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.processingPromise;
  }

  private async processJobs(): Promise<void> {
    while (true) {
      const job = this.store.claimNextJob();
      if (!job) {
        return;
      }
      try {
        await this.processJob(job);
        this.store.markJobDone(job.jobId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.store.markJobFailed(job.jobId, message);
        this.store.writeAuditEvent({
          jobId: job.jobId,
          userId: job.userId,
          sessionId: job.sessionId,
          event: "job_failed",
          reason: message,
        });
        devWarn(`Personal memory job failed jobId=${job.jobId}: ${message}`);
      }
    }
  }

  private async processJob(job: MemoryConsolidationJob): Promise<void> {
    const payload = JSON.parse(job.payloadJson) as MemoryConsolidationJobPayload;
    const policy = loadMemoryPolicy(this.projectRoot);
    this.store.writeAuditEvent({
      jobId: job.jobId,
      userId: job.userId,
      sessionId: job.sessionId,
      event: "job_started",
      reason: payload.reason,
    });

    const facts = await this.processSection(job, payload, policy, USER_FACTS_SECTION_ID);
    const timed = await this.processSection(job, payload, policy, TIME_BASED_SECTION_ID);
    const evolving = await this.processSection(job, payload, policy, EVOLVING_MEMORY_SECTION_ID);
    const pruned = this.store.archiveExpiredAndPrune(job.userId, this.nowProvider(), policy);
    this.store.writeAuditEvent({
      jobId: job.jobId,
      userId: job.userId,
      sessionId: job.sessionId,
      event: "decay_prune_done",
      details: { archived: pruned },
    });
    const snapshotResult = await new ProfileProjector({
      projectRoot: this.projectRoot,
      userId: job.userId,
      now: this.nowProvider,
    }).regenerate(this.store);
    await this.onSnapshotRegenerated?.(job.userId, snapshotResult.content, snapshotResult);
    this.store.writeAuditEvent({
      jobId: job.jobId,
      userId: job.userId,
      sessionId: job.sessionId,
      event: "snapshot_regenerated",
      details: {
        eligible: snapshotResult.eligibleCount,
        injected: snapshotResult.injectedCount,
        truncated: snapshotResult.truncated,
        sectionCounts: snapshotResult.sectionCounts,
      },
    });

    devLog(
      `Personal memory evolved session=${job.sessionId} created=${facts.created + timed.created + evolving.created} confirmed=${facts.confirmed + timed.confirmed + evolving.confirmed} superseded=${facts.superseded + timed.superseded + evolving.superseded} archived=${facts.archived + timed.archived + evolving.archived + pruned} rejected=${facts.rejected + timed.rejected + evolving.rejected}`,
    );
    this.store.writeAuditEvent({
      jobId: job.jobId,
      userId: job.userId,
      sessionId: job.sessionId,
      event: "job_done",
      details: {
        userFacts: facts,
        timeBased: timed,
        evolvingMemory: evolving,
        pruned,
      },
    });
  }

  private async processSection(
    job: MemoryConsolidationJob,
    payload: MemoryConsolidationJobPayload,
    policy: MemoryPolicy,
    sectionId: MemorySectionId,
  ): Promise<ReturnType<MemoryResolver["resolve"]>> {
    this.store.writeAuditEvent({
      jobId: job.jobId,
      userId: job.userId,
      sessionId: job.sessionId,
      sectionId,
      event: "section_started",
    });
    const output = await this.provider.generateTurn({
      messages: this.buildSectionMessages(payload, policy, sectionId),
      responseFormat: this.provider.capabilities.structuredOutput?.jsonObject ? { type: "json_object" } : undefined,
    });
    if (output.type !== "assistant" || !output.content) {
      throw new Error(`Personal memory ${sectionId} evolution returned no assistant JSON`);
    }

    const proposals = parseProposals(output.content, policy)
      .filter((proposal) => proposal.sectionId === sectionId);
    this.store.writeAuditEvent({
      jobId: job.jobId,
      userId: job.userId,
      sessionId: job.sessionId,
      sectionId,
      event: "llm_actions_proposed",
      details: {
        count: proposals.length,
        slots: proposals.map((proposal) => proposal.slot),
      },
    });
    for (const proposal of proposals) {
      this.store.writeAuditEvent({
        jobId: job.jobId,
        userId: job.userId,
        sessionId: job.sessionId,
        sectionId,
        event: "action_proposed",
        action: "upsert",
        slot: proposal.slot,
        details: {
          type: proposal.kind,
          confidence: proposal.confidence,
          importance: proposal.importance,
        },
      });
    }
    const result = this.resolver.resolve(job.userId, payload, proposals, policy, this.nowIso());
    this.store.writeAuditEvent({
      jobId: job.jobId,
      userId: job.userId,
      sessionId: job.sessionId,
      sectionId,
      event: "section_done",
      details: { ...result },
    });
    return result;
  }

  private buildSectionMessages(
    payload: MemoryConsolidationJobPayload,
    policy: MemoryPolicy,
    sectionId: MemorySectionId,
  ): LlmMessage[] {
    const existing = this.store.listMemories(
      payload.userId,
      ["candidate", "active"],
      existingLimitForSection(sectionId, policy),
      sectionId,
    ).map(formatMemoryForPrompt).join("\n");
    const turns = payload.turns
      .slice(-policy.extraction.maxTurns)
      .map((turn) => formatConversationTurnInline({
        role: turn.role,
        content: turn.content,
        timestamp: turn.timestamp,
        sessionPath: turn.sessionPath,
        runId: turn.runId,
      }))
      .join("\n\n");

    const userContent = [
      `Current time: ${this.nowIso()}`,
      "",
      `## Existing ${sectionTitle(sectionId)}`,
      existing || "(none)",
      "",
      "## Session Handoff Summary",
      payload.handoffSummary?.trim() || "(none)",
      "",
      "## Session Conversation",
      turns || "(none)",
      "",
      "Return JSON with this exact shape:",
      JSON.stringify({ cards: [exampleCardForSection(sectionId)] }, null, 2),
    ].join("\n");

    return [
      { role: "system", content: systemPromptForSection(sectionId) },
      { role: "user", content: userContent },
    ];
  }

  private nowIso(): string {
    return this.nowProvider().toISOString();
  }
}

const USER_FACTS_SYSTEM_PROMPT = `You are Ayati's user_facts memory evolution worker.

Extract only stable identity-style facts that usually do not change: preferred name, broad location, timezone, languages, birth date, and stable important people.
Reject preferences, goals, projects, routines, feedback, permissions, and temporary context.
Prefer explicit user statements. Do not store weak inference.
If a direct correction changes an existing slot, return the corrected card with the same slot; the resolver will supersede the old card.
Use type/kind "identity" for most cards. Use lowercase slash-style slots such as identity/name, identity/mother_tongue, identity/location, identity/timezone.
Return only valid JSON. If nothing useful exists, return {"cards":[]}.`;

const TIME_BASED_SYSTEM_PROMPT = `You are Ayati's time_based memory evolution worker.

Extract only personal context useful until a specific date/time: exams, meetings, appointments, deadlines, trips, temporary locations, and dated events.
Every time_based card must include sectionId "time_based", lifecycle "timed", and a valid expiresAt ISO datetime.
Use eventAt when the event time is known. If only a date is known, expire at the end of that date in the user's apparent timezone.
Reject vague future context without a resolvable expiry; it belongs in evolving_memory only if it is useful.
If a date/time changes, return the corrected card with the same slot; the resolver will supersede the old card.
Return only valid JSON. If nothing useful exists, return {"cards":[]}.`;

const EVOLVING_SYSTEM_PROMPT = `You are Ayati's evolving_memory candidate extraction worker.

Extract adaptive personalization memories that can evolve or decay. Supported types are preference, goal, current_project, skill, environment, constraint, procedural, feedback, routine, decision, relationship, and permission.
Do not store stable identity facts or exact dated events here.
Use sectionId "evolving_memory" and lifecycle "evolving".
Use type as the memory category; kind is accepted as an alias. Use content as the memory sentence; text is accepted as an alias.
Create normalized slots that prevent duplicates, such as preference/answer_depth, goal/project/personal_ai_agent, current_project/memory_system, skill/language/typescript, environment/tool/aws_ec2, constraint/budget, procedural/architecture_explanations, permission/email_sending.
For decay, choose a bounded decay object with curve stable, linear, exponential, delayed_drop, or super_fast. Current projects usually use delayed_drop. Strong constraints, permissions, and procedural rules usually use stable.
Return only candidate cards. The code will retrieve related existing memories, dedupe, update, merge, or reject. If nothing useful exists, return {"cards":[]}.`;

function systemPromptForSection(sectionId: MemorySectionId): string {
  if (sectionId === TIME_BASED_SECTION_ID) return TIME_BASED_SYSTEM_PROMPT;
  if (sectionId === EVOLVING_MEMORY_SECTION_ID) return EVOLVING_SYSTEM_PROMPT;
  return USER_FACTS_SYSTEM_PROMPT;
}

function existingLimitForSection(sectionId: MemorySectionId, policy: MemoryPolicy): number {
  if (sectionId === TIME_BASED_SECTION_ID) return policy.extraction.maxExistingTimed;
  if (sectionId === EVOLVING_MEMORY_SECTION_ID) return policy.extraction.maxExistingEvolving;
  return policy.extraction.maxExistingFacts;
}

function sectionTitle(sectionId: MemorySectionId): string {
  if (sectionId === TIME_BASED_SECTION_ID) return "Time-Based Memories";
  if (sectionId === EVOLVING_MEMORY_SECTION_ID) return "Evolving Memories";
  return "User Facts";
}

function formatMemoryForPrompt(memory: MemoryCard): string {
  return [
    `- id=${memory.id}`,
    `section=${memory.sectionId}`,
    `type=${memory.kind}`,
    `slot=${memory.slot}`,
    `state=${memory.state}`,
    `confidence=${memory.confidence}`,
    `importance=${memory.importance}`,
    memory.eventAt ? `eventAt=${memory.eventAt}` : "",
    memory.expiresAt ? `expiresAt=${memory.expiresAt}` : "",
    `content=${memory.text}`,
  ].filter(Boolean).join(" ");
}

function exampleCardForSection(sectionId: MemorySectionId): Record<string, unknown> {
  if (sectionId === TIME_BASED_SECTION_ID) {
    return {
      sectionId: "time_based",
      lifecycle: "timed",
      type: "event",
      slot: "education/exam",
      content: "User has an exam on May 20, 2026.",
      eventAt: "2026-05-20T09:00:00.000Z",
      expiresAt: "2026-05-20T23:59:59.000Z",
      confidence: 0.86,
      importance: 0.9,
      source_type: "explicit_user_statement",
      source_reliability: 0.95,
      evidence: "User said they have an exam on May 20, 2026.",
    };
  }
  if (sectionId === EVOLVING_MEMORY_SECTION_ID) {
    return {
      sectionId: "evolving_memory",
      lifecycle: "evolving",
      type: "preference",
      slot: "preference/answer_depth",
      content: "User prefers detailed practical explanations over shallow answers.",
      confidence: 0.85,
      importance: 0.85,
      decay: {
        curve: "linear",
        graceDays: 14,
        halfLifeDays: 120,
        pressureSensitivity: 0.5,
        contextThreshold: 0.45,
        archiveThreshold: 0.18,
      },
      source_type: "explicit_user_statement",
      source_reliability: 0.95,
      evidence: "User asked for full implementation details.",
    };
  }
  return {
    sectionId: "user_facts",
    lifecycle: "fact",
    type: "identity",
    slot: "identity/name",
    content: "User's name is Sai.",
    value: "Sai",
    confidence: 0.85,
    importance: 1,
    source_type: "explicit_user_statement",
    source_reliability: 0.95,
    evidence: "User said: my name is Sai.",
  };
}

function parseProposals(raw: string, policy: MemoryPolicy): MemoryProposal[] {
  const parsed = parseJson(raw);
  const cards = Array.isArray(parsed?.["cards"])
    ? parsed["cards"] as unknown[]
    : (Array.isArray(parsed?.["proposals"])
      ? parsed["proposals"] as unknown[]
      : (Array.isArray(parsed?.["candidates"])
        ? parsed["candidates"] as unknown[]
        : (Array.isArray(parsed?.["actions"]) ? parsed["actions"] as unknown[] : [])));
  return cards
    .map(normalizeProposal)
    .filter((proposal): proposal is MemoryProposal => proposal !== null)
    .slice(0, policy.extraction.maxProposals);
}

function parseJson(raw: string): Record<string, unknown> | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeProposal(raw: unknown): MemoryProposal | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const text = asString(value["text"]) ?? asString(value["content"]);
  const kind = asString(value["kind"]) ?? asString(value["type"]);
  const slot = asString(value["slot"]);
  const evidence = asString(value["evidence"]);
  if (!text || !kind || !slot || !evidence) {
    return null;
  }
  const sourceType = normalizeSourceType(value["source_type"] ?? value["sourceType"]);
  const sectionId = normalizeSectionId(value["sectionId"] ?? value["section_id"]);
  return {
    text,
    sectionId,
    lifecycle: lifecycleForSection(sectionId),
    kind,
    slot,
    value: asString(value["value"]),
    startsAt: asString(value["startsAt"]) ?? asString(value["starts_at"]),
    eventAt: asString(value["eventAt"]) ?? asString(value["event_at"]),
    expiresAt: asString(value["expiresAt"]) ?? asString(value["expires_at"]),
    confidence: clampNumber(value["confidence"] ?? value["base_confidence"] ?? value["baseConfidence"], 0.75, 0, 1),
    importance: clampNumber(value["importance"], 0.7, 0, 1),
    sourceType,
    sourceReliability: clampNumber(value["source_reliability"] ?? value["sourceReliability"], 0.8, 0, 1),
    evidence,
    reasoning: asString(value["reasoning"]) ?? undefined,
    decay: (objectValue(value["decay"]) as MemoryProposal["decay"]) ?? undefined,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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
  if (value === TIME_BASED_SECTION_ID) return TIME_BASED_SECTION_ID;
  if (value === EVOLVING_MEMORY_SECTION_ID) return EVOLVING_MEMORY_SECTION_ID;
  return USER_FACTS_SECTION_ID;
}

function lifecycleForSection(sectionId: MemorySectionId): MemoryProposal["lifecycle"] {
  if (sectionId === TIME_BASED_SECTION_ID) return "timed";
  if (sectionId === EVOLVING_MEMORY_SECTION_ID) return "evolving";
  return "fact";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}
