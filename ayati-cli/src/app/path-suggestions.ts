import { readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { getActivePathMention, resolvePathText } from "./path-mentions.js";

export type PathSuggestionKind = "file" | "directory";

export interface PathSuggestion {
  path: string;
  insertText: string;
  displayPath: string;
  name: string;
  kind: PathSuggestionKind;
  score: number;
}

export interface PathSuggestionOptions {
  cwd?: string;
  homeDir?: string;
  limit?: number;
  maxDepth?: number;
  maxVisited?: number;
  roots?: string[];
}

export interface ApplyPathSuggestionOptions {
  finalizeDirectory?: boolean;
}

const DEFAULT_LIMIT = 6;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_VISITED = 800;
const IGNORED_NAMES = new Set([
  ".git",
  ".cache",
  ".pnpm-store",
  "coverage",
  "data",
  "dist",
  "node_modules",
]);

export function getPathSuggestions(
  input: string,
  options: PathSuggestionOptions = {},
): PathSuggestion[] {
  const active = getActivePathMention(input);
  if (!active) {
    return [];
  }

  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const query = active.pathText;

  if (shouldUsePathCompletion(query)) {
    return completePath(query, { cwd, homeDir, limit });
  }

  const roots = options.roots && options.roots.length > 0
    ? [...options.roots, ...defaultSearchRoots(cwd, homeDir)]
    : undefined;

  return fuzzySearch(query, {
    cwd,
    homeDir,
    limit,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxVisited: options.maxVisited ?? DEFAULT_MAX_VISITED,
    roots,
  });
}

export function applyPathSuggestion(
  input: string,
  suggestion: PathSuggestion,
  options: ApplyPathSuggestionOptions = {},
): string {
  const active = getActivePathMention(input);
  if (!active) {
    return input;
  }

  const quoted = active.quote
    ? `${active.quote}${suggestion.insertText}${active.quote}`
    : suggestion.insertText.includes(" ")
      ? `"${suggestion.insertText}"`
      : suggestion.insertText;
  const suffix = suggestion.kind === "directory" && !options.finalizeDirectory ? "" : " ";

  return `${input.slice(0, active.start)}@${quoted}${suffix}`;
}

function shouldUsePathCompletion(query: string): boolean {
  return query.length === 0
    || query.startsWith(".")
    || query.startsWith("~")
    || query.startsWith("/")
    || query.includes("/")
    || query.includes("\\");
}

function completePath(
  query: string,
  options: { cwd: string; homeDir: string; limit: number },
): PathSuggestion[] {
  const { parentText, prefix } = splitPathQuery(query);
  const parentPath = resolvePathText(parentText || ".", options);
  const entries = safeReadDir(parentPath);
  const normalizedPrefix = prefix.toLowerCase();

  return entries
    .filter((entry) => shouldShowEntry(entry.name, prefix))
    .map((entry): PathSuggestion | null => {
      const score = scorePathCompletion(entry.name, normalizedPrefix);
      if (score <= 0) {
        return null;
      }

      const absolutePath = resolve(parentPath, entry.name);
      const kind = entry.isDirectory() ? "directory" : "file";
      const insertText = `${parentText}${entry.name}${kind === "directory" ? sep : ""}`;

      return {
        path: absolutePath,
        insertText,
        displayPath: renderDisplayPath(absolutePath, options.cwd),
        name: entry.name,
        kind,
        score: score + (kind === "directory" ? 10 : 0),
      };
    })
    .filter((entry): entry is PathSuggestion => entry !== null)
    .sort(compareSuggestions)
    .slice(0, options.limit);
}

function fuzzySearch(
  query: string,
  options: Required<Pick<PathSuggestionOptions, "cwd" | "homeDir" | "limit" | "maxDepth" | "maxVisited">> & {
    roots?: string[];
  },
): PathSuggestion[] {
  const roots = uniqueRoots(options.roots ?? defaultSearchRoots(options.cwd, options.homeDir));
  const normalizedQuery = query.toLowerCase();
  const suggestions: PathSuggestion[] = [];
  let visited = 0;

  for (const root of roots) {
    const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    while (queue.length > 0 && visited < options.maxVisited) {
      const current = queue.shift();
      if (!current) {
        break;
      }

      const entries = safeReadDir(current.path);
      for (const entry of entries) {
        if (visited >= options.maxVisited) {
          break;
        }
        visited++;

        if (!shouldShowEntry(entry.name, query)) {
          continue;
        }

        const absolutePath = join(current.path, entry.name);
        const kind = entry.isDirectory() ? "directory" : "file";
        const score = scoreFuzzyMatch(entry.name, normalizedQuery, current.depth, kind);
        if (score > 0) {
          suggestions.push({
            path: absolutePath,
            insertText: toInsertPath(absolutePath, options.cwd, kind),
            displayPath: renderDisplayPath(absolutePath, options.cwd),
            name: entry.name,
            kind,
            score,
          });
        }

        if (entry.isDirectory() && current.depth < options.maxDepth && !IGNORED_NAMES.has(entry.name)) {
          queue.push({ path: absolutePath, depth: current.depth + 1 });
        }
      }
    }
  }

  return dedupeSuggestions(suggestions)
    .sort(compareSuggestions)
    .slice(0, options.limit);
}

function splitPathQuery(query: string): { parentText: string; prefix: string } {
  if (query.length === 0) {
    return { parentText: "", prefix: "" };
  }

  if (query.endsWith("/") || query.endsWith("\\")) {
    return { parentText: query, prefix: "" };
  }

  const slashIndex = Math.max(query.lastIndexOf("/"), query.lastIndexOf("\\"));
  if (slashIndex < 0) {
    return { parentText: "", prefix: query };
  }

  return {
    parentText: query.slice(0, slashIndex + 1),
    prefix: query.slice(slashIndex + 1),
  };
}

function scorePathCompletion(name: string, normalizedPrefix: string): number {
  if (normalizedPrefix.length === 0) {
    return 50;
  }

  const normalizedName = name.toLowerCase();
  if (normalizedName.startsWith(normalizedPrefix)) {
    return 100 - Math.min(20, name.length - normalizedPrefix.length);
  }

  if (normalizedName.includes(normalizedPrefix)) {
    return 60 - Math.min(20, normalizedName.indexOf(normalizedPrefix));
  }

  return 0;
}

function scoreFuzzyMatch(
  name: string,
  normalizedQuery: string,
  depth: number,
  kind: PathSuggestionKind,
): number {
  if (normalizedQuery.length === 0) {
    return depth === 0 ? 40 + (kind === "directory" ? 10 : 0) : 0;
  }

  const normalizedName = name.toLowerCase();
  if (normalizedName === normalizedQuery) {
    return 120 - depth * 8;
  }

  if (normalizedName.startsWith(normalizedQuery)) {
    return 100 - depth * 8 + (kind === "directory" ? 8 : 0);
  }

  if (normalizedName.includes(normalizedQuery)) {
    return 70 - depth * 8 + (kind === "directory" ? 6 : 0);
  }

  return fuzzySubsequenceScore(normalizedName, normalizedQuery) - depth * 8;
}

function fuzzySubsequenceScore(value: string, query: string): number {
  let valueIndex = 0;
  let score = 0;

  for (const char of query) {
    const foundAt = value.indexOf(char, valueIndex);
    if (foundAt < 0) {
      return 0;
    }
    score += foundAt === valueIndex ? 6 : 3;
    valueIndex = foundAt + 1;
  }

  return Math.max(0, 45 + score - value.length);
}

function compareSuggestions(a: PathSuggestion, b: PathSuggestion): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }

  if (a.kind !== b.kind) {
    return a.kind === "directory" ? -1 : 1;
  }

  return a.displayPath.localeCompare(b.displayPath);
}

function shouldShowEntry(name: string, query: string): boolean {
  if (IGNORED_NAMES.has(name)) {
    return false;
  }

  if (!query.startsWith(".") && name.startsWith(".")) {
    return false;
  }

  return true;
}

function safeReadDir(path: string): Dirent<string>[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function defaultSearchRoots(cwd: string, homeDir: string): string[] {
  return [
    cwd,
    join(homeDir, "Documents"),
    join(homeDir, "Downloads"),
  ];
}

function uniqueRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const root of roots) {
    const absolute = resolve(root);
    if (seen.has(absolute) || !isDirectory(absolute)) {
      continue;
    }
    seen.add(absolute);
    output.push(absolute);
  }

  return output;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function renderDisplayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
    return `.${sep}${rel}`;
  }

  return path;
}

function toInsertPath(
  absolutePath: string,
  cwd: string,
  kind: PathSuggestionKind,
): string {
  const displayPath = renderDisplayPath(absolutePath, cwd);
  const base = displayPath.startsWith(".") || isAbsolute(displayPath)
    ? displayPath
    : `.${sep}${displayPath}`;

  return `${base}${kind === "directory" && !base.endsWith(sep) ? sep : ""}`;
}

function dedupeSuggestions(suggestions: PathSuggestion[]): PathSuggestion[] {
  const byPath = new Map<string, PathSuggestion>();
  for (const suggestion of suggestions) {
    const existing = byPath.get(suggestion.path);
    if (!existing || suggestion.score > existing.score) {
      byPath.set(suggestion.path, suggestion);
    }
  }
  return [...byPath.values()];
}
