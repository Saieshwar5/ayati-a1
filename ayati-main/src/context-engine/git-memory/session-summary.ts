import type { LlmProvider } from "../../core/contracts/provider.js";
import type { ContextSessionSummary } from "../contracts.js";
import type {
  GitMemoryConversationRecord,
  GitMemoryConversationRole,
  GitMemorySessionId,
  GitMemorySessionSummaryMetaFile,
} from "./schema.js";

export type GitMemorySessionSummaryStrategy = "deterministic" | "llm";

export interface BuildGitMemorySessionSummaryUpdateInput {
  records: GitMemoryConversationRecord[];
  previousSummary?: ContextSessionSummary;
  strategy?: GitMemorySessionSummaryStrategy;
}

export interface BuiltGitMemorySessionSummaryUpdate {
  text: string;
  strategy: GitMemorySessionSummaryStrategy;
  coveredUntilSeq: number;
  messageCount: number;
  sourceFromSeq: number;
  sourceToSeq: number;
  previousCoveredUntilSeq?: number;
}

export interface GitMemorySessionSummaryUpdater {
  buildUpdate(input: BuildGitMemorySessionSummaryUpdateInput): Promise<BuiltGitMemorySessionSummaryUpdate | null>;
}

export interface LlmGitMemorySessionSummaryUpdaterOptions {
  provider: LlmProvider;
  fallback?: GitMemorySessionSummaryUpdater;
  maxSummaryChars?: number;
}

export class DeterministicGitMemorySessionSummaryUpdater implements GitMemorySessionSummaryUpdater {
  async buildUpdate(
    input: BuildGitMemorySessionSummaryUpdateInput,
  ): Promise<BuiltGitMemorySessionSummaryUpdate | null> {
    return buildGitMemorySessionSummaryUpdate({
      ...input,
      strategy: "deterministic",
    });
  }
}

export class LlmGitMemorySessionSummaryUpdater implements GitMemorySessionSummaryUpdater {
  private readonly provider: LlmProvider;
  private readonly fallback: GitMemorySessionSummaryUpdater;
  private readonly maxSummaryChars: number;

  constructor(options: LlmGitMemorySessionSummaryUpdaterOptions) {
    this.provider = options.provider;
    this.fallback = options.fallback ?? new DeterministicGitMemorySessionSummaryUpdater();
    this.maxSummaryChars = options.maxSummaryChars ?? 2_000;
  }

  async buildUpdate(
    input: BuildGitMemorySessionSummaryUpdateInput,
  ): Promise<BuiltGitMemorySessionSummaryUpdate | null> {
    const coverage = buildSessionSummaryCoverage(input.records, input.previousSummary);
    if (!coverage) {
      return null;
    }
    try {
      const response = await this.provider.generateTurn({
        messages: [
          {
            role: "system",
            content: [
              "Summarize the session context for an AI agent.",
              "Use only the previous summary and conversation records provided.",
              "Do not invent facts.",
              "Keep the summary compact and structured as Markdown.",
              "Use sections: Current Focus, Recent Decisions, Open Questions, Important Context, Recent Progress.",
              `Keep the markdown under ${this.maxSummaryChars} characters.`,
              "Return JSON with a string field named summaryMarkdown.",
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              previousSummary: input.previousSummary?.text ?? "",
              records: input.records.map((record) => ({
                seq: record.seq,
                role: record.role,
                at: record.at,
                text: record.text,
              })),
            }, null, 2),
          },
        ],
        responseFormat: this.provider.capabilities.structuredOutput?.jsonObject ? { type: "json_object" } : undefined,
      });
      if (response.type !== "assistant") {
        return await this.fallback.buildUpdate(input);
      }
      const text = parseLlmSummaryMarkdown(response.content, this.maxSummaryChars);
      if (!text) {
        return await this.fallback.buildUpdate(input);
      }
      return {
        text,
        strategy: "llm",
        ...coverage,
      };
    } catch {
      return await this.fallback.buildUpdate(input);
    }
  }
}

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
      ...(parsed.strategy === "deterministic" || parsed.strategy === "llm" ? { strategy: parsed.strategy } : {}),
      ...(typeof parsed.coveredUntilSeq === "number" ? { coveredUntilSeq: parsed.coveredUntilSeq } : {}),
      ...(typeof parsed.messageCount === "number" ? { messageCount: parsed.messageCount } : {}),
      ...(typeof parsed.sourceFromSeq === "number" ? { sourceFromSeq: parsed.sourceFromSeq } : {}),
      ...(typeof parsed.sourceToSeq === "number" ? { sourceToSeq: parsed.sourceToSeq } : {}),
      ...(typeof parsed.previousCoveredUntilSeq === "number" ? { previousCoveredUntilSeq: parsed.previousCoveredUntilSeq } : {}),
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

export function buildGitMemorySessionSummaryUpdate(
  input: BuildGitMemorySessionSummaryUpdateInput,
): BuiltGitMemorySessionSummaryUpdate | null {
  const strategy = input.strategy ?? "deterministic";
  if (strategy !== "deterministic") {
    throw new Error(`Unsupported git-memory session summary strategy: ${strategy}`);
  }
  return buildDeterministicSessionSummaryUpdate(input.records, input.previousSummary);
}

function buildDeterministicSessionSummaryUpdate(
  records: GitMemoryConversationRecord[],
  previousSummary: ContextSessionSummary | undefined,
): BuiltGitMemorySessionSummaryUpdate | null {
  const coverage = buildSessionSummaryCoverage(records, previousSummary);
  if (!coverage) {
    return null;
  }
  const textRecords = records.filter((record) => (record.text ?? "").trim().length > 0);
  const recent = tail(textRecords, 8);
  const currentFocus = [...textRecords].reverse().find((record) => record.role === "user");
  const decisions = tail(textRecords.filter((record) => isDecisionSummaryCandidate(record.text ?? "")), 5);
  const openQuestions = tail(textRecords.filter((record) => isOpenQuestionSummaryCandidate(record.text ?? "")), 5);
  const lines = [
    "# Session Summary",
    "",
    "## Current Focus",
    currentFocus ? `- ${compactSummaryText(currentFocus.text ?? "")}` : "- None detected.",
    "",
    "## Recent Decisions",
    ...formatSummaryRecordBullets(decisions),
    "",
    "## Open Questions",
    ...formatSummaryRecordBullets(openQuestions),
    "",
    "## Recent Messages",
    ...recent.map((record) => `- ${formatConversationRole(record.role)}: ${compactSummaryText(record.text ?? "")}`),
  ];
  return {
    text: lines.join("\n"),
    strategy: "deterministic",
    ...coverage,
  };
}

function buildSessionSummaryCoverage(
  records: GitMemoryConversationRecord[],
  previousSummary: ContextSessionSummary | undefined,
): Omit<BuiltGitMemorySessionSummaryUpdate, "text" | "strategy"> | null {
  const textRecords = records.filter((record) => (record.text ?? "").trim().length > 0);
  if (textRecords.length === 0) {
    return null;
  }
  const sourceFromSeq = textRecords.reduce((min, record) => Math.min(min, record.seq), textRecords[0]!.seq);
  const sourceToSeq = textRecords.reduce((max, record) => Math.max(max, record.seq), 0);
  return {
    coveredUntilSeq: sourceToSeq,
    messageCount: textRecords.length,
    sourceFromSeq,
    sourceToSeq,
    ...(typeof previousSummary?.coveredUntilSeq === "number" ? {
      previousCoveredUntilSeq: previousSummary.coveredUntilSeq,
    } : {}),
  };
}

function parseLlmSummaryMarkdown(content: string, maxSummaryChars: number): string {
  try {
    const parsed = JSON.parse(content) as { summaryMarkdown?: unknown; text?: unknown };
    const value = typeof parsed.summaryMarkdown === "string"
      ? parsed.summaryMarkdown
      : typeof parsed.text === "string"
        ? parsed.text
        : "";
    const normalized = value.trim();
    if (!normalized) {
      return "";
    }
    return normalized.length <= maxSummaryChars ? normalized : normalized.slice(0, maxSummaryChars).trimEnd();
  } catch {
    return "";
  }
}

function formatSummaryRecordBullets(records: GitMemoryConversationRecord[]): string[] {
  if (records.length === 0) {
    return ["- None detected."];
  }
  return records.map((record) => `- ${formatConversationRole(record.role)}: ${compactSummaryText(record.text ?? "")}`);
}

function formatConversationRole(role: GitMemoryConversationRole): string {
  switch (role) {
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    case "user":
      return "User";
  }
}

function compactSummaryText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 220 ? normalized : `${normalized.slice(0, 217).trimEnd()}...`;
}

function isDecisionSummaryCandidate(value: string): boolean {
  const normalized = value.toLowerCase();
  return /\b(approved|decided|decision|agreed|accepted|confirmed|implemented|finished|completed)\b/.test(normalized)
    || /\b(we should|we will|we need to|let'?s|next slice|next step)\b/.test(normalized);
}

function isOpenQuestionSummaryCandidate(value: string): boolean {
  return value.includes("?");
}

function tail<T>(items: T[], limit: number): T[] {
  return items.length <= limit ? items : items.slice(items.length - limit);
}
