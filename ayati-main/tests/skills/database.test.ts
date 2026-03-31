import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import databaseSkill from "../../src/skills/builtins/database/index.js";

function getTool(name: string) {
  const tool = databaseSkill.tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  return tool;
}

function parseOutput(result: { ok: boolean; output?: string; error?: string }) {
  expect(result.ok).toBe(true);
  if (!result.ok || !result.output) {
    throw new Error(result.error ?? "Expected successful tool output.");
  }
  return JSON.parse(result.output) as Record<string, unknown>;
}

describe("database skill", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  function makeDbPath(name = "agent.sqlite"): string {
    tempDir = mkdtempSync(join(tmpdir(), "ayati-db-"));
    return join(tempDir, name);
  }

  it("creates tables, inserts rows, queries data, and describes schema", async () => {
    const dbPath = makeDbPath();

    const createResult = await getTool("db_create_table").execute({
      dbPath,
      table: "tasks",
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "title", type: "TEXT", notNull: true },
        { name: "done", type: "INTEGER", defaultValue: 0 },
      ],
    });
    const created = parseOutput(createResult);
    expect(created.table).toBe("tasks");

    const insertResult = await getTool("db_insert_rows").execute({
      dbPath,
      table: "tasks",
      rows: [
        { id: 1, title: "import csv", done: 0 },
        { id: 2, title: "answer question", done: 1 },
      ],
    });
    const inserted = parseOutput(insertResult);
    expect(inserted.insertedRowCount).toBe(2);

    const queryResult = await getTool("db_query").execute({
      dbPath,
      table: "tasks",
      columns: ["id", "title", "done"],
      orderBy: ["id ASC"],
      limit: 10,
    });
    const queried = parseOutput(queryResult);
    expect(queried.statementType).toBe("query");
    expect(queried.rowCount).toBe(2);
    expect(queried.rows).toEqual([
      { id: 1, title: "import csv", done: 0 },
      { id: 2, title: "answer question", done: 1 },
    ]);

    const describeResult = await getTool("db_describe_table").execute({
      dbPath,
      table: "tasks",
      sampleLimit: 5,
    });
    const described = parseOutput(describeResult);
    expect(described.rowCount).toBe(2);
    expect(described.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "id", type: "INTEGER" }),
      expect.objectContaining({ name: "title", type: "TEXT" }),
      expect.objectContaining({ name: "done", type: "INTEGER" }),
    ]));

    const ddlResult = await getTool("db_get_table_ddl").execute({
      dbPath,
      table: "tasks",
    });
    const ddl = parseOutput(ddlResult);
    expect(String(ddl.createSql)).toContain("CREATE TABLE");
    expect(String(ddl.createSql)).toContain("\"tasks\"");

    const listResult = await getTool("db_list_tables").execute({ dbPath });
    const listed = parseOutput(listResult);
    expect(listed.tables).toEqual([
      expect.objectContaining({ name: "tasks", rowCount: 2 }),
    ]);
  });

  it("supports schema changes, row updates/deletes, table rename/drop, and raw SQL", async () => {
    const dbPath = makeDbPath();

    const execCreate = await getTool("db_execute_sql").execute({
      dbPath,
      mode: "execute",
      sql: "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
    });
    parseOutput(execCreate);

    const insertRows = await getTool("db_insert_rows").execute({
      dbPath,
      table: "people",
      rows: [
        { id: 1, name: "Sai" },
        { id: 2, name: "Arun" },
      ],
    });
    parseOutput(insertRows);

    const addColumns = await getTool("db_add_columns").execute({
      dbPath,
      table: "people",
      columns: [
        { name: "email", type: "TEXT" },
      ],
    });
    const added = parseOutput(addColumns);
    expect(added.addedColumns).toEqual(["email"]);

    const updateRows = await getTool("db_update_rows").execute({
      dbPath,
      table: "people",
      set: { email: "sai@example.com" },
      whereSql: "id = ?",
      params: [1],
    });
    const updated = parseOutput(updateRows);
    expect(updated.updatedRowCount).toBe(1);

    const rawQuery = await getTool("db_execute_sql").execute({
      dbPath,
      mode: "query",
      sql: "SELECT id, name, email FROM people WHERE id = ?",
      params: [1],
    });
    const queried = parseOutput(rawQuery);
    expect(queried.rows).toEqual([
      { id: 1, name: "Sai", email: "sai@example.com" },
    ]);

    const deleteRows = await getTool("db_delete_rows").execute({
      dbPath,
      table: "people",
      whereSql: "id = ?",
      params: [2],
    });
    const deleted = parseOutput(deleteRows);
    expect(deleted.deletedRowCount).toBe(1);

    const renameTable = await getTool("db_rename_table").execute({
      dbPath,
      table: "people",
      newName: "contacts",
    });
    const renamed = parseOutput(renameTable);
    expect(renamed.newName).toBe("contacts");

    const dropTable = await getTool("db_drop_table").execute({
      dbPath,
      table: "contacts",
    });
    const dropped = parseOutput(dropTable);
    expect(dropped.dropped).toBe(true);
  });
});
