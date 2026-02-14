import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";

type NotesAction = "create" | "get" | "search" | "list" | "update" | "delete";

interface NotesInputBase {
  action: NotesAction;
}

interface CreateNoteInput extends NotesInputBase {
  action: "create";
  title?: string;
  content: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface GetNoteInput extends NotesInputBase {
  action: "get";
  id: string;
}

interface SearchNotesInput extends NotesInputBase {
  action: "search";
  query?: string;
  tags?: string[];
  limit?: number;
}

interface ListNotesInput extends NotesInputBase {
  action: "list";
  tags?: string[];
  limit?: number;
}

interface UpdateNoteInput extends NotesInputBase {
  action: "update";
  id: string;
  title?: string;
  content?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface DeleteNoteInput extends NotesInputBase {
  action: "delete";
  id: string;
}

type NotesInput =
  | CreateNoteInput
  | GetNoteInput
  | SearchNotesInput
  | ListNotesInput
  | UpdateNoteInput
  | DeleteNoteInput;

interface NoteRecord {
  id: string;
  title: string;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  accessCount: number;
}

interface NotesDocument {
  version: 1;
  notes: NoteRecord[];
}

interface NoteSummary {
  id: string;
  title: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  accessCount: number;
  preview: string;
}

const MAX_NOTES = 10_000;
const MAX_TITLE_CHARS = 200;
const MAX_CONTENT_CHARS = 20_000;
const MAX_TAGS = 20;
const MAX_TAG_CHARS = 40;
const MAX_QUERY_CHARS = 500;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_OUTPUT_CHARS = 100_000;

const NOTES_FILE_ENV = "NOTES_TOOL_FILE_PATH";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..", "..", "..");
const DEFAULT_NOTES_FILE_PATH = resolve(projectRoot, "data", "notes", "notes.json");

let operationLock: Promise<void> = Promise.resolve();

function fail(message: string): ToolResult {
  return { ok: false, error: `Invalid input: ${message}` };
}

function isToolResult(value: unknown): value is ToolResult {
  return isObject(value) && typeof value["ok"] === "boolean";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonOutput(payload: unknown): string {
  const text = JSON.stringify(payload, null, 2);
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`;
}

function parseAction(raw: unknown): NotesAction | null {
  if (typeof raw !== "string") return null;
  if (
    raw === "create" ||
    raw === "get" ||
    raw === "search" ||
    raw === "list" ||
    raw === "update" ||
    raw === "delete"
  ) {
    return raw;
  }
  return null;
}

function parseId(value: unknown): string | ToolResult {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fail("id must be a non-empty string.");
  }
  return value.trim();
}

function parseTitle(value: unknown): string | ToolResult {
  if (typeof value !== "string") {
    return fail("title must be a string when provided.");
  }
  const title = value.trim();
  if (title.length > MAX_TITLE_CHARS) {
    return fail(`title must be ${MAX_TITLE_CHARS} characters or fewer.`);
  }
  return title;
}

function parseContent(value: unknown): string | ToolResult {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fail("content must be a non-empty string.");
  }
  const content = value.trim();
  if (content.length > MAX_CONTENT_CHARS) {
    return fail(`content must be ${MAX_CONTENT_CHARS} characters or fewer.`);
  }
  return content;
}

function parseTags(value: unknown, fieldName: string): string[] | ToolResult {
  if (!Array.isArray(value)) {
    return fail(`${fieldName} must be an array of strings when provided.`);
  }
  if (value.length > MAX_TAGS) {
    return fail(`${fieldName} can contain at most ${MAX_TAGS} tags.`);
  }

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      return fail(`${fieldName} must contain only strings.`);
    }
    const tag = item.trim().toLowerCase();
    if (tag.length === 0) continue;
    if (tag.length > MAX_TAG_CHARS) {
      return fail(`each tag must be ${MAX_TAG_CHARS} characters or fewer.`);
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }

  return tags;
}

function parseMetadata(value: unknown): Record<string, unknown> | ToolResult {
  if (!isObject(value)) {
    return fail("metadata must be an object when provided.");
  }
  return value;
}

function parseLimit(value: unknown): number | ToolResult {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return fail("limit must be a positive integer.");
  }
  return Math.min(value, MAX_LIMIT);
}

function parseQuery(value: unknown): string | ToolResult {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fail("query must be a non-empty string.");
  }
  const query = value.trim();
  if (query.length > MAX_QUERY_CHARS) {
    return fail(`query must be ${MAX_QUERY_CHARS} characters or fewer.`);
  }
  return query;
}

function validateInput(input: unknown): NotesInput | ToolResult {
  if (!isObject(input)) {
    return fail("expected object.");
  }

  const action = parseAction(input["action"]);
  if (!action) {
    return fail("action must be one of: create, get, search, list, update, delete.");
  }

  if (action === "create") {
    const content = parseContent(input["content"]);
    if (isToolResult(content)) return content;

    let title = "";
    if (input["title"] !== undefined) {
      const parsedTitle = parseTitle(input["title"]);
      if (isToolResult(parsedTitle)) return parsedTitle;
      title = parsedTitle;
    }

    let tags: string[] | undefined;
    if (input["tags"] !== undefined) {
      const parsedTags = parseTags(input["tags"], "tags");
      if (isToolResult(parsedTags)) return parsedTags;
      tags = parsedTags;
    }

    let metadata: Record<string, unknown> | undefined;
    if (input["metadata"] !== undefined) {
      const parsedMetadata = parseMetadata(input["metadata"]);
      if (isToolResult(parsedMetadata)) return parsedMetadata;
      metadata = parsedMetadata;
    }

    return { action, title, content, tags, metadata };
  }

  if (action === "get") {
    const id = parseId(input["id"]);
    if (isToolResult(id)) return id;
    return { action, id };
  }

  if (action === "delete") {
    const id = parseId(input["id"]);
    if (isToolResult(id)) return id;
    return { action, id };
  }

  if (action === "list") {
    let tags: string[] | undefined;
    if (input["tags"] !== undefined) {
      const parsedTags = parseTags(input["tags"], "tags");
      if (isToolResult(parsedTags)) return parsedTags;
      tags = parsedTags;
    }

    let limit: number | undefined;
    if (input["limit"] !== undefined) {
      const parsedLimit = parseLimit(input["limit"]);
      if (isToolResult(parsedLimit)) return parsedLimit;
      limit = parsedLimit;
    }

    return { action, tags, limit };
  }

  if (action === "search") {
    let query: string | undefined;
    if (input["query"] !== undefined) {
      const parsedQuery = parseQuery(input["query"]);
      if (isToolResult(parsedQuery)) return parsedQuery;
      query = parsedQuery;
    }

    let tags: string[] | undefined;
    if (input["tags"] !== undefined) {
      const parsedTags = parseTags(input["tags"], "tags");
      if (isToolResult(parsedTags)) return parsedTags;
      tags = parsedTags;
    }

    if (!query && (!tags || tags.length === 0)) {
      return fail("search requires query or tags.");
    }

    let limit: number | undefined;
    if (input["limit"] !== undefined) {
      const parsedLimit = parseLimit(input["limit"]);
      if (isToolResult(parsedLimit)) return parsedLimit;
      limit = parsedLimit;
    }

    return { action, query, tags, limit };
  }

  const id = parseId(input["id"]);
  if (isToolResult(id)) return id;

  let title: string | undefined;
  if (input["title"] !== undefined) {
    const parsedTitle = parseTitle(input["title"]);
    if (isToolResult(parsedTitle)) return parsedTitle;
    title = parsedTitle;
  }

  let content: string | undefined;
  if (input["content"] !== undefined) {
    const parsedContent = parseContent(input["content"]);
    if (isToolResult(parsedContent)) return parsedContent;
    content = parsedContent;
  }

  let tags: string[] | undefined;
  if (input["tags"] !== undefined) {
    const parsedTags = parseTags(input["tags"], "tags");
    if (isToolResult(parsedTags)) return parsedTags;
    tags = parsedTags;
  }

  let metadata: Record<string, unknown> | undefined;
  if (input["metadata"] !== undefined) {
    const parsedMetadata = parseMetadata(input["metadata"]);
    if (isToolResult(parsedMetadata)) return parsedMetadata;
    metadata = parsedMetadata;
  }

  if (title === undefined && content === undefined && tags === undefined && metadata === undefined) {
    return fail("update requires at least one field: title, content, tags, metadata.");
  }

  return { action, id, title, content, tags, metadata };
}

function noteMatchesTags(note: NoteRecord, tags?: string[]): boolean {
  if (!tags || tags.length === 0) return true;
  const set = new Set(note.tags);
  return tags.every((tag) => set.has(tag));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
}

function scoreNote(note: NoteRecord, query: string): number {
  const normalizedQuery = query.toLowerCase().trim();
  const tokens = tokenize(normalizedQuery);
  if (tokens.length === 0 && normalizedQuery.length === 0) return 0;

  const title = note.title.toLowerCase();
  const content = note.content.toLowerCase();
  const tags = note.tags;

  let score = 0;

  if (normalizedQuery.length > 0) {
    if (title.includes(normalizedQuery)) score += 12;
    if (content.includes(normalizedQuery)) score += 6;
    if (tags.some((tag) => tag.includes(normalizedQuery))) score += 8;
  }

  for (const token of tokens) {
    if (title.includes(token)) score += 4;
    if (content.includes(token)) score += 2;
    if (tags.some((tag) => tag.includes(token))) score += 3;
  }

  return score;
}

function toSummary(note: NoteRecord): NoteSummary {
  return {
    id: note.id,
    title: note.title,
    tags: note.tags,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    lastAccessedAt: note.lastAccessedAt,
    accessCount: note.accessCount,
    preview: note.content.slice(0, 180),
  };
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

function getNotesFilePath(): string {
  const fromEnv = process.env[NOTES_FILE_ENV];
  if (fromEnv && fromEnv.trim().length > 0) {
    return resolve(fromEnv.trim());
  }
  return DEFAULT_NOTES_FILE_PATH;
}

function isValidNoteRecord(value: unknown): value is NoteRecord {
  if (!isObject(value)) return false;
  if (typeof value["id"] !== "string") return false;
  if (typeof value["title"] !== "string") return false;
  if (typeof value["content"] !== "string") return false;
  if (!Array.isArray(value["tags"]) || !value["tags"].every((tag) => typeof tag === "string")) return false;
  if (!isObject(value["metadata"])) return false;
  if (typeof value["createdAt"] !== "string") return false;
  if (typeof value["updatedAt"] !== "string") return false;
  if (
    value["lastAccessedAt"] !== undefined &&
    typeof value["lastAccessedAt"] !== "string"
  ) return false;
  if (typeof value["accessCount"] !== "number" || !Number.isFinite(value["accessCount"])) return false;
  return true;
}

function isValidNotesDocument(value: unknown): value is NotesDocument {
  if (!isObject(value)) return false;
  if (value["version"] !== 1) return false;
  if (!Array.isArray(value["notes"])) return false;
  return value["notes"].every((note) => isValidNoteRecord(note));
}

async function loadDocument(filePath: string): Promise<NotesDocument> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidNotesDocument(parsed)) {
      throw new Error("notes store has invalid shape.");
    }
    return parsed;
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return { version: 1, notes: [] };
    }
    throw err;
  }
}

async function saveDocument(filePath: string, document: NotesDocument): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${randomUUID()}`;
  await writeFile(tempPath, JSON.stringify(document, null, 2), "utf8");
  await rename(tempPath, filePath);
}

async function withOperationLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = operationLock;
  let release: () => void = () => undefined;
  operationLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export const notesTool: ToolDefinition = {
  name: "notes",
  description: "Persistent note management for the agent: create, retrieve, search, update, and delete notes.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        description: "One of: create, get, search, list, update, delete.",
      },
      id: { type: "string", description: "Note ID for get/update/delete." },
      title: { type: "string", description: "Optional title for create/update." },
      content: { type: "string", description: "Note body text for create/update." },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags for retrieval/filtering.",
      },
      metadata: { type: "object", description: "Optional custom metadata to merge on update." },
      query: { type: "string", description: "Text query for search action." },
      limit: { type: "number", description: "Max results for search/list (1-50)." },
    },
  },
  selectionHints: {
    tags: ["memory", "notes", "remember", "recall", "state"],
    aliases: ["save_note", "remember_note", "find_notes", "update_note", "delete_note"],
    examples: [
      "remember this for later",
      "find my previous note about deployment",
      "update the note tagged project",
      "delete that old note",
    ],
    domain: "persistent-memory",
    priority: 95,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateInput(input);
    if (isToolResult(parsed)) return parsed;

    const start = Date.now();
    const filePath = getNotesFilePath();

    try {
      return await withOperationLock(async () => {
        const document = await loadDocument(filePath);
        const limit = parsed.action === "search" || parsed.action === "list"
          ? parsed.limit ?? DEFAULT_LIMIT
          : DEFAULT_LIMIT;

        if (parsed.action === "create") {
          if (document.notes.length >= MAX_NOTES) {
            return { ok: false, error: `Notes limit reached (${MAX_NOTES}). Delete old notes first.` };
          }

          const nowIso = new Date().toISOString();
          const note: NoteRecord = {
            id: randomUUID(),
            title: parsed.title ?? "",
            content: parsed.content,
            tags: parsed.tags ?? [],
            metadata: parsed.metadata ?? {},
            createdAt: nowIso,
            updatedAt: nowIso,
            accessCount: 0,
          };

          document.notes.unshift(note);
          await saveDocument(filePath, document);

          return {
            ok: true,
            output: toJsonOutput({ action: "create", note }),
            meta: {
              action: "create",
              noteId: note.id,
              noteCount: document.notes.length,
              durationMs: Date.now() - start,
            },
          };
        }

        if (parsed.action === "get") {
          const note = document.notes.find((item) => item.id === parsed.id);
          if (!note) return { ok: false, error: `Note not found: ${parsed.id}` };

          note.lastAccessedAt = new Date().toISOString();
          note.accessCount += 1;
          await saveDocument(filePath, document);

          return {
            ok: true,
            output: toJsonOutput({ action: "get", note }),
            meta: {
              action: "get",
              noteId: note.id,
              durationMs: Date.now() - start,
            },
          };
        }

        if (parsed.action === "update") {
          const note = document.notes.find((item) => item.id === parsed.id);
          if (!note) return { ok: false, error: `Note not found: ${parsed.id}` };

          if (parsed.title !== undefined) {
            note.title = parsed.title;
          }
          if (parsed.content !== undefined) {
            note.content = parsed.content;
          }
          if (parsed.tags !== undefined) {
            note.tags = parsed.tags;
          }
          if (parsed.metadata !== undefined) {
            note.metadata = { ...note.metadata, ...parsed.metadata };
          }
          note.updatedAt = new Date().toISOString();

          await saveDocument(filePath, document);

          return {
            ok: true,
            output: toJsonOutput({ action: "update", note }),
            meta: {
              action: "update",
              noteId: note.id,
              durationMs: Date.now() - start,
            },
          };
        }

        if (parsed.action === "delete") {
          const index = document.notes.findIndex((item) => item.id === parsed.id);
          if (index < 0) return { ok: false, error: `Note not found: ${parsed.id}` };

          const [removed] = document.notes.splice(index, 1);
          await saveDocument(filePath, document);

          return {
            ok: true,
            output: toJsonOutput({
              action: "delete",
              deleted: { id: removed?.id ?? parsed.id, title: removed?.title ?? "" },
            }),
            meta: {
              action: "delete",
              noteId: removed?.id ?? parsed.id,
              noteCount: document.notes.length,
              durationMs: Date.now() - start,
            },
          };
        }

        if (parsed.action === "list") {
          const filtered = document.notes.filter((note) => noteMatchesTags(note, parsed.tags));
          filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

          const results = filtered
            .slice(0, limit)
            .map((note) => toSummary(note));

          return {
            ok: true,
            output: toJsonOutput({
              action: "list",
              totalMatches: filtered.length,
              results,
            }),
            meta: {
              action: "list",
              resultCount: results.length,
              durationMs: Date.now() - start,
            },
          };
        }

        const filtered = document.notes.filter((note) => noteMatchesTags(note, parsed.tags));
        const query = parsed.query ?? "";
        const scored = filtered
          .map((note) => ({ note, score: scoreNote(note, query) }))
          .filter((entry) => entry.score > 0 || query.length === 0)
          .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return b.note.updatedAt.localeCompare(a.note.updatedAt);
          });

        const results = scored.slice(0, limit).map((entry) => ({
          ...toSummary(entry.note),
          score: entry.score,
        }));

        return {
          ok: true,
          output: toJsonOutput({
            action: "search",
            totalMatches: scored.length,
            results,
          }),
          meta: {
            action: "search",
            resultCount: results.length,
            durationMs: Date.now() - start,
          },
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown notes tool error";
      return {
        ok: false,
        error: message,
        meta: {
          durationMs: Date.now() - start,
        },
      };
    }
  },
};

const NOTES_PROMPT_BLOCK = [
  "Notes Skill is available.",
  "Use notes when the user asks you to remember information for future use.",
  "Use action=create to save, action=search/list/get to retrieve, action=update to modify, action=delete to remove.",
  "When saving, include useful tags and metadata so the note is easy to find and edit later.",
].join("\n");

const notesSkill: SkillDefinition = {
  id: "notes",
  version: "1.0.0",
  description: "Persistent note storage and retrieval for agent memory workflows.",
  promptBlock: NOTES_PROMPT_BLOCK,
  tools: [notesTool],
};

export default notesSkill;
