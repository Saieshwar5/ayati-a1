import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

export type LocalAttachmentKind = "file" | "directory";

export interface PathMention {
  raw: string;
  pathText: string;
  start: number;
  end: number;
  quote?: "\"" | "'";
}

export interface ActivePathMention {
  pathText: string;
  start: number;
  end: number;
  quote?: "\"" | "'";
}

export interface ResolvedLocalAttachment {
  path: string;
  name: string;
  kind: LocalAttachmentKind;
  sizeBytes?: number;
  entryCount?: number;
}

export interface MentionResolution {
  mention: PathMention;
  attachment: ResolvedLocalAttachment;
}

export interface MissingPathMention {
  mention: PathMention;
  path: string;
}

export interface ResolvePathMentionsResult {
  resolved: MentionResolution[];
  missing: MissingPathMention[];
}

function hasMentionBoundary(input: string, atIndex: number): boolean {
  if (atIndex === 0) {
    return true;
  }

  return /[\s([{,;:]/.test(input[atIndex - 1] ?? "");
}

function isPathTerminator(char: string): boolean {
  return /\s/.test(char);
}

export function findPathMentions(input: string): PathMention[] {
  const mentions: PathMention[] = [];
  let index = 0;

  while (index < input.length) {
    if (input[index] !== "@" || !hasMentionBoundary(input, index)) {
      index++;
      continue;
    }

    const start = index;
    let cursor = index + 1;
    const quote = input[cursor] === "\"" || input[cursor] === "'"
      ? input[cursor] as "\"" | "'"
      : undefined;

    if (quote) {
      cursor++;
      const pathStart = cursor;
      while (cursor < input.length && input[cursor] !== quote) {
        cursor++;
      }

      if (cursor >= input.length) {
        index++;
        continue;
      }

      const pathText = input.slice(pathStart, cursor);
      const end = cursor + 1;
      if (pathText.trim().length > 0) {
        mentions.push({
          raw: input.slice(start, end),
          pathText,
          start,
          end,
          quote,
        });
      }
      index = end;
      continue;
    }

    const pathStart = cursor;
    while (cursor < input.length && !isPathTerminator(input[cursor] ?? "")) {
      cursor++;
    }

    const pathText = input.slice(pathStart, cursor);
    if (pathText.trim().length > 0) {
      mentions.push({
        raw: input.slice(start, cursor),
        pathText,
        start,
        end: cursor,
      });
    }

    index = Math.max(cursor, index + 1);
  }

  return mentions;
}

export function getActivePathMention(input: string): ActivePathMention | null {
  const match = input.match(/(^|[\s([{,;:])@(?:(["'])([^"']*)|([^\s]*))$/);
  if (!match) {
    return null;
  }

  const quote = match[2] === "\"" || match[2] === "'" ? match[2] as "\"" | "'" : undefined;
  const pathText = quote ? match[3] ?? "" : match[4] ?? "";
  const start = input.length - pathText.length - 1 - (quote ? 1 : 0);

  return {
    pathText,
    start,
    end: input.length,
    ...(quote ? { quote } : {}),
  };
}

export function stripPathMentions(input: string): string {
  const mentions = findPathMentions(input);
  if (mentions.length === 0) {
    return input.trim();
  }

  let output = "";
  let cursor = 0;
  for (const mention of mentions) {
    output += input.slice(cursor, mention.start);
    cursor = mention.end;
  }
  output += input.slice(cursor);

  return output.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();
}

export function replacePathMentionsWithResolvedPaths(
  input: string,
  resolutions: MentionResolution[],
): string {
  if (resolutions.length === 0) {
    return input.trim();
  }

  let output = "";
  let cursor = 0;
  for (const resolution of resolutions) {
    output += input.slice(cursor, resolution.mention.start);
    output += resolution.attachment.path;
    cursor = resolution.mention.end;
  }
  output += input.slice(cursor);

  return output.replace(/[ \t]{2,}/g, " ").trim();
}

export function resolvePathText(
  pathText: string,
  options: { cwd?: string; homeDir?: string } = {},
): string {
  const cwd = options.cwd ?? process.cwd();
  const home = options.homeDir ?? homedir();
  const trimmed = pathText.trim();

  if (trimmed === "~") {
    return home;
  }

  if (trimmed.startsWith("~/")) {
    return resolve(home, trimmed.slice(2));
  }

  if (isAbsolute(trimmed)) {
    return resolve(trimmed);
  }

  return resolve(cwd, trimmed);
}

export function resolvePathMentions(
  input: string,
  options: { cwd?: string; homeDir?: string } = {},
): ResolvePathMentionsResult {
  const mentions = findPathMentions(input);
  const resolved: MentionResolution[] = [];
  const missing: MissingPathMention[] = [];

  for (const mention of mentions) {
    const absolutePath = resolvePathText(mention.pathText, options);
    if (!existsSync(absolutePath)) {
      missing.push({ mention, path: absolutePath });
      continue;
    }

    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      resolved.push({
        mention,
        attachment: {
          path: absolutePath,
          name: basename(absolutePath) || absolutePath,
          kind: "directory",
          entryCount: safeDirectoryEntryCount(absolutePath),
        },
      });
      continue;
    }

    if (stats.isFile()) {
      resolved.push({
        mention,
        attachment: {
          path: absolutePath,
          name: basename(absolutePath),
          kind: "file",
          sizeBytes: stats.size,
        },
      });
    }
  }

  return { resolved, missing };
}

function safeDirectoryEntryCount(path: string): number | undefined {
  try {
    return readdirSync(path).length;
  } catch {
    return undefined;
  }
}
