import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import notesSkill, { notesTool } from "../../src/skills/builtins/notes/index.js";

interface ParsedNote {
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

let tempDir = "";
let notesPath = "";
let previousNotesEnv: string | undefined;

function parseOutput(result: { output?: string }): Record<string, unknown> {
  expect(result.output).toBeDefined();
  return JSON.parse(result.output ?? "{}") as Record<string, unknown>;
}

function extractNoteId(payload: Record<string, unknown>): string {
  const note = payload["note"] as ParsedNote;
  expect(note.id).toBeTypeOf("string");
  return note.id;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "notes-tool-test-"));
  notesPath = join(tempDir, "notes.json");
  previousNotesEnv = process.env["NOTES_TOOL_FILE_PATH"];
  process.env["NOTES_TOOL_FILE_PATH"] = notesPath;
});

afterEach(async () => {
  if (previousNotesEnv === undefined) {
    delete process.env["NOTES_TOOL_FILE_PATH"];
  } else {
    process.env["NOTES_TOOL_FILE_PATH"] = previousNotesEnv;
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe("notes skill metadata", () => {
  it("has correct id, version and single tool", () => {
    expect(notesSkill.id).toBe("notes");
    expect(notesSkill.version).toBe("1.0.0");
    expect(notesSkill.tools).toHaveLength(1);
    expect(notesSkill.tools[0]?.name).toBe("notes");
    expect(notesSkill.promptBlock).toContain("Notes Skill");
  });
});

describe("notes tool", () => {
  it("creates and persists a note with metadata", async () => {
    const result = await notesTool.execute({
      action: "create",
      title: "Deploy checklist",
      content: "Remember to run migrations before deploy.",
      tags: ["Ops", "Deploy"],
      metadata: { source: "user", project: "ayati" },
    });

    expect(result.ok).toBe(true);
    const payload = parseOutput(result);
    const note = payload["note"] as ParsedNote;
    expect(note.title).toBe("Deploy checklist");
    expect(note.tags).toEqual(["ops", "deploy"]);
    expect(note.metadata["project"]).toBe("ayati");

    const onDisk = JSON.parse(await readFile(notesPath, "utf8")) as { notes: ParsedNote[] };
    expect(onDisk.notes).toHaveLength(1);
    expect(onDisk.notes[0]?.id).toBe(note.id);
  });

  it("retrieves a note by id and updates access metadata", async () => {
    const create = await notesTool.execute({
      action: "create",
      content: "Remember my preferred language is TypeScript.",
      tags: ["prefs"],
    });

    const createPayload = parseOutput(create);
    const id = extractNoteId(createPayload);

    const get = await notesTool.execute({ action: "get", id });
    expect(get.ok).toBe(true);
    const getPayload = parseOutput(get);
    const note = getPayload["note"] as ParsedNote;
    expect(note.id).toBe(id);
    expect(note.accessCount).toBe(1);
    expect(note.lastAccessedAt).toBeTypeOf("string");
  });

  it("searches notes by query and tags", async () => {
    const createA = await notesTool.execute({
      action: "create",
      title: "Groceries",
      content: "Buy apples, bananas, and oats.",
      tags: ["shopping"],
    });
    const idA = extractNoteId(parseOutput(createA));

    await notesTool.execute({
      action: "create",
      title: "Infrastructure",
      content: "Rotate staging SSH key.",
      tags: ["ops"],
    });

    const search = await notesTool.execute({
      action: "search",
      query: "apples",
      tags: ["shopping"],
      limit: 5,
    });

    expect(search.ok).toBe(true);
    const payload = parseOutput(search);
    const results = payload["results"] as Array<Record<string, unknown>>;
    expect(results.length).toBe(1);
    expect(results[0]?.["id"]).toBe(idA);
  });

  it("updates and deletes notes", async () => {
    const create = await notesTool.execute({
      action: "create",
      content: "Initial note content",
      tags: ["alpha"],
    });
    const id = extractNoteId(parseOutput(create));

    const update = await notesTool.execute({
      action: "update",
      id,
      content: "Updated note content",
      tags: ["beta"],
      metadata: { priority: "high" },
    });
    expect(update.ok).toBe(true);
    const updatedNote = (parseOutput(update)["note"] as ParsedNote);
    expect(updatedNote.content).toContain("Updated");
    expect(updatedNote.tags).toEqual(["beta"]);
    expect(updatedNote.metadata["priority"]).toBe("high");

    const del = await notesTool.execute({ action: "delete", id });
    expect(del.ok).toBe(true);

    const getAfterDelete = await notesTool.execute({ action: "get", id });
    expect(getAfterDelete.ok).toBe(false);
    expect(getAfterDelete.error).toContain("not found");
  });

  it("rejects invalid action", async () => {
    const result = await notesTool.execute({ action: "remember" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("action");
  });
});
