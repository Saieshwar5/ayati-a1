import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { initializeSchema, latestSchemaVersion } from "./schema.js";

export interface ContextDatabaseOptions {
  path: string;
  now?: () => string;
}

export class ContextDatabase {
  readonly path: string;
  private readonly database: DatabaseSync;
  private closed = false;

  private constructor(path: string, database: DatabaseSync) {
    this.path = path;
    this.database = database;
  }

  static async open(options: ContextDatabaseOptions): Promise<ContextDatabase> {
    if (options.path !== ":memory:" && !isAbsolute(options.path)) {
      throw new Error("Context Engine database path must be an absolute filesystem path.");
    }
    const databasePath = options.path === ":memory:" ? options.path : resolve(options.path);
    if (databasePath !== ":memory:") {
      await mkdir(dirname(databasePath), { recursive: true });
    }
    const database = new DatabaseSync(databasePath);
    try {
      initializeSchema(database, options.now ?? (() => new Date().toISOString()));
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA busy_timeout = 5000");
      if (databasePath !== ":memory:") {
        database.exec("PRAGMA journal_mode = WAL");
        database.exec("PRAGMA synchronous = FULL");
      }
    } catch (error) {
      database.close();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} Database: ${databasePath}`);
    }
    return new ContextDatabase(databasePath, database);
  }

  prepare(sql: string): StatementSync {
    this.assertOpen();
    return this.database.prepare(sql);
  }

  exec(sql: string): void {
    this.assertOpen();
    this.database.exec(sql);
  }

  transaction<T>(operation: () => T): T {
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  schemaVersion(): number {
    const row = this.prepare(
      "SELECT version FROM schema_metadata WHERE singleton = 1",
    ).get() as { version: number };
    return Number(row.version);
  }

  expectedSchemaVersion(): number {
    return latestSchemaVersion();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.database.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Context Engine database is closed.");
    }
  }
}
