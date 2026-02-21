import type { RunDigest } from "../../memory/run-working-memory.js";

/**
 * Renders a compact block injected into the system prompt at the start of
 * each new run, giving the agent continuity from what it did last turn.
 */
export function renderLastRunSection(digest: RunDigest): string {
  const lines: string[] = [
    `[Previous Run]`,
    `Goal: ${digest.goal ?? "unspecified"}`,
    `Outcome: ${digest.endStatus} — ${digest.totalSteps} steps, ${digest.toolCallsMade} tool calls`,
  ];

  if (digest.keyFacts.length > 0) {
    lines.push(`Key facts learned:`);
    const cap = 5;
    for (const fact of digest.keyFacts.slice(0, cap)) {
      lines.push(`  • ${fact}`);
    }
    if (digest.keyFacts.length > cap) {
      lines.push(`  (+ ${digest.keyFacts.length - cap} more in full log)`);
    }
  }

  if (digest.unresolvedErrors > 0) {
    lines.push(`⚠ ${digest.unresolvedErrors} unresolved error(s) from previous run`);
  }

  lines.push(`Run log: ${digest.filePath}`);
  return lines.join("\n");
}
