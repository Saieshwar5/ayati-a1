import { createHash } from "node:crypto";
import type { RecentWorkstreamMetadata } from "ayati-context-engine";
import { estimateTextTokens } from "../../prompt/token-estimator.js";
import type { HotContextSourceEntry } from "./contracts.js";

export const WORKSTREAMS_RECENT_HOT_CONTEXT_KEY = "workstreams.recent";
export const MAX_RECENT_HOT_CONTEXT_WORKSTREAMS = 10;

export function buildRecentWorkstreamsHotContextEntry(
  workstreams: RecentWorkstreamMetadata[],
): HotContextSourceEntry | undefined {
  const recent = [...new Map(
    workstreams.map((workstream) => [workstream.workstreamId, workstream]),
  ).values()].slice(0, MAX_RECENT_HOT_CONTEXT_WORKSTREAMS);
  if (recent.length === 0) return undefined;
  const content = JSON.stringify({
    schemaVersion: 1,
    workstreams: recent,
  });
  return {
    key: WORKSTREAMS_RECENT_HOT_CONTEXT_KEY,
    description: "Metadata for up to 10 recently created, opened, or bound workstreams.",
    version: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    estimatedTokens: estimateTextTokens(content),
    freshness: "current",
    sourceRefs: ["workstream-catalog:recent"],
    content,
  };
}
