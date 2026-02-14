import type { LlmProvider } from "../core/contracts/provider.js";
import type { LlmMessage } from "../core/contracts/llm-protocol.js";
import type { ConversationTurn, SessionProfile, SessionSummaryRecord } from "./types.js";
import { devWarn } from "../shared/index.js";

const MAX_TURNS_FOR_SUMMARY_PROMPT = 60;
const MAX_KEYWORDS = 20;

interface SummaryPayload {
  summary: string;
  keywords: string[];
  confidence?: number;
  redaction_flags?: string[];
}

function cleanKeyword(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._/-\s]/g, "")
    .replace(/\s+/g, " ");
}

function normalizeKeywords(keywords: string[]): string[] {
  const unique = new Set<string>();
  for (const raw of keywords) {
    const cleaned = cleanKeyword(raw);
    if (cleaned.length < 2) continue;
    unique.add(cleaned);
    if (unique.size >= MAX_KEYWORDS) break;
  }
  return [...unique];
}

function summarizeFallback(turns: ConversationTurn[]): string {
  const recent = turns.slice(-8);
  const lines = recent.map((turn) => `${turn.role}: ${turn.content.replace(/\s+/g, " ").slice(0, 140)}`);
  return `Session focused on: ${lines.join(" | ")}`.slice(0, 1200);
}

function fallbackKeywords(turns: ConversationTurn[]): string[] {
  const counts = new Map<string, number>();
  for (const turn of turns.slice(-20)) {
    if (turn.role !== "user") continue;
    for (const token of turn.content.toLowerCase().split(/\s+/)) {
      const cleaned = cleanKeyword(token);
      if (cleaned.length < 3) continue;
      counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([word]) => word);
}

function redactSensitive(text: string): { value: string; flags: string[] } {
  let value = text;
  const flags: string[] = [];

  const beforeEmail = value;
  value = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");
  if (value !== beforeEmail) flags.push("email");

  const beforePhone = value;
  value = value.replace(/\+?\d[\d\s().-]{7,}\d/g, "[REDACTED_PHONE]");
  if (value !== beforePhone) flags.push("phone");

  const beforeSecret = value;
  value = value.replace(/\b(sk-[a-zA-Z0-9]{16,}|AIza[0-9A-Za-z\-_]{20,})\b/g, "[REDACTED_SECRET]");
  if (value !== beforeSecret) flags.push("secret");

  return { value, flags };
}

function parseJson(text: string): SummaryPayload | null {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(cleaned) as SummaryPayload;
  } catch {
    return null;
  }
}

export interface SessionSummaryServiceOptions {
  provider?: LlmProvider;
}

export class SessionSummaryService {
  private readonly provider?: LlmProvider;

  constructor(options?: SessionSummaryServiceOptions) {
    this.provider = options?.provider;
  }

  hasLlmSupport(): boolean {
    return !!this.provider;
  }

  async summarizeSession(
    turns: ConversationTurn[],
    closeReason: string,
    profile: SessionProfile | null,
  ): Promise<SessionSummaryRecord> {
    const baseline = this.summarizeSessionSync(turns);
    if (turns.length === 0) {
      return baseline;
    }

    const llm = this.provider ? await this.tryLlmSummary(turns, closeReason, profile) : null;
    if (!llm) return baseline;

    const redacted = redactSensitive(llm.summary);
    const keywords = normalizeKeywords(llm.keywords);
    const redactionFlags = [...new Set([...(llm?.redaction_flags ?? []), ...redacted.flags])];

    return {
      summaryText: redacted.value,
      keywords,
      confidence: Math.max(0, Math.min(1, llm.confidence ?? 0.7)),
      redactionFlags,
    };
  }

  summarizeSessionSync(turns: ConversationTurn[]): SessionSummaryRecord {
    if (turns.length === 0) {
      return {
        summaryText: "",
        keywords: [],
        confidence: 0,
        redactionFlags: [],
      };
    }

    const baseSummary = summarizeFallback(turns);
    const baseKeywords = fallbackKeywords(turns);
    const redacted = redactSensitive(baseSummary);

    return {
      summaryText: redacted.value,
      keywords: normalizeKeywords(baseKeywords),
      confidence: 0.5,
      redactionFlags: redacted.flags,
    };
  }

  private async tryLlmSummary(
    turns: ConversationTurn[],
    closeReason: string,
    profile: SessionProfile | null,
  ): Promise<SummaryPayload | null> {
    try {
      const compactTurns = turns.slice(-MAX_TURNS_FOR_SUMMARY_PROMPT).map((turn) => ({
        role: turn.role,
        content: turn.content,
        timestamp: turn.timestamp,
      }));

      const system = [
        "You summarize closed chat sessions for memory indexing.",
        "Return strict JSON only.",
        "Keep factual decisions, constraints, open loops, and key user intent.",
        "Avoid prose fluff.",
      ].join(" ");

      const payload = {
        close_reason: closeReason,
        profile,
        turns: compactTurns,
      };

      const user = [
        "Create JSON with fields:",
        `{"summary":"string","keywords":["..."],"confidence":0.0,"redaction_flags":["..."]}`,
        "Rules: summary <= 1200 chars, keywords max 20, lowercase keywords, confidence 0..1.",
        "Conversation:",
        JSON.stringify(payload),
      ].join("\n");

      const messages: LlmMessage[] = [
        { role: "system", content: system },
        { role: "user", content: user },
      ];

      const output = await this.provider!.generateTurn({ messages });
      if (output.type !== "assistant") return null;

      const parsed = parseJson(output.content);
      if (!parsed || typeof parsed.summary !== "string" || !Array.isArray(parsed.keywords)) {
        return null;
      }

      return {
        summary: parsed.summary.trim(),
        keywords: parsed.keywords.filter((item): item is string => typeof item === "string"),
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
        redaction_flags: Array.isArray(parsed.redaction_flags)
          ? parsed.redaction_flags.filter((item): item is string => typeof item === "string")
          : [],
      };
    } catch (err) {
      devWarn(
        "Session summary LLM call failed, falling back to deterministic summary:",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }
}
