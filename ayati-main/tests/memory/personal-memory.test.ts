import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import { DEFAULT_MEMORY_POLICY, loadMemoryPolicy } from "../../src/memory/personal/memory-policy.js";
import { MemoryConsolidator } from "../../src/memory/personal/memory-consolidator.js";
import { MemoryResolver } from "../../src/memory/personal/memory-resolver.js";
import { scoreMemory } from "../../src/memory/personal/memory-scorer.js";
import { PersonalMemoryStore } from "../../src/memory/personal/personal-memory-store.js";
import { PersonalMemorySnapshotCache } from "../../src/memory/personal/personal-memory-snapshot-cache.js";
import { PERSONAL_MEMORY_SNAPSHOT_LINE_LIMIT, ProfileProjector } from "../../src/memory/personal/profile-projector.js";
import type { MemoryPolicy, MemoryProposal } from "../../src/memory/personal/types.js";
import { EVOLVING_MEMORY_SECTION_ID, TIME_BASED_SECTION_ID } from "../../src/memory/personal/types.js";

function makeStore(root: string): PersonalMemoryStore {
  const store = new PersonalMemoryStore({
    dataDir: resolve(root, "data", "memory"),
    now: () => new Date("2026-04-24T00:00:00.000Z"),
  });
  store.start(DEFAULT_MEMORY_POLICY);
  return store;
}

function proposal(overrides?: Partial<MemoryProposal>): MemoryProposal {
  return {
    text: "User's name is Sai.",
    kind: "identity",
    slot: "identity/name",
    value: "Sai",
    confidence: 0.9,
    importance: 1,
    sourceType: "explicit_user_statement",
    sourceReliability: 0.95,
    evidence: "User said their name is Sai.",
    ...overrides,
  };
}

function timedProposal(overrides?: Partial<MemoryProposal>): MemoryProposal {
  return {
    sectionId: TIME_BASED_SECTION_ID,
    lifecycle: "timed",
    text: "User has an exam on May 20, 2026.",
    kind: "exam",
    slot: "education/exam",
    value: "exam",
    eventAt: "2026-05-20T09:00:00.000+05:30",
    expiresAt: "2026-05-20T23:59:59.000+05:30",
    confidence: 0.86,
    importance: 0.9,
    sourceType: "explicit_user_statement",
    sourceReliability: 0.95,
    evidence: "User said they have an exam on May 20, 2026.",
    ...overrides,
  };
}

function evolvingProposal(overrides?: Partial<MemoryProposal>): MemoryProposal {
  return {
    sectionId: EVOLVING_MEMORY_SECTION_ID,
    lifecycle: "evolving",
    text: "User prefers detailed practical explanations over shallow answers.",
    kind: "preference",
    slot: "preference/answer_depth",
    value: "detailed practical explanations",
    confidence: 0.86,
    importance: 0.9,
    sourceType: "explicit_user_statement",
    sourceReliability: 0.95,
    evidence: "User asked for full detailed explanations.",
    decay: {
      curve: "linear",
      graceDays: 14,
      halfLifeDays: 120,
      pressureSensitivity: 0.5,
      contextThreshold: 0.45,
      archiveThreshold: 0.18,
    },
    ...overrides,
  };
}

function payload(sessionId: string) {
  return {
    userId: "local",
    sessionId,
    sessionPath: `sessions/${sessionId}.md`,
    reason: "test",
    turns: [],
  };
}

function policy(
  userFactOverrides?: Partial<MemoryPolicy["sections"]["userFacts"]>,
  timeBasedOverrides?: Partial<MemoryPolicy["sections"]["timeBased"]>,
  evolvingOverrides?: Partial<MemoryPolicy["sections"]["evolvingMemory"]>,
): MemoryPolicy {
  return {
    ...DEFAULT_MEMORY_POLICY,
    sections: {
      userFacts: {
        ...DEFAULT_MEMORY_POLICY.sections.userFacts,
        ...userFactOverrides,
      },
      timeBased: {
        ...DEFAULT_MEMORY_POLICY.sections.timeBased,
        ...timeBasedOverrides,
      },
      evolvingMemory: {
        ...DEFAULT_MEMORY_POLICY.sections.evolvingMemory,
        ...evolvingOverrides,
      },
    },
  };
}

function makeProvider(content: string): LlmProvider {
  return {
    name: "fake",
    version: "1",
    capabilities: { nativeToolCalling: false, structuredOutput: { jsonObject: true, jsonSchema: false } },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi.fn(async () => ({ type: "assistant", content })),
  };
}

describe("Personal memory policy", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads the section-based policy shape", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-memory-policy-"));
    roots.push(root);
    mkdirSync(resolve(root, "context"), { recursive: true });
    writeFileSync(resolve(root, "context", "memory-policy.json"), JSON.stringify({
      sections: {
        userFacts: {
          maxLiveCards: 12,
          minActiveConfidence: 0.82,
          admissionMargin: 0.2,
          allowInferredFacts: true,
        },
        timeBased: {
          maxLiveCards: 8,
          minActiveConfidence: 0.7,
          admissionMargin: 0.15,
        },
        evolvingMemory: {
          maxLiveCards: 120,
          minActiveConfidence: 0.68,
          admissionMargin: 0.05,
          defaultContextThreshold: 0.4,
          defaultArchiveThreshold: 0.12,
          pressureStartsAtRatio: 0.7,
          decay: {
            superFast: {
              graceDays: 1,
              halfLifeDays: 3,
              pressureSensitivity: 0.9,
              contextThreshold: 0.42,
              archiveThreshold: 0.11,
            },
          },
        },
      },
      extraction: {
        maxTurns: 20,
        maxExistingFacts: 15,
        maxExistingTimed: 6,
        maxExistingEvolving: 10,
        maxProposals: 4,
      },
    }));

    expect(loadMemoryPolicy(root)).toEqual({
      sections: {
        userFacts: {
          maxLiveCards: 12,
          minActiveConfidence: 0.82,
          admissionMargin: 0.2,
          allowInferredFacts: true,
        },
        timeBased: {
          maxLiveCards: 8,
          minActiveConfidence: 0.7,
          admissionMargin: 0.15,
        },
        evolvingMemory: {
          ...DEFAULT_MEMORY_POLICY.sections.evolvingMemory,
          maxLiveCards: 120,
          minActiveConfidence: 0.68,
          admissionMargin: 0.05,
          defaultContextThreshold: 0.4,
          defaultArchiveThreshold: 0.12,
          pressureStartsAtRatio: 0.7,
          decay: {
            ...DEFAULT_MEMORY_POLICY.sections.evolvingMemory.decay,
            superFast: {
              ...DEFAULT_MEMORY_POLICY.sections.evolvingMemory.decay.superFast,
              graceDays: 1,
              halfLifeDays: 3,
              pressureSensitivity: 0.9,
              contextThreshold: 0.42,
              archiveThreshold: 0.11,
            },
          },
        },
      },
      extraction: {
        maxTurns: 20,
        maxExistingFacts: 15,
        maxExistingTimed: 6,
        maxExistingEvolving: 10,
        maxProposals: 4,
      },
    });
  });

  it("falls back to the default policy when the file is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-memory-policy-"));
    roots.push(root);

    expect(loadMemoryPolicy(root)).toEqual(DEFAULT_MEMORY_POLICY);
  });

  it("ignores legacy slot-pack, staging, budget, and promotion fields", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-memory-policy-"));
    roots.push(root);
    mkdirSync(resolve(root, "context"), { recursive: true });
    writeFileSync(resolve(root, "context", "memory-policy.json"), JSON.stringify({
      enabledSlotPacks: ["core_identity"],
      disabledSlotPacks: ["finance"],
      staging: {
        allowUnknownSlots: true,
        autoPromoteAfterSessions: 1,
      },
      memoryBudget: {
        maxUserFacts: 2,
        maxTimeBased: 3,
        maxActiveMemories: 5,
      },
      slotPromotion: {
        enabled: true,
        minSessions: 1,
      },
    }));

    expect(loadMemoryPolicy(root)).toEqual(DEFAULT_MEMORY_POLICY);
  });
});

describe("User Facts personal memory section", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0, roots.length)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scores user facts without passive time decay", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-user-facts-"));
    roots.push(root);
    const store = makeStore(root);
    const memory = store.createCard({
      userId: "local",
      kind: "identity",
      slot: "identity/date_of_birth",
      text: "User's date of birth is 1999-08-05.",
      value: "1999-08-05",
      state: "active",
      confidence: 0.95,
      importance: 1,
      sourceType: "explicit_user_statement",
      sourceReliability: 0.95,
      createdAt: "2020-01-01T00:00:00.000Z",
    });

    const score = scoreMemory(memory, new Date("2026-04-24T00:00:00.000Z"));

    expect(score.freshness).toBe(1);
    expect(score.currentConfidence).toBeGreaterThan(0.4);
    store.stop();
  });

  it("confirms the same kind and slot instead of creating duplicates", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-user-facts-"));
    roots.push(root);
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);

    const first = resolver.resolve("local", payload("s1"), [proposal()], DEFAULT_MEMORY_POLICY);
    const second = resolver.resolve("local", payload("s2"), [proposal({
      text: "User's name is Sai.",
      evidence: "User repeated that their name is Sai.",
    })], DEFAULT_MEMORY_POLICY);
    const memories = store.findCardsByAddress("local", "identity", "identity/name", ["active"]);

    expect(first.created).toBe(1);
    expect(second.confirmed).toBe(1);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.confirmations).toBe(1);
    expect(memories[0]?.confidence).toBeGreaterThan(0.9);
    store.stop();
  });

  it("supersedes a single-value fact when strong explicit evidence changes it", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-user-facts-"));
    roots.push(root);
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);

    resolver.resolve("local", payload("s1"), [proposal()], DEFAULT_MEMORY_POLICY);
    const result = resolver.resolve("local", payload("s2"), [proposal({
      text: "User's name is Sai Eshwar.",
      value: "Sai Eshwar",
      evidence: "User said their full name is Sai Eshwar.",
    })], DEFAULT_MEMORY_POLICY);
    const memories = store.findMemoriesBySlot("local", "identity/name", ["active", "superseded"]);

    expect(result.superseded).toBe(1);
    expect(memories.some((memory) => memory.state === "superseded" && memory.text.includes("Sai."))).toBe(true);
    expect(memories.some((memory) => memory.state === "active" && memory.text.includes("Sai Eshwar"))).toBe(true);
    store.stop();
  });

  it("keeps multi-value relationship facts instead of superseding friends", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-user-facts-"));
    roots.push(root);
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);

    resolver.resolve("local", payload("s1"), [proposal({
      kind: "relationship",
      slot: "relationships/friends",
      text: "User's friend is Rahul.",
      value: "Rahul",
      importance: 0.65,
      evidence: "User said Rahul is their friend.",
    })], DEFAULT_MEMORY_POLICY);
    const result = resolver.resolve("local", payload("s2"), [proposal({
      kind: "relationship",
      slot: "relationships/friends",
      text: "User's friend is Arjun.",
      value: "Arjun",
      importance: 0.65,
      evidence: "User said Arjun is their friend.",
    })], DEFAULT_MEMORY_POLICY);

    expect(result.created).toBe(1);
    expect(store.findMemoriesBySlot("local", "relationships/friends", ["active"])).toHaveLength(2);
    store.stop();
  });

  it("rejects inferred facts by default", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-user-facts-"));
    roots.push(root);
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);

    const result = resolver.resolve("local", payload("s1"), [proposal({
      sourceType: "inferred",
      confidence: 0.6,
      sourceReliability: 0.6,
      text: "User's city is Hyderabad.",
      kind: "identity",
      slot: "identity/current_city",
      value: "Hyderabad",
      evidence: "The assistant inferred this from conversation context.",
    })], DEFAULT_MEMORY_POLICY);

    expect(result.rejected).toBe(1);
    expect(store.listMemories("local", ["candidate", "active"])).toHaveLength(0);
    store.stop();
  });

  it("lowers confidence on weak contradictions instead of replacing facts", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-user-facts-"));
    roots.push(root);
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);

    resolver.resolve("local", payload("s1"), [proposal({
      text: "User's mother tongue is Telugu.",
      kind: "identity",
      slot: "identity/mother_tongue",
      value: "Telugu",
      importance: 0.9,
      evidence: "User said their mother tongue is Telugu.",
    })], DEFAULT_MEMORY_POLICY);
    const result = resolver.resolve("local", payload("s2"), [proposal({
      text: "User's mother tongue is Hindi.",
      kind: "identity",
      slot: "identity/mother_tongue",
      value: "Hindi",
      confidence: 0.55,
      importance: 0.9,
      sourceType: "agent_observation",
      sourceReliability: 0.7,
      evidence: "Assistant observed Hindi in a message.",
    })], DEFAULT_MEMORY_POLICY);
    const [memory] = store.findMemoriesBySlot("local", "identity/mother_tongue", ["active"]);

    expect(result.rejected).toBe(1);
    expect(memory?.value).toBe("Telugu");
    expect(memory?.contradictions).toBe(1);
    expect(memory?.confidence).toBeLessThan(0.9);
    store.stop();
  });

  it("archives the weakest removable fact when the section is full", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-user-facts-"));
    roots.push(root);
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);
    const smallPolicy = policy({ maxLiveCards: 2 });

    resolver.resolve("local", payload("s1"), [proposal({
      kind: "general",
      slot: "general/weak_one",
      text: "User once mentioned a weak stable fact one.",
      value: "one",
      confidence: 0.45,
      importance: 0.2,
      evidence: "Weak fact one.",
    })], smallPolicy);
    resolver.resolve("local", payload("s2"), [proposal({
      kind: "general",
      slot: "general/weak_two",
      text: "User once mentioned a weak stable fact two.",
      value: "two",
      confidence: 0.5,
      importance: 0.25,
      evidence: "Weak fact two.",
    })], smallPolicy);
    const result = resolver.resolve("local", payload("s3"), [proposal({
      kind: "identity",
      slot: "identity/mother_tongue",
      text: "User's mother tongue is Telugu.",
      value: "Telugu",
      confidence: 0.9,
      importance: 0.9,
      evidence: "User said their mother tongue is Telugu.",
    })], smallPolicy);

    expect(result.created).toBe(1);
    expect(result.archived).toBe(1);
    expect(store.countLiveCards("local")).toBe(2);
    expect(store.searchMemories("local", { query: "weak", states: ["archived"], limit: 10 })).toHaveLength(1);
    store.stop();
  });

  it("rejects weak new facts when the full section has no weaker removable fact", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-user-facts-"));
    roots.push(root);
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);
    const smallPolicy = policy({ maxLiveCards: 2 });

    resolver.resolve("local", payload("s1"), [proposal()], smallPolicy);
    resolver.resolve("local", payload("s2"), [proposal({
      kind: "identity",
      slot: "identity/date_of_birth",
      text: "User's date of birth is 1999-08-05.",
      value: "1999-08-05",
      evidence: "User said their date of birth is 1999-08-05.",
    })], smallPolicy);
    const result = resolver.resolve("local", payload("s3"), [proposal({
      kind: "general",
      slot: "general/minor_fact",
      text: "User mentioned a minor stable fact.",
      value: "minor",
      confidence: 0.55,
      importance: 0.2,
      evidence: "User mentioned a minor stable fact.",
    })], smallPolicy);

    expect(result.rejected).toBe(1);
    expect(store.countLiveCards("local")).toBe(2);
    store.stop();
  });

  it("uses FTS5 search to find likely duplicate facts", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-user-facts-"));
    roots.push(root);
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);

    resolver.resolve("local", payload("s1"), [proposal({
      kind: "identity",
      slot: "identity/mother_tongue",
      text: "User's mother tongue is Telugu.",
      value: "Telugu",
      importance: 0.9,
      evidence: "User said their mother tongue is Telugu.",
    })], DEFAULT_MEMORY_POLICY);

    const matches = store.searchMemories("local", { query: "native language Telugu", limit: 10 });

    expect(matches.map((memory) => memory.slot)).toContain("identity/mother_tongue");
    store.stop();
  });

  it("ignores legacy personal_memories rows during startup", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-legacy-personal-memory-"));
    roots.push(root);
    const dataDir = resolve(root, "data", "memory");
    mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(resolve(dataDir, "personal.sqlite"));
    db.exec(`
      CREATE TABLE personal_memories (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        slot TEXT,
        content TEXT,
        state TEXT,
        memory_class TEXT,
        base_confidence REAL,
        importance REAL,
        source_type TEXT,
        source_reliability REAL,
        confirmations INTEGER,
        contradictions INTEGER,
        created_at TEXT
      );
    `);
    db.prepare(`
      INSERT INTO personal_memories (
        id,
        user_id,
        slot,
        content,
        state,
        memory_class,
        base_confidence,
        importance,
        source_type,
        source_reliability,
        confirmations,
        contradictions,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "old_1",
      "local",
      "identity/name",
      "User's name is Sai.",
      "stable",
      "immutable",
      0.95,
      1,
      "explicit_user_statement",
      0.95,
      3,
      0,
      "2025-01-01T00:00:00.000Z",
    );
    db.close();

    const store = makeStore(root);

    expect(store.countLiveCards("local")).toBe(0);
    expect(store.listMemories("local", ["candidate", "active"])).toHaveLength(0);
    store.stop();
  });

  it("creates active time-based memories only when expiresAt is valid", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-time-based-"));
    roots.push(root);
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);

    const created = resolver.resolve("local", payload("s1"), [timedProposal()], DEFAULT_MEMORY_POLICY);
    const rejected = resolver.resolve("local", payload("s2"), [timedProposal({
      slot: "travel/vacation",
      text: "User is going on vacation next week.",
      eventAt: null,
      expiresAt: null,
      evidence: "User said they are going on vacation next week.",
    })], DEFAULT_MEMORY_POLICY);
    const timed = store.listMemories("local", ["active"], 10, TIME_BASED_SECTION_ID);

    expect(created.created).toBe(1);
    expect(rejected.rejected).toBe(1);
    expect(timed).toHaveLength(1);
    expect(timed[0]?.lifecycle).toBe("timed");
    expect(timed[0]?.expiresAt).toBe("2026-05-20T18:29:59.000Z");
    store.stop();
  });

  it("expires time-based memories after their expiry time", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-time-based-"));
    roots.push(root);
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);

    resolver.resolve("local", payload("s1"), [timedProposal({
      text: "User has a meeting on April 24, 2026.",
      kind: "meeting",
      slot: "calendar/meeting",
      eventAt: "2026-04-24T09:00:00.000Z",
      expiresAt: "2026-04-24T10:00:00.000Z",
      confidence: 0.9,
      importance: 0.7,
      evidence: "User said they have a meeting on April 24, 2026.",
    })], DEFAULT_MEMORY_POLICY, "2026-04-24T00:00:00.000Z");

    const expired = store.expireTimedCards("local", new Date("2026-04-24T11:00:00.000Z"));

    expect(expired).toBe(1);
    expect(store.listMemories("local", ["active"], 10, TIME_BASED_SECTION_ID)).toHaveLength(0);
    expect(store.listMemories("local", ["expired"], 10, TIME_BASED_SECTION_ID)).toHaveLength(1);
    store.stop();
  });

  it("confirms duplicate time-based memories with the same slot and day", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-time-based-"));
    roots.push(root);
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);

    resolver.resolve("local", payload("s1"), [timedProposal()], DEFAULT_MEMORY_POLICY);
    const result = resolver.resolve("local", payload("s2"), [timedProposal({
      text: "User's exam is on May 20, 2026.",
      evidence: "User repeated that the exam is on May 20, 2026.",
    })], DEFAULT_MEMORY_POLICY);
    const memories = store.findCardsByAddress(
      "local",
      "exam",
      "education/exam",
      ["active"],
      TIME_BASED_SECTION_ID,
    );

    expect(result.confirmed).toBe(1);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.confirmations).toBe(1);
    store.stop();
  });

  it("supersedes a time-based memory when the event date changes", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-time-based-"));
    roots.push(root);
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);

    resolver.resolve("local", payload("s1"), [timedProposal()], DEFAULT_MEMORY_POLICY);
    const result = resolver.resolve("local", payload("s2"), [timedProposal({
      text: "User's exam moved to May 22, 2026.",
      eventAt: "2026-05-22T09:00:00.000+05:30",
      expiresAt: "2026-05-22T23:59:59.000+05:30",
      evidence: "User said the exam moved to May 22, 2026.",
    })], DEFAULT_MEMORY_POLICY);
    const memories = store.findCardsByAddress(
      "local",
      "exam",
      "education/exam",
      ["active", "superseded"],
      TIME_BASED_SECTION_ID,
    );

    expect(result.superseded).toBe(1);
    expect(memories.some((memory) => memory.state === "superseded")).toBe(true);
    expect(memories.some((memory) => memory.state === "active" && memory.text.includes("May 22"))).toBe(true);
    store.stop();
  });

  it("archives the weakest timed memory when the time-based section is full", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-time-based-"));
    roots.push(root);
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);
    const smallPolicy = policy(undefined, { maxLiveCards: 2 });

    resolver.resolve("local", payload("s1"), [timedProposal({
      kind: "travel",
      slot: "travel/minor_trip",
      text: "User may take a minor trip next month.",
      value: "minor trip",
      eventAt: "2026-05-10T00:00:00.000Z",
      expiresAt: "2026-05-10T23:59:59.000Z",
      confidence: 0.55,
      importance: 0.2,
      evidence: "User mentioned a possible minor trip.",
    })], smallPolicy);
    resolver.resolve("local", payload("s2"), [timedProposal({
      kind: "meeting",
      slot: "calendar/low_value_meeting",
      text: "User has a low-value meeting next month.",
      value: "meeting",
      eventAt: "2026-05-11T00:00:00.000Z",
      expiresAt: "2026-05-11T23:59:59.000Z",
      confidence: 0.6,
      importance: 0.25,
      evidence: "User mentioned a low-value meeting.",
    })], smallPolicy);
    const result = resolver.resolve("local", payload("s3"), [timedProposal()], smallPolicy);

    expect(result.created).toBe(1);
    expect(result.archived).toBe(1);
    expect(store.countLiveCards("local", TIME_BASED_SECTION_ID)).toBe(2);
    expect(store.searchMemories("local", {
      sectionId: TIME_BASED_SECTION_ID,
      query: "minor low value",
      states: ["archived"],
      limit: 10,
    })).toHaveLength(1);
    store.stop();
  });

  it("creates and confirms evolving memories without duplicating slots", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-evolving-memory-"));
    roots.push(root);
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);

    const first = resolver.resolve("local", payload("s1"), [evolvingProposal()], DEFAULT_MEMORY_POLICY);
    const second = resolver.resolve("local", payload("s2"), [evolvingProposal({
      text: "User prefers detailed practical explanations with examples.",
      evidence: "User again asked for detailed practical examples.",
    })], DEFAULT_MEMORY_POLICY);
    const memories = store.findCardsByAddress(
      "local",
      "preference",
      "preference/answer_depth",
      ["active"],
      EVOLVING_MEMORY_SECTION_ID,
    );

    expect(first.created).toBe(1);
    expect(second.confirmed).toBe(1);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.lifecycle).toBe("evolving");
    expect(memories[0]?.metadataJson).toContain("decay");
    store.stop();
  });

  it("archives low-scoring evolving memories after super-fast decay", () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-evolving-memory-"));
    roots.push(root);
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);

    resolver.resolve("local", payload("s1"), [evolvingProposal({
      kind: "temporary",
      slot: "temporary/short_lived_interest",
      text: "User briefly wondered about a short-lived idea.",
      value: "short-lived idea",
      confidence: 0.7,
      importance: 0.5,
      decay: {
        curve: "super_fast",
        graceDays: 0,
        halfLifeDays: 2,
        pressureSensitivity: 1,
        contextThreshold: 0.45,
        archiveThreshold: 0.18,
      },
    })], DEFAULT_MEMORY_POLICY, "2026-04-20T00:00:00.000Z");

    const archived = store.archiveExpiredAndPrune(
      "local",
      new Date("2026-04-30T00:00:00.000Z"),
      DEFAULT_MEMORY_POLICY,
    );

    expect(archived).toBeGreaterThan(0);
    expect(store.listMemories("local", ["archived"], 10, EVOLVING_MEMORY_SECTION_ID)).toHaveLength(1);
    store.stop();
  });

  it("runs consolidation in the background and regenerates a snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-user-facts-"));
    roots.push(root);
    mkdirSync(resolve(root, "context"), { recursive: true });
    const store = makeStore(root);
    const provider = makeProvider(JSON.stringify({
      cards: [proposal()],
    }));
    const consolidator = new MemoryConsolidator({
      provider,
      store,
      projectRoot: root,
      now: () => new Date("2026-04-24T00:00:00.000Z"),
    });

    const jobId = consolidator.enqueueSession({
      userId: "local",
      sessionId: "s1",
      sessionPath: "sessions/s1.md",
      reason: "session_switch:test",
      handoffSummary: "User said their name is Sai.",
      turns: [
        {
          role: "user",
          content: "My name is Sai.",
          timestamp: "2026-04-24T00:00:00.000Z",
          sessionPath: "sessions/s1.md",
        },
      ],
    });

    await consolidator.shutdown();

    expect(jobId).toBe("session:local:s1");
    expect(store.getSnapshot("local")).toContain("User's name is Sai");
    expect(existsSync(resolve(root, "context", "user.wiki"))).toBe(false);
    expect(existsSync(resolve(root, "context", "user_profile.json"))).toBe(false);
    store.stop();
  });

  it("projects a grouped personal memory snapshot across all sections", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-memory-snapshot-"));
    roots.push(root);
    mkdirSync(resolve(root, "context"), { recursive: true });
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);

    resolver.resolve("local", payload("s-fact"), [proposal()], DEFAULT_MEMORY_POLICY);
    resolver.resolve("local", payload("s-time"), [timedProposal()], DEFAULT_MEMORY_POLICY);
    resolver.resolve("local", payload("s-evolving"), [evolvingProposal()], DEFAULT_MEMORY_POLICY);

    const result = await new ProfileProjector({
      projectRoot: root,
      userId: "local",
      now: () => new Date("2026-04-24T00:00:00.000Z"),
    }).regenerate(store);
    const snapshot = store.getSnapshot("local");

    expect(result.sectionCounts).toEqual({
      userFacts: 1,
      timeBased: 1,
      evolvingMemory: 1,
    });
    expect(snapshot).toContain("## Stable User Facts");
    expect(snapshot).toContain("- User's name is Sai.");
    expect(snapshot).toContain("## Time-Based Context");
    expect(snapshot).toContain("- User has an exam on May 20, 2026.");
    expect(snapshot).toContain("## Evolving Memory");
    expect(snapshot).toContain("- [preference] User prefers detailed practical explanations");
    expect(snapshot).not.toContain("user_facts:");
    store.stop();
  });

  it("omits expired time-based memories from the grouped snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-memory-snapshot-"));
    roots.push(root);
    mkdirSync(resolve(root, "context"), { recursive: true });
    const store = makeStore(root);
    const resolver = new MemoryResolver(store);

    resolver.resolve("local", payload("s-time"), [timedProposal({
      text: "User has an old meeting on April 20, 2026.",
      kind: "meeting",
      slot: "calendar/old_meeting",
      eventAt: "2026-04-20T09:00:00.000Z",
      expiresAt: "2026-04-20T10:00:00.000Z",
      evidence: "User said they had an old meeting on April 20, 2026.",
    })], DEFAULT_MEMORY_POLICY, "2026-04-19T00:00:00.000Z");

    await new ProfileProjector({
      projectRoot: root,
      userId: "local",
      now: () => new Date("2026-04-24T00:00:00.000Z"),
    }).regenerate(store);

    expect(store.getSnapshot("local")).toBe("");
    expect(store.listMemories("local", ["expired"], 10, TIME_BASED_SECTION_ID)).toHaveLength(1);
    store.stop();
  });

  it("caps grouped snapshot injection at the hot memory line limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-memory-snapshot-"));
    roots.push(root);
    mkdirSync(resolve(root, "context"), { recursive: true });
    const store = makeStore(root);

    for (let index = 0; index < PERSONAL_MEMORY_SNAPSHOT_LINE_LIMIT + 5; index++) {
      store.createCard({
        userId: "local",
        sectionId: EVOLVING_MEMORY_SECTION_ID,
        kind: "preference",
        slot: `preference/test_${index}`,
        text: `User prefers test memory ${index}.`,
        state: "active",
        confidence: 0.99,
        importance: 1,
        sourceType: "explicit_user_statement",
        sourceReliability: 1,
        createdAt: "2026-04-24T00:00:00.000Z",
      });
    }

    const result = await new ProfileProjector({
      projectRoot: root,
      userId: "local",
      now: () => new Date("2026-04-24T00:00:00.000Z"),
    }).regenerate(store);
    const injectedLines = store.getSnapshot("local").split("\n").filter((line) => line.startsWith("- "));

    expect(result.eligibleCount).toBe(PERSONAL_MEMORY_SNAPSHOT_LINE_LIMIT + 5);
    expect(result.injectedCount).toBe(PERSONAL_MEMORY_SNAPSHOT_LINE_LIMIT);
    expect(result.truncated).toBe(true);
    expect(injectedLines).toHaveLength(PERSONAL_MEMORY_SNAPSHOT_LINE_LIMIT);
    store.stop();
  });

  it("serves personal memory snapshots from hot cache and refreshes after evolution", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-memory-hot-cache-"));
    roots.push(root);
    mkdirSync(resolve(root, "context"), { recursive: true });
    const store = makeStore(root);
    const cache = new PersonalMemorySnapshotCache({
      store,
      projectRoot: root,
      now: () => new Date("2026-04-24T00:00:00.000Z"),
    });

    await cache.refresh("local", "startup");
    expect(cache.getSnapshot("local")).toBe("");

    const provider = makeProvider(JSON.stringify({
      cards: [evolvingProposal()],
    }));
    const consolidator = new MemoryConsolidator({
      provider,
      store,
      projectRoot: root,
      now: () => new Date("2026-04-24T00:00:00.000Z"),
      onSnapshotRegenerated: (userId, snapshot, result) => {
        cache.setSnapshot(userId, snapshot, "evolution", result);
      },
    });

    consolidator.enqueueSession({
      userId: "local",
      sessionId: "s-hot-cache",
      sessionPath: "sessions/s-hot-cache.md",
      reason: "session_switch:test",
      handoffSummary: "User wants detailed practical explanations.",
      turns: [
        {
          role: "user",
          content: "Please give me full details and practical examples.",
          timestamp: "2026-04-24T00:00:00.000Z",
          sessionPath: "sessions/s-hot-cache.md",
        },
      ],
    });

    await consolidator.shutdown();

    expect(cache.getSnapshot("local")).toContain("## Evolving Memory");
    expect(cache.getSnapshot("local")).toContain("[preference] User prefers detailed practical explanations");
    store.stop();
  });

  it("extracts time-based memories during consolidation", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-time-based-"));
    roots.push(root);
    mkdirSync(resolve(root, "context"), { recursive: true });
    const store = makeStore(root);
    const provider = makeProvider(JSON.stringify({
      cards: [timedProposal()],
    }));
    const consolidator = new MemoryConsolidator({
      provider,
      store,
      projectRoot: root,
      now: () => new Date("2026-04-24T00:00:00.000Z"),
    });

    consolidator.enqueueSession({
      userId: "local",
      sessionId: "s-time",
      sessionPath: "sessions/s-time.md",
      reason: "session_switch:test",
      handoffSummary: "User has an exam on May 20, 2026.",
      turns: [
        {
          role: "user",
          content: "I have an exam on May 20, 2026.",
          timestamp: "2026-04-24T00:00:00.000Z",
          sessionPath: "sessions/s-time.md",
        },
      ],
    });

    await consolidator.shutdown();

    const timed = store.listMemories("local", ["active"], 10, TIME_BASED_SECTION_ID);
    expect(timed).toHaveLength(1);
    expect(store.getSnapshot("local")).toContain("## Time-Based Context");
    expect(store.getSnapshot("local")).toContain("User has an exam on May 20, 2026.");
    store.stop();
  });

  it("extracts evolving memories during consolidation", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-evolving-memory-"));
    roots.push(root);
    mkdirSync(resolve(root, "context"), { recursive: true });
    const store = makeStore(root);
    const provider = makeProvider(JSON.stringify({
      cards: [evolvingProposal()],
    }));
    const consolidator = new MemoryConsolidator({
      provider,
      store,
      projectRoot: root,
      now: () => new Date("2026-04-24T00:00:00.000Z"),
    });

    consolidator.enqueueSession({
      userId: "local",
      sessionId: "s-evolving",
      sessionPath: "sessions/s-evolving.md",
      reason: "session_switch:test",
      handoffSummary: "User wants detailed practical explanations.",
      turns: [
        {
          role: "user",
          content: "Please give me full details and practical examples.",
          timestamp: "2026-04-24T00:00:00.000Z",
          sessionPath: "sessions/s-evolving.md",
        },
      ],
    });

    await consolidator.shutdown();

    const evolving = store.listMemories("local", ["active"], 10, EVOLVING_MEMORY_SECTION_ID);
    expect(evolving).toHaveLength(1);
    expect(store.getSnapshot("local")).toContain("## Evolving Memory");
    expect(store.getSnapshot("local")).toContain("[preference] User prefers detailed practical");
    store.stop();
  });
});
