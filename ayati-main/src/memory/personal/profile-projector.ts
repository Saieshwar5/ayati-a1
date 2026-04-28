import { scoreMemory, shouldInjectMemory } from "./memory-scorer.js";
import { loadMemoryPolicy } from "./memory-policy.js";
import type { MemoryCard } from "./types.js";
import { EVOLVING_MEMORY_SECTION_ID, TIME_BASED_SECTION_ID, USER_FACTS_SECTION_ID } from "./types.js";
import type { PersonalMemoryStore } from "./personal-memory-store.js";

export const PERSONAL_MEMORY_SNAPSHOT_LINE_LIMIT = 400;

export interface SnapshotProjectionResult {
  content: string;
  memoryIds: string[];
  eligibleCount: number;
  injectedCount: number;
  truncated: boolean;
  sectionCounts: {
    userFacts: number;
    timeBased: number;
    evolvingMemory: number;
  };
}

export interface ProfileProjectorOptions {
  projectRoot: string;
  userId: string;
  now?: () => Date;
}

export class ProfileProjector {
  private readonly projectRoot: string;
  private readonly userId: string;
  private readonly nowProvider: () => Date;

  constructor(options: ProfileProjectorOptions) {
    this.projectRoot = options.projectRoot;
    this.userId = options.userId;
    this.nowProvider = options.now ?? (() => new Date());
  }

  async regenerate(store: PersonalMemoryStore): Promise<SnapshotProjectionResult> {
    const now = this.nowProvider();
    const policy = loadMemoryPolicy(this.projectRoot);
    store.expireTimedCards(this.userId, now);
    const memories = [
      ...store.listMemories(this.userId, ["active"], 1_000, USER_FACTS_SECTION_ID),
      ...store.listMemories(this.userId, ["active"], 1_000, TIME_BASED_SECTION_ID),
      ...store.listMemories(this.userId, ["active"], 1_000, EVOLVING_MEMORY_SECTION_ID),
    ];
    const activeEvolvingCount = store.countLiveCards(this.userId, EVOLVING_MEMORY_SECTION_ID);
    const trusted = memories
      .filter((memory) => shouldInjectMemory(memory, now, 0.45, { policy, activeSectionCount: activeEvolvingCount }))
      .map((memory) => ({
        memory,
        score: scoreMemory(memory, now, { policy, activeSectionCount: activeEvolvingCount }),
      }))
      .sort((a, b) => {
        if (b.score.retentionScore !== a.score.retentionScore) {
          return b.score.retentionScore - a.score.retentionScore;
        }
        return b.memory.lastConfirmedAt.localeCompare(a.memory.lastConfirmedAt);
      });

    const selected = trusted.slice(0, PERSONAL_MEMORY_SNAPSHOT_LINE_LIMIT);
    const selectedMemories = selected.map(({ memory }) => memory);
    const snapshot = buildGroupedSnapshot(selectedMemories);
    const memoryIds = selectedMemories.map((memory) => memory.id);
    store.updateSnapshot(
      this.userId,
      snapshot,
      memoryIds,
    );
    if (trusted.length > selected.length) {
      store.writeAuditEvent({
        userId: this.userId,
        event: "snapshot_truncated",
        details: {
          eligible: trusted.length,
          injected: selected.length,
          cap: PERSONAL_MEMORY_SNAPSHOT_LINE_LIMIT,
        },
      });
    }

    return {
      content: snapshot,
      memoryIds,
      eligibleCount: trusted.length,
      injectedCount: selected.length,
      truncated: trusted.length > selected.length,
      sectionCounts: countSnapshotSections(selectedMemories),
    };
  }
}

function buildGroupedSnapshot(memories: MemoryCard[]): string {
  const stableFacts = memories
    .filter((memory) => memory.sectionId === USER_FACTS_SECTION_ID)
    .map((memory) => `- ${formatMemoryText(memory)}`);
  const timeBased = memories
    .filter((memory) => memory.sectionId === TIME_BASED_SECTION_ID)
    .map((memory) => `- ${formatMemoryText(memory)}`);
  const evolving = memories
    .filter((memory) => memory.sectionId === EVOLVING_MEMORY_SECTION_ID)
    .map((memory) => `- [${formatKindLabel(memory.kind)}] ${formatMemoryText(memory)}`);

  return [
    formatSnapshotSection("Stable User Facts", stableFacts),
    formatSnapshotSection("Time-Based Context", timeBased),
    formatSnapshotSection("Evolving Memory", evolving),
  ].filter(Boolean).join("\n\n");
}

function formatSnapshotSection(title: string, lines: string[]): string {
  if (lines.length === 0) {
    return "";
  }
  return [`## ${title}`, ...lines].join("\n");
}

function formatMemoryText(memory: MemoryCard): string {
  return memory.text.replace(/\s+/g, " ").trim();
}

function formatKindLabel(kind: string): string {
  return kind.replace(/_/g, " ").trim() || "memory";
}

function countSnapshotSections(memories: MemoryCard[]): SnapshotProjectionResult["sectionCounts"] {
  return {
    userFacts: memories.filter((memory) => memory.sectionId === USER_FACTS_SECTION_ID).length,
    timeBased: memories.filter((memory) => memory.sectionId === TIME_BASED_SECTION_ID).length,
    evolvingMemory: memories.filter((memory) => memory.sectionId === EVOLVING_MEMORY_SECTION_ID).length,
  };
}
