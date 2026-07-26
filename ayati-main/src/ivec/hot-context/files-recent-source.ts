import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { RecentFileMetadata } from "ayati-context-engine";
import { estimateTextTokens } from "../../prompt/token-estimator.js";
import { MAX_HOT_RECENT_DOCUMENTS } from "../recent-document-registry.js";
import type { HotContextSourceEntry } from "./contracts.js";

export const FILES_RECENT_HOT_CONTEXT_KEY = "files.recent";
export const MAX_RECENT_HOT_CONTEXT_FILES = MAX_HOT_RECENT_DOCUMENTS;

interface RecentFilesHotContextContent {
  schemaVersion: 1;
  files: RecentFileMetadata[];
}

export function buildRecentFilesHotContextEntry(
  files: RecentFileMetadata[],
): HotContextSourceEntry | undefined {
  const recent = [...new Map(
    files.map((file) => [file.path, file]),
  ).values()].slice(0, MAX_RECENT_HOT_CONTEXT_FILES);
  if (recent.length === 0) return undefined;
  const content = JSON.stringify({
    schemaVersion: 1,
    files: recent,
  } satisfies RecentFilesHotContextContent);
  return {
    key: FILES_RECENT_HOT_CONTEXT_KEY,
    description: `Navigation metadata for ${recent.length} older recently and completely read file${recent.length === 1 ? "" : "s"}.`,
    version: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    estimatedTokens: estimateTextTokens(content),
    freshness: "current",
    sourceRefs: recent.map((file) => file.evidenceRef),
    content,
  };
}

export function readRecentFilesHotContextContent(
  content: string,
): RecentFileMetadata[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)
      || parsed["schemaVersion"] !== 1
      || !Array.isArray(parsed["files"])) {
      return [];
    }
    return parsed["files"]
      .filter(isRecentFileMetadata)
      .slice(0, MAX_RECENT_HOT_CONTEXT_FILES);
  } catch {
    return [];
  }
}

function isRecentFileMetadata(value: unknown): value is RecentFileMetadata {
  if (!isRecord(value)) return false;
  return typeof value["name"] === "string"
    && value["name"].trim().length > 0
    && typeof value["path"] === "string"
    && isAbsolute(value["path"])
    && typeof value["lastReadAt"] === "string"
    && value["lastReadAt"].trim().length > 0
    && typeof value["evidenceRef"] === "string"
    && value["evidenceRef"].trim().length > 0
    && value["coverage"] === "complete"
    && value["status"] === "navigation_only";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
