const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "back",
  "continue",
  "do",
  "for",
  "go",
  "it",
  "on",
  "please",
  "resume",
  "the",
  "this",
  "to",
  "work",
]);

export function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9./_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(value: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of normalizeText(value).split(" ")) {
    const cleaned = token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    if (cleaned.length < 2 || STOP_WORDS.has(cleaned) || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    tokens.push(cleaned);
  }
  return tokens;
}

export function includesNormalizedPhrase(haystack: string, needle: string): boolean {
  const normalizedHaystack = ` ${normalizeText(haystack)} `;
  const normalizedNeedle = normalizeText(needle);
  return normalizedNeedle.length > 0 && normalizedHaystack.includes(` ${normalizedNeedle} `);
}

export function tokenOverlap(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token));
}

export function deriveTitleFromMessage(message: string, maxLength = 80): string {
  const compact = message.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "Untitled task";
  }
  const sentence = compact.split(/[.!?]/)[0]?.trim() || compact;
  return sentence.length <= maxLength ? sentence : sentence.slice(0, maxLength).trimEnd();
}
