import type { ContextBundle } from "./types.js";

export function buildContextEnvelope(query: string, bundle: ContextBundle): string {
  if (bundle.items.length === 0) {
    return [
      query,
      "",
      "[Document Context Sub-Agent]",
      "No reliable context could be extracted from attached documents.",
      "If the answer requires document evidence, state that evidence is insufficient.",
    ].join("\n");
  }

  const lines = [
    query,
    "",
    "[Document Context Sub-Agent]",
    "Use only the grounded context below when answering document-specific parts.",
    "If the context is insufficient, explicitly say so instead of guessing.",
    `Bundle confidence: ${bundle.confidence}`,
    "",
    "Context items:",
  ];

  bundle.items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.fact}`);
    lines.push(`   Quote: "${item.quote}"`);
    lines.push(`   Source: ${item.citation.documentPath} (${item.citation.location})`);
  });

  return lines.join("\n");
}
