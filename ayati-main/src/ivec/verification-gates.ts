import type { ActOutput, VerifyOutput } from "./types.js";

interface DeterministicFindings {
  facts: string[];
  artifacts: string[];
}

const COMMON_NOISE_TOKENS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "named",
  "name",
  "called",
  "folder",
  "directory",
  "file",
  "path",
  "return",
  "find",
  "search",
  "locate",
  "discover",
  "where",
  "across",
  "machine",
  "user",
  "home",
  "should",
  "succeed",
]);

const ABSOLUTE_PATH_RE = /(?:^|[\s"'`])((?:\/[A-Za-z0-9._+%~,:@=-]+)+\/?)/g;
const URL_RE = /(https?:\/\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+)/g;

function normalizeText(text: string): string {
  return text.trim().toLowerCase();
}

function isNoProgressOutput(output: string): boolean {
  const text = normalizeText(output);
  if (text.length === 0) return true;

  return (
    text === "(no matches)" ||
    text === "(empty directory)" ||
    text.includes("no matches") ||
    text.includes("not found") ||
    text.includes("no such file") ||
    text.includes("does not exist")
  );
}

function expectsDiscoveryOutcome(successCriteria: string): boolean {
  return /(find|locate|search|discover|path|file|directory|folder|where)/i.test(successCriteria);
}

function allowsAbsenceOutcome(successCriteria: string): boolean {
  return /(confirm|verify|ensure).*(absence|missing|not found|does not exist|no matches)/i.test(successCriteria);
}

/**
 * Machine-checkable verification gates. Pure deterministic functions — no LLM calls.
 *
 * Gates checked in order:
 * 1. No-tools gate: Zero tool calls + non-empty finalText → passed: true
 * 2. Mixed-result gate: evaluate successful outputs and failed tool errors together
 * 3. Discovery no-progress gate: discovery intent with no matches and absence not allowed → passed: false
 * 4. All-success-with-output gate: successful calls with output → passed: true
 *
 * Returns null if no gate matched (triggers LLM fallback in executor).
 */
export function checkVerificationGates(
  actOutput: ActOutput,
  successCriteria: string,
): VerifyOutput | null {
  const { toolCalls, finalText } = actOutput;

  // Gate 1: No-tools gate
  if (toolCalls.length === 0 && finalText.trim().length > 0) {
    return {
      passed: true,
      method: "gate",
      evidence: `No tools called, assistant produced text response.`,
      newFacts: [],
      artifacts: [],
    };
  }

  // Gate 2+: Tool-call outcomes
  if (toolCalls.length > 0) {
    const successfulCalls = toolCalls.filter((call) => !call.error);
    const failedCalls = toolCalls.filter((call) => !!call.error);
    const findings = extractDeterministicFindings(toolCalls, successCriteria);
    const outputs = successfulCalls.map((call) => call.output ?? "");
    const hasOutput = outputs.some((output) => output.trim().length > 0);
    const usefulOutput = outputs.some((output) => output.trim().length > 0 && !isNoProgressOutput(output));
    const hasCriticalBlocker = failedCalls.some((call) => isCriticalToolError(call.error ?? ""));

    if (successfulCalls.length === 0 && failedCalls.length > 0) {
      return {
        passed: false,
        method: "gate",
        evidence: `All tool calls failed: ${formatToolErrors(failedCalls)}`,
        newFacts: [],
        artifacts: [],
      };
    }

    if (
      successfulCalls.length > 0 &&
      expectsDiscoveryOutcome(successCriteria) &&
      !allowsAbsenceOutcome(successCriteria) &&
      outputs.every((output) => isNoProgressOutput(output))
    ) {
      return {
        passed: false,
        method: "gate",
        evidence: "Tools executed but returned no matches / no progress for the requested discovery outcome.",
        newFacts: [],
        artifacts: [],
      };
    }

    if (usefulOutput && hasCriticalBlocker) {
      return {
        passed: false,
        method: "gate",
        evidence: `Useful output found but blocked by critical failure: ${formatToolErrors(failedCalls)}`,
        newFacts: [],
        artifacts: [],
      };
    }

    if (usefulOutput && !hasCriticalBlocker) {
      const warningSuffix = failedCalls.length > 0
        ? ` Some calls failed: ${formatToolErrors(failedCalls)}`
        : "";
      const findingsSuffix = findings.facts.length > 0
        ? ` Extracted facts: ${findings.facts.join(", ")}`
        : "";
      return {
        passed: true,
        method: "gate",
        evidence: `At least one tool produced useful output.${warningSuffix}${findingsSuffix}`,
        newFacts: findings.facts,
        artifacts: findings.artifacts,
      };
    }

    if (hasCriticalBlocker && failedCalls.length > 0 && !usefulOutput) {
      return {
        passed: false,
        method: "gate",
        evidence: `Critical tool failure: ${formatToolErrors(failedCalls)}`,
        newFacts: [],
        artifacts: [],
      };
    }

    if (failedCalls.length > 0 && !usefulOutput) {
      return {
        passed: false,
        method: "gate",
        evidence: `Tool call failures prevented useful progress: ${formatToolErrors(failedCalls)}`,
        newFacts: [],
        artifacts: [],
      };
    }

    if (successfulCalls.length > 0 && hasOutput) {
      return {
        passed: true,
        method: "gate",
        evidence: "All tools completed successfully with output.",
        newFacts: findings.facts,
        artifacts: findings.artifacts,
      };
    }
  }

  // No gate matched — LLM fallback needed
  return null;
}

function formatToolErrors(calls: Array<{ tool: string; error?: string }>): string {
  return calls
    .filter((call) => call.error)
    .map((call) => `${call.tool}: ${call.error}`)
    .join("; ");
}

function isCriticalToolError(error: string): boolean {
  const normalized = normalizeText(error);
  return (
    normalized.includes("permission denied") ||
    normalized.includes("eacces") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("validation error")
  );
}

function extractDeterministicFindings(
  toolCalls: Array<{ tool: string; output: string; error?: string }>,
  successCriteria: string,
): DeterministicFindings {
  const tokens = extractTargetTokens(successCriteria);
  const facts = new Set<string>();
  const artifacts = new Set<string>();
  const maxFacts = 10;

  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i];
    if (!call || call.error) continue;

    const paths = extractPathsForTool(call.tool, call.output);
    const urls = extractUrls(call.output);
    const relevantPaths = filterRelevantValues(paths, tokens);
    const relevantUrls = filterRelevantValues(urls, tokens);

    if (relevantPaths.length === 0 && relevantUrls.length === 0) {
      continue;
    }

    artifacts.add(`tool:${call.tool}#${i + 1}`);

    for (const path of relevantPaths) {
      facts.add(`found_path:${path}`);
      if (facts.size >= maxFacts) break;
    }
    if (facts.size >= maxFacts) break;

    for (const url of relevantUrls) {
      facts.add(`found_url:${url}`);
      if (facts.size >= maxFacts) break;
    }
    if (facts.size >= maxFacts) break;
  }

  return {
    facts: [...facts],
    artifacts: [...artifacts],
  };
}

function extractTargetTokens(successCriteria: string): string[] {
  const tokens = new Set<string>();
  const text = successCriteria.toLowerCase();

  for (const match of text.matchAll(/["'`]([^"'`]+)["'`]/g)) {
    const phrase = (match[1] ?? "").trim();
    if (phrase.length >= 3) {
      tokens.add(phrase);
    }
    for (const part of phrase.split(/[^a-z0-9._-]+/)) {
      if (part.length >= 3 && !COMMON_NOISE_TOKENS.has(part)) {
        tokens.add(part);
      }
    }
  }

  for (const match of text.matchAll(/\b[a-z0-9._-]{3,}\b/g)) {
    const token = match[0];
    if (!COMMON_NOISE_TOKENS.has(token)) {
      tokens.add(token);
    }
  }

  return [...tokens];
}

function filterRelevantValues(values: string[], tokens: string[]): string[] {
  if (tokens.length === 0) return values;

  return values.filter((value) => {
    const normalized = value.toLowerCase();
    return tokens.some((token) => normalized.includes(token));
  });
}

function extractPathsForTool(toolName: string, output: string): string[] {
  if (!output || output.trim().length === 0) return [];

  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "(no matches)");

  const rawCandidates: string[] = [];

  if (toolName === "find_files") {
    for (const line of lines) {
      if (line.startsWith("/")) {
        rawCandidates.push(line);
      }
    }
  }

  for (const line of lines) {
    const direct = sanitizePathCandidate(line);
    if (direct && direct.startsWith("/")) {
      rawCandidates.push(direct);
    }

    for (const match of line.matchAll(ABSOLUTE_PATH_RE)) {
      const value = sanitizePathCandidate(match[1] ?? "");
      if (value && value.startsWith("/")) {
        rawCandidates.push(value);
      }
    }
  }

  const unique = new Set<string>();
  for (const candidate of rawCandidates) {
    if (candidate.length <= 1) continue;
    if (candidate.includes("\n")) continue;
    unique.add(candidate);
  }

  return [...unique];
}

function sanitizePathCandidate(value: string): string {
  return value
    .trim()
    .replace(/^["'`]+/, "")
    .replace(/["'`),.;:]+$/, "");
}

function extractUrls(output: string): string[] {
  if (!output || output.trim().length === 0) return [];

  const urls = new Set<string>();
  for (const match of output.matchAll(URL_RE)) {
    const raw = (match[1] ?? "").trim();
    if (raw.length === 0) continue;
    const sanitized = raw.replace(/[),.;:]+$/, "");
    urls.add(sanitized);
  }
  return [...urls];
}
