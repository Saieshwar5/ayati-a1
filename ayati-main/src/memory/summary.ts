import type { InMemorySession } from "./session.js";

const MAX_SUMMARY_PREVIEW_CHARS = 120;

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)} ...[truncated]`;
}

function buildKeywordList(text: string): string[] {
  const terms = text
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

  const unique = new Set<string>();
  for (const term of terms) {
    if (unique.size >= 12) break;
    unique.add(term);
  }

  return [...unique];
}

export function generateSummary(session: InMemorySession, summaryType: "rolling" | "final"): string {
  const turns = session.getConversationTurns();
  const toolEvents = session.getToolEvents();

  const latestTurns = turns.slice(-8);
  const userTopics = latestTurns
    .filter((t) => t.role === "user")
    .map((t) => t.content)
    .join(" ");

  const lines: string[] = [];
  lines.push(`Summary type: ${summaryType}`);

  if (latestTurns.length > 0) {
    const snippets = latestTurns
      .map((t) => `${t.role}: ${truncate(t.content, MAX_SUMMARY_PREVIEW_CHARS)}`)
      .join(" | ");
    lines.push(`Recent turns: ${snippets}`);
  }

  const toolUsageMap = new Map<string, { ok: number; fail: number }>();
  for (const event of toolEvents) {
    const entry = toolUsageMap.get(event.toolName) ?? { ok: 0, fail: 0 };
    if (event.status === "success") entry.ok++;
    else entry.fail++;
    toolUsageMap.set(event.toolName, entry);
  }

  if (toolUsageMap.size > 0) {
    const toolLine = [...toolUsageMap.entries()]
      .sort((a, b) => (b[1].ok + b[1].fail) - (a[1].ok + a[1].fail))
      .slice(0, 5)
      .map(([name, usage]) => `${name} (ok:${usage.ok}, fail:${usage.fail})`)
      .join(", ");
    lines.push(`Tools used: ${toolLine}`);
  }

  const recentFailures = toolEvents
    .filter((e) => e.status === "failed" && e.errorMessage)
    .slice(-3);

  if (recentFailures.length > 0) {
    const failures = recentFailures
      .map((f) => `${f.toolName}: ${truncate(f.errorMessage ?? "", 80)}`)
      .join(" | ");
    lines.push(`Recent failures: ${failures}`);
  }

  const summaryText = lines.join("\n");
  const toolNames = [...toolUsageMap.keys()];
  const _keywords = [...new Set([...buildKeywordList(userTopics), ...toolNames])];

  return summaryText;
}
