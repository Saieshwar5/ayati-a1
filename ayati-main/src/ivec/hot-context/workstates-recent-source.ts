import { createHash } from "node:crypto";
import type { RecentWorkStateHandoff } from "ayati-context-engine";
import { estimateTextTokens } from "../../prompt/token-estimator.js";
import type { HotContextSourceEntry } from "./contracts.js";

export const WORKSTATES_RECENT_HOT_CONTEXT_KEY = "workstates.recent";
export const MAX_RECENT_HOT_CONTEXT_WORK_STATES = 5;

export function buildRecentWorkStatesHotContextEntry(
  workStates: RecentWorkStateHandoff[],
): HotContextSourceEntry | undefined {
  const recent = [...new Map(
    workStates.map((workState) => [workState.runId, workState]),
  ).values()].slice(0, MAX_RECENT_HOT_CONTEXT_WORK_STATES);
  if (recent.length === 0) return undefined;
  const content = JSON.stringify({
    schemaVersion: 1,
    historicalHandoffOnly: true,
    workStates: recent,
  });
  return {
    key: WORKSTATES_RECENT_HOT_CONTEXT_KEY,
    description: `Historical handoffs from ${recent.length} recent material run${recent.length === 1 ? "" : "s"}.`,
    version: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    estimatedTokens: estimateTextTokens(content),
    freshness: "current",
    sourceRefs: recent.map((workState) => workState.sourceRef),
    content,
  };
}
