import type { ContextSessionSummary } from "../contracts.js";
import type { GitMemorySessionId, GitMemorySessionSummaryMetaFile } from "./schema.js";

export interface ParseGitMemorySessionSummaryInput {
  sessionId: GitMemorySessionId;
  markdown: string | null;
  metadataJson?: string | null;
}

export function parseGitMemorySessionSummary(
  input: ParseGitMemorySessionSummaryInput,
): ContextSessionSummary | undefined {
  const text = parseGitMemorySessionSummaryMarkdown(input.markdown);
  if (!text) {
    return undefined;
  }
  const metadata = parseGitMemorySessionSummaryMetadata(input.sessionId, input.metadataJson);
  return {
    text,
    ...(metadata?.updatedAt ? { updatedAt: metadata.updatedAt } : {}),
    ...(typeof metadata?.coveredUntilSeq === "number" ? { coveredUntilSeq: metadata.coveredUntilSeq } : {}),
  };
}

export function parseGitMemorySessionSummaryMarkdown(markdown: string | null): string {
  return markdown?.trim() ?? "";
}

export function parseGitMemorySessionSummaryMetadata(
  sessionId: GitMemorySessionId,
  metadataJson: string | null | undefined,
): GitMemorySessionSummaryMetaFile | undefined {
  if (!metadataJson?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(metadataJson) as Partial<GitMemorySessionSummaryMetaFile>;
    if (
      parsed.schemaVersion !== 1
      || parsed.sessionId !== sessionId
      || typeof parsed.updatedAt !== "string"
    ) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      ...(parsed.formatVersion === 1 ? { formatVersion: 1 } : {}),
      sessionId,
      updatedAt: parsed.updatedAt,
      ...(typeof parsed.coveredUntilSeq === "number" ? { coveredUntilSeq: parsed.coveredUntilSeq } : {}),
      ...(typeof parsed.messageCount === "number" ? { messageCount: parsed.messageCount } : {}),
    };
  } catch {
    return undefined;
  }
}

export function renderGitMemorySessionSummaryMarkdown(text: string): string {
  const normalized = text.trim();
  return normalized ? `${normalized}\n` : "";
}

export function renderGitMemorySessionSummaryMetadata(metadata: GitMemorySessionSummaryMetaFile): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}
