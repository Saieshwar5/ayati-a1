import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { devLog } from "../shared/index.js";
import type { LlmProvider } from "../core/contracts/provider.js";
import type { LlmMessage, LlmResponseFormat, LlmToolSchema, LlmTurnOutput } from "../core/contracts/llm-protocol.js";
import type { GenericScoutScope, GenericScoutState, ScoutResult } from "./types.js";
import type { ManagedDocumentManifest } from "../documents/types.js";
import type { DocumentContextBackend } from "../documents/document-context-backend.js";
import { compileResponseFormatForProvider } from "../providers/shared/provider-profiles.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScoutKnownLocations {
  runPath: string;
  contextDir: string;
  sessionPath?: string;
  sessionDir?: string;
  skillsDir?: string;
  skillsDirs?: string[];
  documentsDir?: string;
  attachedDocuments?: ManagedDocumentManifest[];
  runId: string;
  activeSessionId: string;
}

export interface ContextScoutOptions {
  provider: LlmProvider;
  maxTurns: number;
  documentContextBackend?: DocumentContextBackend;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const SCOUT_TOOLS: LlmToolSchema[] = [
  {
    name: "read_file",
    description: "Read a file with line numbers. Returns up to 8000 characters.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute or relative file path" },
        offset: { type: "number", description: "Line offset (0-based)" },
        limit: { type: "number", description: "Max lines to return" },
      },
    },
  },
  {
    name: "list_directory",
    description: "List directory entries with type indicators (/ for dirs). Max 50 entries.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Directory path" },
      },
    },
  },
  {
    name: "search_content",
    description: "Regex search within files under a directory. Max depth 3, max 10 results.",
    inputSchema: {
      type: "object",
      required: ["directory", "pattern"],
      properties: {
        directory: { type: "string", description: "Root directory to search" },
        pattern: { type: "string", description: "Regex pattern to search for" },
      },
    },
  },
  {
    name: "grep_file",
    description: "Regex search within one known file. Returns only matching snippets with nearby lines. Prefer this before read_file when the target file is already known.",
    inputSchema: {
      type: "object",
      required: ["path", "pattern"],
      properties: {
        path: { type: "string", description: "Absolute or relative file path" },
        pattern: { type: "string", description: "Regex pattern to search for" },
        context_before: { type: "number", description: "Lines to include before each match" },
        context_after: { type: "number", description: "Lines to include after each match" },
        max_matches: { type: "number", description: "Maximum matches to return" },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const MAX_READ_CHARS = 8000;
const MAX_DIR_ENTRIES = 50;
const MAX_SEARCH_RESULTS = 10;
const MAX_SEARCH_DEPTH = 3;
const DEFAULT_GREP_CONTEXT_BEFORE = 2;
const DEFAULT_GREP_CONTEXT_AFTER = 2;
const DEFAULT_GREP_MAX_MATCHES = 5;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".cache"]);
const MAX_SUMMARY_ITEMS = 8;
const MAX_SUMMARY_ERRORS = 5;
const STRICT_JSON_RESPONSE_NOTE =
  "Use strict JSON syntax with double-quoted strings and lowercase true, false, and null.";
const SCOUT_JSON_REPAIR_PROMPT = `Your previous response was invalid because it was not a single valid JSON object that matched the requested shape.
Reply again with exactly one JSON object.
${STRICT_JSON_RESPONSE_NOTE}
Do not include markdown fences.
Do not include any explanation before or after the JSON.`;
const SCOUT_RESPONSE_FORMAT: LlmResponseFormat = {
  type: "json_schema",
  name: "context_scout_result",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["context", "sources", "confidence"],
    properties: {
      context: { type: "string" },
      sources: {
        type: "array",
        items: { type: "string" },
      },
      confidence: { type: "number" },
    },
  },
};

interface ScoutAccessPolicy {
  scope: GenericScoutScope;
  allowedRoots: string[];
}

function normalizeScoutRoot(pathValue?: string): string | null {
  if (!pathValue || pathValue.trim().length === 0) {
    return null;
  }
  return resolve(pathValue);
}

function normalizeScoutRoots(pathValues?: string[]): string[] {
  if (!pathValues || pathValues.length === 0) {
    return [];
  }

  return [...new Set(pathValues.map((value) => normalizeScoutRoot(value)).filter((value): value is string => Boolean(value)))];
}

function buildScoutAccessPolicy(scope: GenericScoutScope, locations: ScoutKnownLocations): ScoutAccessPolicy {
  const normalizedSkillRoots = normalizeScoutRoots(locations.skillsDirs);
  const legacySkillRoot = normalizeScoutRoot(locations.skillsDir);
  if (legacySkillRoot) {
    normalizedSkillRoots.unshift(legacySkillRoot);
  }

  const normalizedRoots = {
    runPath: normalizeScoutRoot(locations.runPath),
    contextDir: normalizeScoutRoot(locations.contextDir),
    sessionPath: normalizeScoutRoot(locations.sessionPath),
    sessionDir: normalizeScoutRoot(locations.sessionDir),
    skillsDirs: [...new Set(normalizedSkillRoots)],
  };

  const rootsByScope: Record<GenericScoutScope, Array<string | null>> = {
    run_artifacts: [normalizedRoots.runPath],
    project_context: [normalizedRoots.contextDir],
    session: [normalizedRoots.sessionPath, normalizedRoots.sessionDir],
    skills: normalizedRoots.skillsDirs,
    both: [
      normalizedRoots.runPath,
      normalizedRoots.contextDir,
      normalizedRoots.sessionPath,
      normalizedRoots.sessionDir,
      ...normalizedRoots.skillsDirs,
    ],
  };

  return {
    scope,
    allowedRoots: [...new Set(rootsByScope[scope].filter((root): root is string => Boolean(root)))],
  };
}

function canonicalizeForScope(pathValue: string): string {
  if (existsSync(pathValue)) {
    try {
      return realpathSync(pathValue);
    } catch {
      // Fall back to lexical normalization below.
    }
  }
  return resolve(pathValue);
}

function isWithinAllowedRoot(targetPath: string, rootPath: string): boolean {
  const normalizedTarget = canonicalizeForScope(targetPath);
  const normalizedRoot = canonicalizeForScope(rootPath);

  try {
    const rootStat = statSync(rootPath);
    if (rootStat.isFile()) {
      return normalizedTarget === normalizedRoot;
    }
  } catch {
    // Treat unknown roots as directories using lexical containment.
  }

  const rel = relative(normalizedRoot, normalizedTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isWithinAllowedRoots(targetPath: string, allowedRoots: string[]): boolean {
  return allowedRoots.some((root) => isWithinAllowedRoot(targetPath, root));
}

function collectScopedPathCandidates(pathValue: string, allowedRoots: string[]): string[] {
  const candidates = new Set<string>();
  candidates.add(resolve(pathValue));

  if (!isAbsolute(pathValue)) {
    for (const root of allowedRoots) {
      candidates.add(resolve(root, pathValue));
    }
  }

  return [...candidates];
}

function resolveScopedPath(
  pathValue: string,
  policy: ScoutAccessPolicy,
  kind: "path" | "directory",
): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return { ok: false, error: `[error] ${kind} is required` };
  }

  const candidates = collectScopedPathCandidates(trimmed, policy.allowedRoots);
  const inScopeCandidates = candidates.filter((candidate) => isWithinAllowedRoots(candidate, policy.allowedRoots));
  const existingCandidate = inScopeCandidates.find((candidate) => existsSync(candidate));
  if (existingCandidate) {
    return { ok: true, path: existingCandidate };
  }

  if (inScopeCandidates[0]) {
    return { ok: true, path: inScopeCandidates[0] };
  }

  return {
    ok: false,
    error: `[error] ${kind} outside allowed scope (${policy.scope})`,
  };
}

function executeReadFile(input: Record<string, unknown>, policy: ScoutAccessPolicy): string {
  const filePath = String(input["path"] ?? "");
  if (!filePath) return "[error] path is required";
  const resolved = resolveScopedPath(filePath, policy, "path");
  if (!resolved.ok) return resolved.error;
  const resolvedPath = resolved.path;
  if (!existsSync(resolvedPath)) return `[error] file not found: ${resolvedPath}`;

  try {
    const raw = readFileSync(resolvedPath, "utf-8");
    const lines = raw.split("\n");
    const offset = Math.max(0, Number(input["offset"]) || 0);
    const limit = Number(input["limit"]) || lines.length;
    const slice = lines.slice(offset, offset + limit);

    let result = "";
    for (let i = 0; i < slice.length; i++) {
      const lineNum = offset + i + 1;
      const line = `${String(lineNum).padStart(4)} | ${slice[i]}\n`;
      if (result.length + line.length > MAX_READ_CHARS) {
        result += `\n... truncated at ${MAX_READ_CHARS} chars (${lines.length} total lines)`;
        break;
      }
      result += line;
    }
    return result || "[empty file]";
  } catch (err) {
    return `[error] ${err instanceof Error ? err.message : String(err)}`;
  }
}

function executeListDirectory(input: Record<string, unknown>, policy: ScoutAccessPolicy): string {
  const dirPath = String(input["path"] ?? "");
  if (!dirPath) return "[error] path is required";
  const resolved = resolveScopedPath(dirPath, policy, "directory");
  if (!resolved.ok) return resolved.error;
  const resolvedPath = resolved.path;
  if (!existsSync(resolvedPath)) return `[error] directory not found: ${resolvedPath}`;

  try {
    const entries = readdirSync(resolvedPath);
    const lines: string[] = [];
    for (const entry of entries.slice(0, MAX_DIR_ENTRIES)) {
      try {
        const fullPath = join(resolvedPath, entry);
        const stat = statSync(fullPath);
        lines.push(stat.isDirectory() ? `${entry}/` : entry);
      } catch {
        lines.push(`${entry} [stat error]`);
      }
    }
    if (entries.length > MAX_DIR_ENTRIES) {
      lines.push(`... and ${entries.length - MAX_DIR_ENTRIES} more entries`);
    }
    return lines.join("\n") || "[empty directory]";
  } catch (err) {
    return `[error] ${err instanceof Error ? err.message : String(err)}`;
  }
}

function executeSearchContent(input: Record<string, unknown>, policy: ScoutAccessPolicy): string {
  const directory = String(input["directory"] ?? "");
  const pattern = String(input["pattern"] ?? "");
  if (!directory || !pattern) return "[error] directory and pattern are required";
  const resolved = resolveScopedPath(directory, policy, "directory");
  if (!resolved.ok) return resolved.error;
  const resolvedPath = resolved.path;
  if (!existsSync(resolvedPath)) return `[error] directory not found: ${resolvedPath}`;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    return `[error] invalid regex: ${pattern}`;
  }

  const results: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > MAX_SEARCH_DEPTH || results.length >= MAX_SEARCH_RESULTS) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS) return;
      if (SKIP_DIRS.has(entry)) continue;
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (stat.isFile() && stat.size < 500_000) {
          const content = readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= MAX_SEARCH_RESULTS) return;
            const line = lines[i];
            if (line && regex.test(line)) {
              const relPath = relative(resolvedPath, fullPath);
              results.push(`${relPath}:${i + 1}: ${line.slice(0, 200)}`);
            }
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  walk(resolvedPath, 0);
  return results.length > 0
    ? results.join("\n")
    : `[no matches for pattern "${pattern}" in ${resolvedPath}]`;
}

function executeGrepFile(input: Record<string, unknown>, policy: ScoutAccessPolicy): string {
  const filePath = String(input["path"] ?? "");
  const pattern = String(input["pattern"] ?? "");
  if (!filePath || !pattern) return "[error] path and pattern are required";
  const resolved = resolveScopedPath(filePath, policy, "path");
  if (!resolved.ok) return resolved.error;
  const resolvedPath = resolved.path;
  if (!existsSync(resolvedPath)) return `[error] file not found: ${resolvedPath}`;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    return `[error] invalid regex: ${pattern}`;
  }

  let stat;
  try {
    stat = statSync(resolvedPath);
  } catch (err) {
    return `[error] ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!stat.isFile()) return `[error] path is not a file: ${resolvedPath}`;

  const contextBefore = Math.max(0, Number(input["context_before"]) || DEFAULT_GREP_CONTEXT_BEFORE);
  const contextAfter = Math.max(0, Number(input["context_after"]) || DEFAULT_GREP_CONTEXT_AFTER);
  const maxMatches = Math.max(1, Number(input["max_matches"]) || DEFAULT_GREP_MAX_MATCHES);

  try {
    const raw = readFileSync(resolvedPath, "utf-8");
    const lines = raw.split("\n");
    const matches: Array<{ start: number; end: number; matchLine: number }> = [];
    const seenRanges = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !regex.test(line)) continue;

      const start = Math.max(0, i - contextBefore);
      const end = Math.min(lines.length - 1, i + contextAfter);
      const rangeKey = `${start}:${end}`;
      if (seenRanges.has(rangeKey)) {
        continue;
      }
      seenRanges.add(rangeKey);
      matches.push({ start, end, matchLine: i });
      if (matches.length >= maxMatches) {
        break;
      }
    }

    if (matches.length === 0) {
      return `[no matches for pattern "${pattern}" in ${resolvedPath}]`;
    }

    let result = "";
    for (let idx = 0; idx < matches.length; idx++) {
      const match = matches[idx]!;
      const header = `Match ${idx + 1} (lines ${match.start + 1}-${match.end + 1}, matched line ${match.matchLine + 1})\n`;
      if (result.length + header.length > MAX_READ_CHARS) {
        result += `\n... truncated at ${MAX_READ_CHARS} chars`;
        break;
      }
      result += header;

      for (let lineIdx = match.start; lineIdx <= match.end; lineIdx++) {
        const line = `${String(lineIdx + 1).padStart(4)} | ${lines[lineIdx]}\n`;
        if (result.length + line.length > MAX_READ_CHARS) {
          result += `\n... truncated at ${MAX_READ_CHARS} chars`;
          return result;
        }
        result += line;
      }

      if (idx < matches.length - 1) {
        const separator = "\n";
        if (result.length + separator.length > MAX_READ_CHARS) {
          result += `\n... truncated at ${MAX_READ_CHARS} chars`;
          break;
        }
        result += separator;
      }
    }

    return result.trimEnd();
  } catch (err) {
    return `[error] ${err instanceof Error ? err.message : String(err)}`;
  }
}

function executeTool(name: string, input: unknown, policy: ScoutAccessPolicy): string {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  switch (name) {
    case "read_file":
      return executeReadFile(args, policy);
    case "list_directory":
      return executeListDirectory(args, policy);
    case "search_content":
      return executeSearchContent(args, policy);
    case "grep_file":
      return executeGrepFile(args, policy);
    default:
      return `[error] unknown tool: ${name}`;
  }
}

interface ScoutAttemptSummary {
  searchedLocations: string[];
  attemptedSearches: string[];
  errors: string[];
  discoveredSources: string[];
}

interface ScoutToolRecord {
  name: string;
  input: Record<string, unknown>;
  result: string;
  discoveredSources: string[];
}

function createScoutAttemptSummary(): ScoutAttemptSummary {
  return {
    searchedLocations: [],
    attemptedSearches: [],
    errors: [],
    discoveredSources: [],
  };
}

function pushUniqueLimited(target: string[], value: string | undefined, limit: number): void {
  const normalized = value?.trim();
  if (!normalized || target.includes(normalized) || target.length >= limit) {
    return;
  }
  target.push(normalized);
}

function summarizeToolCall(name: string, input: unknown): string {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  switch (name) {
    case "read_file":
      return `read_file path=${String(args["path"] ?? "")}`;
    case "list_directory":
      return `list_directory path=${String(args["path"] ?? "")}`;
    case "search_content":
      return `search_content directory=${String(args["directory"] ?? "")} pattern=${String(args["pattern"] ?? "")}`;
    case "grep_file":
      return `grep_file path=${String(args["path"] ?? "")} pattern=${String(args["pattern"] ?? "")}`;
    default:
      return `${name} ${JSON.stringify(args)}`;
  }
}

function recordScoutAttempt(
  summary: ScoutAttemptSummary,
  name: string,
  input: unknown,
  result: string,
): void {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  pushUniqueLimited(summary.attemptedSearches, summarizeToolCall(name, input), MAX_SUMMARY_ITEMS);

  if (typeof args["path"] === "string") {
    pushUniqueLimited(summary.searchedLocations, args["path"], MAX_SUMMARY_ITEMS);
  }
  if (typeof args["directory"] === "string") {
    pushUniqueLimited(summary.searchedLocations, args["directory"], MAX_SUMMARY_ITEMS);
  }

  const discoveredSources = extractToolDiscoveredSources(name, args, result);
  for (const source of discoveredSources) {
    pushUniqueLimited(summary.discoveredSources, source, MAX_SUMMARY_ITEMS);
  }

  if (result.startsWith("[error]")) {
    pushUniqueLimited(summary.errors, result, MAX_SUMMARY_ERRORS);
  }
}

function createScoutToolRecord(
  name: string,
  input: unknown,
  result: string,
): ScoutToolRecord {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  return {
    name,
    input: args,
    result,
    discoveredSources: extractToolDiscoveredSources(name, args, result),
  };
}

function formatScoutProviderError(error: unknown, phase: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return `[provider_error] ${phase}: ${message}`;
}

function buildScoutProviderFailureResult(input: {
  summary: ScoutAttemptSummary;
  toolHistory: ScoutToolRecord[];
  error: unknown;
  phase: string;
  query: string;
  scope: GenericScoutScope;
}): ScoutResult {
  pushUniqueLimited(
    input.summary.errors,
    formatScoutProviderError(input.error, input.phase),
    MAX_SUMMARY_ERRORS,
  );

  if (input.scope === "skills") {
    const verbatimFallback = buildSkillsScoutFallback(input.toolHistory);
    if (verbatimFallback) {
      return verbatimFallback;
    }
  }

  return buildScoutFailureResult({
    status: "empty",
    query: input.query,
    scope: input.scope,
    summary: input.summary,
  });
}

function extractToolDiscoveredSources(
  name: string,
  input: Record<string, unknown>,
  result: string,
): string[] {
  if (result.startsWith("[error]")) {
    return [];
  }

  if (name === "read_file" || name === "grep_file") {
    return typeof input["path"] === "string" ? [input["path"]] : [];
  }

  if (name === "list_directory") {
    return typeof input["path"] === "string" ? [input["path"]] : [];
  }

  if (name !== "search_content" || typeof input["directory"] !== "string") {
    return [];
  }

  const directory = input["directory"];
  const lines = result.split("\n");
  const sources: string[] = [];
  for (const line of lines) {
    const match = line.match(/^([^:\n]+):\d+:/);
    if (!match?.[1]) continue;
    pushUniqueLimited(sources, join(directory, match[1]), MAX_SUMMARY_ITEMS);
  }
  return sources;
}

function buildScoutFailureResult(input: {
  status: GenericScoutState["status"];
  query: string;
  scope: GenericScoutScope;
  summary: ScoutAttemptSummary;
}): ScoutResult {
  const searchedLocations = input.summary.searchedLocations.slice(0, MAX_SUMMARY_ITEMS);
  const attemptedSearches = input.summary.attemptedSearches.slice(0, MAX_SUMMARY_ITEMS);
  const errors = input.summary.errors.slice(0, MAX_SUMMARY_ERRORS);
  const discoveredSources = input.summary.discoveredSources.slice(0, MAX_SUMMARY_ITEMS);
  const whatWasSearched = searchedLocations.length > 0
    ? searchedLocations.map((entry) => `- ${entry}`)
    : ["- No valid search locations were recorded."];
  const searchAttempts = attemptedSearches.length > 0
    ? attemptedSearches.map((entry) => `- ${entry}`)
    : ["- No tool attempts were recorded."];
  const findings = discoveredSources.length > 0
    ? discoveredSources.map((entry) => `- ${entry}`)
    : ["- no grounded context found"];
  const lines = [
    `Context search status: ${input.status}`,
    `Scope: ${input.scope}`,
    `Query: ${input.query}`,
    "",
    "What was searched:",
    ...whatWasSearched,
    "",
    "Search attempts:",
    ...searchAttempts,
    "",
    "Findings:",
    ...findings,
  ];

  if (errors.length > 0) {
    lines.push("", "Errors:", ...errors.map((entry) => `- ${entry}`));
  }

  lines.push(
    "",
    "Guidance:",
    "- Do not repeat the same or equivalent context_search in this iteration.",
    "- Retry only if the query materially narrows or the scope changes.",
  );

  return {
    context: lines.join("\n"),
    sources: [...new Set([...searchedLocations, ...discoveredSources])],
    confidence: 0,
    scoutState: {
      status: input.status,
      scope: input.scope,
      query: input.query,
      searchedLocations,
      attemptedSearches,
      errors,
    },
  };
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildScoutSystemPrompt(
  query: string,
  scope: GenericScoutScope,
  locations: ScoutKnownLocations,
): string {
  const skillDirectories = normalizeScoutRoots([
    ...(locations.skillsDirs ?? []),
    ...(locations.skillsDir ? [locations.skillsDir] : []),
  ]);
  const skillsScopeInstruction = skillDirectories.length > 0
    ? `Only search within these skills directories:\n${skillDirectories.map((dir) => `- ${dir}`).join("\n")}\nEach subdirectory contains a skill doc file such as skill.md or SKILL.md. Read the relevant skill docs to get the full command reference. If the query clearly requires multiple skills for the same step, read the minimum sufficient set of relevant skill docs in one pass and return all of their sources.`
    : "No skills directory available.";
  const skillsLocationBlock = skillDirectories.length > 0
    ? `- External skills directories:\n${skillDirectories.map((dir) => `  - ${dir}`).join("\n")}\n  - Each subdirectory has a skill doc such as skill.md or SKILL.md with the CLI command reference`
    : "";
  const accessPolicy = buildScoutAccessPolicy(scope, locations);
  const allowedRootsBlock = accessPolicy.allowedRoots.length > 0
    ? accessPolicy.allowedRoots.map((root) => `- ${root}`).join("\n")
    : "- No allowed roots are configured for this scope.";
  const scopeInstructions: Record<string, string> = {
    run_artifacts: [
      `Only search within the run directory: ${locations.runPath}`,
      "Default to the current run. Do not search unrelated run folders unless the query explicitly asks for earlier runs with a specific run path/run ID.",
    ].join("\n"),
    project_context: `Only search within the context directory: ${locations.contextDir}`,
    session: [
      `Only search session data.`,
      locations.sessionPath ? `Active session file: ${locations.sessionPath}` : "No active session file available.",
      locations.sessionDir ? `Session data directory: ${locations.sessionDir}` : "",
    ].filter(Boolean).join("\n"),
    skills: skillsScopeInstruction,
    both: "You may search only the known scout locations listed below, and no other directories or files.",
  };
  const contextInstructions = scope === "skills"
    ? [
      "- context: return only the relevant skill-file excerpts needed for the caller, copied verbatim from tool output.",
      "- Do not paraphrase, compress, rewrite, or normalize commands, flags, paths, env vars, examples, or surrounding lines you keep.",
      "- Prefer grep_file to isolate exact command sections. Use read_file only when a larger contiguous block is required.",
      "- Format each relevant skill block as:",
      "  Source: <path>",
      "  Lines: <line range if visible in the excerpt>",
      "  Excerpt:",
      "  <verbatim tool excerpt>",
      "- Keep only relevant sections, but preserve the retained lines exactly.",
    ].join("\n")
    : [
      "- context: retrieve the minimum sufficient grounded context needed for the caller. Preserve exact commands, flags, paths, schemas, and quoted text verbatim. Do not paraphrase when exact wording matters. Trim only irrelevant surrounding text.",
      "- Keep context concise but informative (under 500 tokens).",
    ].join("\n");

  return `You are a Context Scout — a focused retrieval sub-agent.
Your job: find, read, and retrieve the minimum sufficient grounded context relevant to a specific query.

Query: ${query}

Known locations:
- Run artifacts: ${locations.runPath}
  - ${locations.runPath}/state.json — loop state snapshot
    - includes run status and completedSteps[] history for this run
    - completedSteps[] has step, executionContract, outcome, summary, newFacts, artifacts, toolSuccessCount, toolFailureCount
  - ${locations.runPath}/steps/<NNN>-act.md — step action details (markdown)
  - ${locations.runPath}/steps/<NNN>-verify.md — step verification details (markdown)
  - step filenames use zero-padded numbers (example: 001, 002)
- Project context: ${locations.contextDir}
  - ${locations.contextDir}/soul.json, system_prompt.md, user_profile.json, user.wiki, user.wiki.schema
${locations.sessionPath ? `- Active session: ${locations.sessionPath}` : "- Active session: (not available)"}
${locations.sessionDir ? `- Session data directory: ${locations.sessionDir}` : ""}
${skillsLocationBlock}

Run ID: ${locations.runId}
Active session ID: ${locations.activeSessionId}

Scope: ${scope}
${scopeInstructions[scope] ?? ""}
Allowed roots for this scope:
${allowedRootsBlock}

Instructions:
- Use the provided tools to find and read relevant files.
- Any tool call that targets a path outside the allowed roots will fail.
- Use search_content to discover which file matters when the target file is not yet known.
- Use grep_file to narrow within a known file and return only the matching snippets with nearby lines.
- Use read_file only when you need a larger block after grep_file, or when the file is already known and small enough to read directly.
- For run_artifacts queries, read state.json first to locate the exact step numbers/files, then read targeted step markdown files.
- For skills queries, do not stop after the first matching skill if the query asks for multiple related skills. Read the minimum sufficient set of relevant skill docs and include all consulted skill files in sources.
- Stop once you have enough information to answer the query.
- If you check the most relevant locations and find nothing, return an empty context.
- When done, respond with a JSON object (no tool calls):
  { "context": "...", "sources": ["file1", "file2"], "confidence": 0.0-1.0 }
- confidence: 1.0 = found exactly what was needed, 0.0 = found nothing relevant
- sources: list every file path you actually consulted for the final answer
- If scope is skills, the final context must be copied verbatim from the skill-file excerpts you retrieved with tools.
- If scope is skills and your draft answer paraphrases commands, replace it with the verbatim excerpts before responding.
${contextInstructions}`;
}

// ---------------------------------------------------------------------------
// Scout loop
// ---------------------------------------------------------------------------

export async function runContextScout(
  options: ContextScoutOptions,
  query: string,
  scope: "run_artifacts" | "project_context" | "session" | "skills" | "documents" | "both",
  knownLocations: ScoutKnownLocations,
  requestedDocumentPaths?: string[],
): Promise<ScoutResult> {
  if (scope === "documents") {
    if (!options.documentContextBackend) {
      return {
        context: "Document context search is unavailable because no document backend is configured.",
        sources: [],
        confidence: 0,
        documentState: {
          status: "unavailable",
          insufficientEvidence: true,
          warnings: ["No document backend is configured."],
        },
      };
    }

    return options.documentContextBackend.search({
      provider: options.provider,
      query,
      attachedDocuments: knownLocations.attachedDocuments ?? [],
      requestedDocumentPaths,
    });
  }

  return runGenericContextScout(
    options,
    query,
    scope,
    knownLocations,
  );
}

async function runGenericContextScout(
  options: ContextScoutOptions,
  query: string,
  scope: GenericScoutScope,
  knownLocations: ScoutKnownLocations,
): Promise<ScoutResult> {
  const { provider, maxTurns } = options;
  const attemptSummary = createScoutAttemptSummary();
  const toolHistory: ScoutToolRecord[] = [];
  const accessPolicy = buildScoutAccessPolicy(scope, knownLocations);
  const responseFormat = resolveScoutResponseFormat(provider);

  devLog(`[scout] invoked: query="${query.slice(0, 80)}", scope=${scope}`);

  const systemPrompt = buildScoutSystemPrompt(query, scope, knownLocations);
  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Find information for: ${query}` },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    let response: LlmTurnOutput;
    try {
      response = await provider.generateTurn({
        messages,
        tools: SCOUT_TOOLS,
        ...(responseFormat ? { responseFormat } : {}),
      });
    } catch (error) {
      return buildScoutProviderFailureResult({
        summary: attemptSummary,
        toolHistory,
        error,
        phase: `turn ${turn + 1}`,
        query,
        scope,
      });
    }

    if (response.type === "assistant") {
      devLog(`[scout] text response at turn ${turn}, parsing result`);
      const parsed = tryParseScoutResult(response.content);
      if (!parsed) {
        devLog(`[scout] invalid JSON response at turn ${turn}, requesting repair`);
        let repaired: LlmTurnOutput;
        try {
          repaired = await retryScoutResponseRepair(provider, messages, response, responseFormat);
        } catch (error) {
          return buildScoutProviderFailureResult({
            summary: attemptSummary,
            toolHistory,
            error,
            phase: `repair after turn ${turn + 1}`,
            query,
            scope,
          });
        }
        if (repaired.type === "assistant") {
          const repairedParsed = tryParseScoutResult(repaired.content);
          if (!repairedParsed) {
            devLog("[scout] repair failed, using plain text fallback");
            if (scope === "skills") {
              const verbatimFallback = buildSkillsScoutFallback(toolHistory);
              if (verbatimFallback) {
                return verbatimFallback;
              }
            }
            return buildScoutPlainTextFallback(repaired.content);
          }
          if (repairedParsed.context.trim().length === 0 && repairedParsed.confidence === 0) {
            if (scope === "skills") {
              const verbatimFallback = buildSkillsScoutFallback(toolHistory);
              if (verbatimFallback) {
                return verbatimFallback;
              }
            }
            return buildScoutFailureResult({
              status: "empty",
              query,
              scope,
              summary: attemptSummary,
            });
          }
          if (scope === "skills") {
            return finalizeSkillsScoutResult(repairedParsed, toolHistory);
          }
          return repairedParsed;
        }

        if (repaired.assistantContent) {
          messages.push({ role: "assistant", content: repaired.assistantContent });
        }

        messages.push({
          role: "assistant_tool_calls",
          calls: repaired.calls,
        });

        for (const call of repaired.calls) {
          devLog(`[scout] tool call: ${call.name}(${JSON.stringify(call.input).slice(0, 100)})`);
          const result = executeTool(call.name, call.input, accessPolicy);
          devLog(`[scout] tool result: ${result.length} chars${result.startsWith("[error]") ? " (error)" : ""}`);
          recordScoutAttempt(attemptSummary, call.name, call.input, result);
          toolHistory.push(createScoutToolRecord(call.name, call.input, result));
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: result,
          });
        }
        continue;
      }

      if (parsed.context.trim().length === 0 && parsed.confidence === 0) {
        if (scope === "skills") {
          const verbatimFallback = buildSkillsScoutFallback(toolHistory);
          if (verbatimFallback) {
            return verbatimFallback;
          }
        }
        return buildScoutFailureResult({
          status: "empty",
          query,
          scope,
          summary: attemptSummary,
        });
      }
      if (scope === "skills") {
        return finalizeSkillsScoutResult(parsed, toolHistory);
      }
      return parsed;
    }

    if (response.type === "tool_calls") {
      if (response.assistantContent) {
        messages.push({ role: "assistant", content: response.assistantContent });
      }

      messages.push({
        role: "assistant_tool_calls",
        calls: response.calls,
      });

      for (const call of response.calls) {
        devLog(`[scout] tool call: ${call.name}(${JSON.stringify(call.input).slice(0, 100)})`);
        const result = executeTool(call.name, call.input, accessPolicy);
        devLog(`[scout] tool result: ${result.length} chars${result.startsWith("[error]") ? " (error)" : ""}`);
        recordScoutAttempt(attemptSummary, call.name, call.input, result);
        toolHistory.push(createScoutToolRecord(call.name, call.input, result));
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: result,
        });
      }
    }
  }

  devLog("[scout] max turns exhausted, returning empty result");
  if (scope === "skills") {
    const verbatimFallback = buildSkillsScoutFallback(toolHistory);
    if (verbatimFallback) {
      return verbatimFallback;
    }
  }
  return buildScoutFailureResult({
    status: "max_turns_exhausted",
    query,
    scope,
    summary: attemptSummary,
  });
}

function resolveScoutResponseFormat(provider: LlmProvider): LlmResponseFormat | undefined {
  return compileResponseFormatForProvider(provider.name, provider.capabilities, SCOUT_RESPONSE_FORMAT);
}

async function retryScoutResponseRepair(
  provider: LlmProvider,
  messages: LlmMessage[],
  response: Extract<LlmTurnOutput, { type: "assistant" }>,
  responseFormat: LlmResponseFormat | undefined,
): Promise<LlmTurnOutput> {
  const retryMessages: LlmMessage[] = [
    ...messages,
    ...(response.content.trim().length > 0 ? [{ role: "assistant" as const, content: response.content }] : []),
    { role: "user" as const, content: SCOUT_JSON_REPAIR_PROMPT },
  ];

  return provider.generateTurn({
    messages: retryMessages,
    ...(responseFormat ? { responseFormat } : {}),
  });
}

function tryParseScoutResult(text: string): ScoutResult | null {
  const normalized = unwrapJsonFence(text.trim());
  const direct = tryParseJsonRecordWithRecovery(normalized);
  if (direct) return normalizeScoutResult(direct);

  const extracted = findFirstJsonObject(normalized);
  if (!extracted) return null;

  const parsed = tryParseJsonRecordWithRecovery(extracted);
  return parsed ? normalizeScoutResult(parsed) : null;
}

function normalizeScoutResult(parsed: Record<string, unknown>): ScoutResult {
  const context = String(parsed["context"] ?? "");
  return {
    context,
    sources: Array.isArray(parsed["sources"])
      ? (parsed["sources"] as unknown[]).map(String)
      : [],
    confidence: Math.min(1, Math.max(0, Number(parsed["confidence"]) || 0)),
  };
}

function buildScoutPlainTextFallback(text: string): ScoutResult {
  return {
    context: text.trim().slice(0, 2000),
    sources: [],
    confidence: 0.5,
  };
}

function finalizeSkillsScoutResult(base: ScoutResult, toolHistory: ScoutToolRecord[]): ScoutResult {
  const verbatim = buildSkillsVerbatimContext(base.sources, toolHistory);
  if (!verbatim) {
    return base;
  }

  return {
    context: verbatim.context,
    sources: verbatim.sources,
    confidence: base.confidence,
  };
}

function buildSkillsScoutFallback(toolHistory: ScoutToolRecord[]): ScoutResult | null {
  const verbatim = buildSkillsVerbatimContext([], toolHistory);
  if (!verbatim) {
    return null;
  }

  return {
    context: verbatim.context,
    sources: verbatim.sources,
    confidence: 0.75,
  };
}

function buildSkillsVerbatimContext(
  preferredSources: string[],
  toolHistory: ScoutToolRecord[],
): { context: string; sources: string[] } | null {
  const preferred = uniqueStrings(preferredSources.map(normalizeSourceValue));
  const discovered = uniqueStrings(toolHistory.flatMap((record) => record.discoveredSources.map(normalizeSourceValue)));
  const sourceOrder = preferred.length > 0 ? preferred : discovered;
  if (sourceOrder.length === 0) {
    return null;
  }

  const blocks: string[] = [];
  const usedSources: string[] = [];
  for (const source of sourceOrder) {
    const excerpts = collectSkillsExcerptsForSource(source, toolHistory);
    if (excerpts.length === 0) {
      continue;
    }

    const lines = uniqueStrings(excerpts.map((excerpt) => extractVisibleLineRange(excerpt)).filter((value): value is string => Boolean(value)));
    const header = [`Source: ${source}`];
    if (lines.length > 0) {
      header.push(`Lines: ${lines.join("; ")}`);
    }
    header.push("Excerpt:");

    blocks.push(`${header.join("\n")}\n${excerpts.join("\n\n")}`);
    usedSources.push(source);
  }

  if (blocks.length === 0) {
    return null;
  }

  return {
    context: blocks.join("\n\n"),
    sources: usedSources,
  };
}

function collectSkillsExcerptsForSource(source: string, toolHistory: ScoutToolRecord[]): string[] {
  const direct = uniqueStrings(toolHistory.map((record) => buildDirectSkillsExcerpt(record, source)).filter((value): value is string => Boolean(value)));
  if (direct.length > 0) {
    return direct;
  }

  return uniqueStrings(toolHistory.map((record) => buildSearchSkillsExcerpt(record, source)).filter((value): value is string => Boolean(value)));
}

function buildDirectSkillsExcerpt(record: ScoutToolRecord, source: string): string | null {
  if ((record.name !== "read_file" && record.name !== "grep_file") || record.result.startsWith("[error]")) {
    return null;
  }

  const recordPath = typeof record.input["path"] === "string" ? normalizeSourceValue(record.input["path"]) : "";
  if (!sourceMatches(source, recordPath)) {
    return null;
  }

  return record.result.trim();
}

function buildSearchSkillsExcerpt(record: ScoutToolRecord, source: string): string | null {
  if (record.name !== "search_content" || record.result.startsWith("[error]")) {
    return null;
  }

  const directory = typeof record.input["directory"] === "string" ? normalizeSourceValue(record.input["directory"]) : "";
  if (!directory) {
    return null;
  }

  const matchingLines = record.result
    .split("\n")
    .filter((line) => {
      const match = line.match(/^([^:\n]+):\d+:/);
      if (!match?.[1]) {
        return false;
      }
      return sourceMatches(source, join(directory, match[1]));
    });

  if (matchingLines.length === 0) {
    return null;
  }

  return matchingLines.join("\n");
}

function extractVisibleLineRange(text: string): string | null {
  const grepMatches = [...text.matchAll(/lines (\d+)-(\d+)/g)];
  if (grepMatches.length > 0) {
    return grepMatches.map((match) => `${match[1]}-${match[2]}`).join("; ");
  }

  const numberedLines = [...text.matchAll(/^\s*(\d+)\s+\|/gm)].map((match) => Number(match[1]));
  if (numberedLines.length === 0) {
    return null;
  }

  return `${Math.min(...numberedLines)}-${Math.max(...numberedLines)}`;
}

function normalizeSourceValue(value: string): string {
  return value.replace(/\\/g, "/").trim();
}

function sourceMatches(expected: string, candidate: string): boolean {
  if (!expected || !candidate) {
    return false;
  }

  const normalizedExpected = normalizeSourceValue(expected);
  const normalizedCandidate = normalizeSourceValue(candidate);
  return normalizedExpected === normalizedCandidate
    || normalizedExpected.endsWith(`/${normalizedCandidate}`)
    || normalizedCandidate.endsWith(`/${normalizedExpected}`);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function unwrapJsonFence(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  return text;
}

function tryParseJsonRecordWithRecovery(text: string): Record<string, unknown> | null {
  const direct = tryParseJsonRecord(text);
  if (direct) return direct;

  const normalized = normalizeJsonLikeRecord(text);
  if (normalized !== text) {
    return tryParseJsonRecord(normalized);
  }

  return null;
}

function tryParseJsonRecord(text: string): Record<string, unknown> | null {
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeJsonLikeRecord(text: string): string {
  if (text.length === 0) return text;

  let normalized = "";
  let changed = false;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!char) continue;

    if (inString) {
      normalized += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      normalized += char;
      continue;
    }

    const literal =
      readPythonJsonLiteral(text, index, "True", "true")
      ?? readPythonJsonLiteral(text, index, "False", "false")
      ?? readPythonJsonLiteral(text, index, "None", "null");

    if (literal) {
      normalized += literal.replacement;
      index += literal.length - 1;
      changed = true;
      continue;
    }

    normalized += char;
  }

  return changed ? normalized : text;
}

function readPythonJsonLiteral(
  text: string,
  index: number,
  token: "True" | "False" | "None",
  replacement: "true" | "false" | "null",
): { length: number; replacement: string } | null {
  if (!text.startsWith(token, index)) return null;

  const before = index - 1;
  const after = index + token.length;
  if (!isJsonLiteralBoundary(text, before) || !isJsonLiteralBoundary(text, after)) {
    return null;
  }

  return { length: token.length, replacement };
}

function isJsonLiteralBoundary(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return true;
  const char = text[index];
  return !char || !/[A-Za-z0-9_$]/.test(char);
}

function findFirstJsonObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!char) continue;

    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
        inString = false;
        escaping = false;
      }
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth++;
      continue;
    }

    if (char === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}
