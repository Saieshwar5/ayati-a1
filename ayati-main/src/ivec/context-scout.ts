import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { devLog } from "../shared/index.js";
import type { LlmProvider } from "../core/contracts/provider.js";
import type { LlmMessage, LlmToolSchema } from "../core/contracts/llm-protocol.js";
import type { GenericScoutScope, GenericScoutState, ScoutResult } from "./types.js";
import type { ManagedDocumentManifest } from "../documents/types.js";
import type { DocumentContextBackend } from "../documents/document-context-backend.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScoutKnownLocations {
  runPath: string;
  contextDir: string;
  sessionPath?: string;
  sessionDir?: string;
  skillsDir?: string;
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

function buildScoutAccessPolicy(scope: GenericScoutScope, locations: ScoutKnownLocations): ScoutAccessPolicy {
  const normalizedRoots = {
    runPath: normalizeScoutRoot(locations.runPath),
    contextDir: normalizeScoutRoot(locations.contextDir),
    sessionPath: normalizeScoutRoot(locations.sessionPath),
    sessionDir: normalizeScoutRoot(locations.sessionDir),
    skillsDir: normalizeScoutRoot(locations.skillsDir),
  };

  const rootsByScope: Record<GenericScoutScope, Array<string | null>> = {
    run_artifacts: [normalizedRoots.runPath],
    project_context: [normalizedRoots.contextDir],
    session: [normalizedRoots.sessionPath, normalizedRoots.sessionDir],
    skills: [normalizedRoots.skillsDir],
    both: [
      normalizedRoots.runPath,
      normalizedRoots.contextDir,
      normalizedRoots.sessionPath,
      normalizedRoots.sessionDir,
      normalizedRoots.skillsDir,
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
    skills: locations.skillsDir
      ? `Only search within the skills directory: ${locations.skillsDir}\nEach subdirectory contains a skill.md file. Read the skill.md to get the full command reference.`
      : "No skills directory available.",
    both: "You may search only the known scout locations listed below, and no other directories or files.",
  };

  return `You are a Context Scout — a focused retrieval sub-agent.
Your job: find, read, and retrieve the minimum sufficient grounded context relevant to a specific query.

Query: ${query}

Known locations:
- Run artifacts: ${locations.runPath}
  - ${locations.runPath}/state.json — loop state snapshot
    - includes run status and completedSteps[] history for this run
    - completedSteps[] has step, intent, outcome, summary, newFacts, artifacts, toolSuccessCount, toolFailureCount
  - ${locations.runPath}/steps/<NNN>-act.md — step action details (markdown)
  - ${locations.runPath}/steps/<NNN>-verify.md — step verification details (markdown)
  - step filenames use zero-padded numbers (example: 001, 002)
- Project context: ${locations.contextDir}
  - ${locations.contextDir}/soul.json, system_prompt.md, user_profile.json
${locations.sessionPath ? `- Active session: ${locations.sessionPath}` : "- Active session: (not available)"}
${locations.sessionDir ? `- Session data directory: ${locations.sessionDir}` : ""}
${locations.skillsDir ? `- External skills: ${locations.skillsDir}\n  - Each subdirectory has a skill.md with CLI command reference` : ""}

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
- Stop once you have enough information to answer the query.
- If you check the most relevant locations and find nothing, return an empty context.
- When done, respond with a JSON object (no tool calls):
  { "context": "...", "sources": ["file1", "file2"], "confidence": 0.0-1.0 }
- context: retrieve the minimum sufficient grounded context needed for the caller. Preserve exact commands, flags, paths, schemas, and quoted text verbatim. Do not paraphrase when exact wording matters. Trim only irrelevant surrounding text.
- confidence: 1.0 = found exactly what was needed, 0.0 = found nothing relevant
- Keep context concise but informative (under 500 tokens).`;
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
  const accessPolicy = buildScoutAccessPolicy(scope, knownLocations);

  devLog(`[scout] invoked: query="${query.slice(0, 80)}", scope=${scope}`);

  const systemPrompt = buildScoutSystemPrompt(query, scope, knownLocations);
  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Find information for: ${query}` },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await provider.generateTurn({
      messages,
      tools: SCOUT_TOOLS,
    });

    if (response.type === "assistant") {
      devLog(`[scout] text response at turn ${turn}, parsing result`);
      const parsed = parseScoutResult(response.content);
      if (parsed.context.trim().length === 0 && parsed.confidence === 0) {
        return buildScoutFailureResult({
          status: "empty",
          query,
          scope,
          summary: attemptSummary,
        });
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
  return buildScoutFailureResult({
    status: "max_turns_exhausted",
    query,
    scope,
    summary: attemptSummary,
  });
}

function parseScoutResult(text: string): ScoutResult {
  try {
    let jsonStr = text.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch?.[1]) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const context = String(parsed["context"] ?? "");
    return {
      context,
      sources: Array.isArray(parsed["sources"])
        ? (parsed["sources"] as unknown[]).map(String)
        : [],
      confidence: Math.min(1, Math.max(0, Number(parsed["confidence"]) || 0)),
    };
  } catch {
    devLog("[scout] failed to parse JSON response, wrapping as plain text");
    const fallback = text.trim().slice(0, 2000);
    return {
      context: fallback,
      sources: [],
      confidence: 0.5,
    };
  }
}
