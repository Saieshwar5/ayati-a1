import type { TimelineCheckpointEvent } from "./timeline-checkpoint.js";

export type TimelineCheckpointCacheEntry =
  | {
      status: "success";
      checkpoint: TimelineCheckpointEvent;
      checkpointTokens: number;
    }
  | {
      status: "failed";
      errors: string[];
    };

export interface TimelineCheckpointCacheState {
  entries: Record<string, TimelineCheckpointCacheEntry>;
}

const CHECKPOINT_PROMPT_VERSION = "timeline-checkpoint-v1";

export function createTimelineCheckpointCache(): TimelineCheckpointCacheState {
  return { entries: {} };
}

export function timelineCheckpointCacheKey(input: {
  provider: string;
  model: string;
  sourceHash: string;
  checkpointTokenBudget: number;
  generatorInputCapacity?: number;
}): string {
  return [
    CHECKPOINT_PROMPT_VERSION,
    input.provider,
    input.model,
    input.sourceHash,
    String(input.checkpointTokenBudget),
    String(input.generatorInputCapacity ?? "default"),
  ].join(":");
}

export function readTimelineCheckpointCache(
  cache: TimelineCheckpointCacheState,
  key: string,
): TimelineCheckpointCacheEntry | undefined {
  return cache.entries[key];
}

export function writeTimelineCheckpointCache(
  cache: TimelineCheckpointCacheState,
  key: string,
  entry: TimelineCheckpointCacheEntry,
): void {
  cache.entries[key] = entry;
}
