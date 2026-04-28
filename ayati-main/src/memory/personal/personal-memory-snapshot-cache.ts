import { devLog, devWarn } from "../../shared/index.js";
import type { PersonalMemoryStore } from "./personal-memory-store.js";
import { ProfileProjector, type SnapshotProjectionResult } from "./profile-projector.js";

export interface PersonalMemorySnapshotCacheOptions {
  store: PersonalMemoryStore;
  projectRoot: string;
  now?: () => Date;
}

export class PersonalMemorySnapshotCache {
  private readonly store: PersonalMemoryStore;
  private readonly projectRoot: string;
  private readonly nowProvider: () => Date;
  private readonly snapshots = new Map<string, string>();

  constructor(options: PersonalMemorySnapshotCacheOptions) {
    this.store = options.store;
    this.projectRoot = options.projectRoot;
    this.nowProvider = options.now ?? (() => new Date());
  }

  getSnapshot(userId: string): string {
    const cached = this.snapshots.get(userId);
    if (cached !== undefined) {
      return cached;
    }

    const stored = this.store.getSnapshot(userId);
    this.snapshots.set(userId, stored);
    return stored;
  }

  async refresh(userId: string, reason: string): Promise<string> {
    try {
      const result = await new ProfileProjector({
        projectRoot: this.projectRoot,
        userId,
        now: this.nowProvider,
      }).regenerate(this.store);
      this.setSnapshot(userId, result.content, reason, result);
      return result.content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const fallback = this.store.getSnapshot(userId);
      this.snapshots.set(userId, fallback);
      this.store.writeAuditEvent({
        userId,
        event: "snapshot_hot_cache_refresh_failed",
        reason,
        details: { error: message, fallbackAvailable: fallback.length > 0 },
      });
      devWarn(`Personal memory hot snapshot refresh failed user=${userId} reason=${reason}: ${message}`);
      return fallback;
    }
  }

  setSnapshot(
    userId: string,
    content: string,
    reason: string,
    result?: SnapshotProjectionResult,
  ): void {
    this.snapshots.set(userId, content);
    this.store.writeAuditEvent({
      userId,
      event: "snapshot_hot_cache_refreshed",
      reason,
      details: result
        ? {
          eligible: result.eligibleCount,
          injected: result.injectedCount,
          truncated: result.truncated,
          sectionCounts: result.sectionCounts,
        }
        : { injected: content.split("\n").filter((line) => line.startsWith("- ")).length },
    });
    devLog(
      `Personal memory hot snapshot refreshed user=${userId} reason=${reason} lines=${countMemoryLines(content)}`,
    );
  }
}

function countMemoryLines(content: string): number {
  return content.split("\n").filter((line) => line.startsWith("- ")).length;
}
