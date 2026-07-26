import { createHash } from "node:crypto";
import { estimateTextTokens } from "../../prompt/token-estimator.js";
import {
  PERSONAL_MEMORY_HOT_CONTEXT_KEY,
  type HotContextSource,
  type HotContextSourceEntry,
} from "./contracts.js";

export interface PersonalMemoryHotContextSourceOptions {
  getSnapshot(clientId: string): string;
}

export function createPersonalMemoryHotContextSource(
  options: PersonalMemoryHotContextSourceOptions,
): HotContextSource {
  return {
    key: PERSONAL_MEMORY_HOT_CONTEXT_KEY,
    read(clientId: string): HotContextSourceEntry | undefined {
      const content = options.getSnapshot(clientId).trim();
      if (!content) return undefined;
      return {
        key: PERSONAL_MEMORY_HOT_CONTEXT_KEY,
        description: "Stable personal facts and preferences learned about the user.",
        version: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
        estimatedTokens: estimateTextTokens(content),
        freshness: "current",
        sourceRefs: ["personal-memory:snapshot"],
        content,
      };
    },
  };
}
