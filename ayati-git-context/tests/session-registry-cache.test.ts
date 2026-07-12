import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { insertSession } from "../src/repositories/session-records.js";
import { SessionRegistryCache } from "../src/services/session-registry-cache.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";

const directories: string[] = [];
const services: SqliteGitContextService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("session registry cache", () => {
  it("serves the hydrated live session until a restarted cache reads durable changes", async () => {
    const directory = await temporaryDirectory();
    const database = await ContextDatabase.open({ path: join(directory, "context.db") });
    insertSession(database, {
      sessionId: "S-20260712-local",
      date: "2026-07-12",
      timezone: "Asia/Kolkata",
      agentId: "local",
      repositoryPath: join(directory, "sessions", "S-20260712-local"),
      createdAt: "2026-07-12T09:00:00+05:30",
    });
    const cache = new SessionRegistryCache(database);
    const cached = cache.getLiveSessionForAgent("local");
    expect(cached?.head).toBeNull();

    database.prepare("UPDATE sessions SET head_sha = ? WHERE session_id = ?")
      .run("a".repeat(40), "S-20260712-local");
    expect(cache.getLiveSessionForAgent("local")).toBe(cached);
    expect(cache.getLiveSessionForAgent("local")?.head).toBeNull();

    const restarted = new SessionRegistryCache(database);
    expect(restarted.getLiveSessionForAgent("local")?.head).toBe("a".repeat(40));
    database.close();
  });

  it("updates HEAD and removes sealed sessions from the live-agent index", async () => {
    const database = await ContextDatabase.open({ path: ":memory:" });
    insertSession(database, {
      sessionId: "S-20260712-local",
      date: "2026-07-12",
      timezone: "Asia/Kolkata",
      agentId: "local",
      repositoryPath: "/tmp/session",
      createdAt: "2026-07-12T09:00:00+05:30",
    });
    const cache = new SessionRegistryCache(database);

    expect(cache.updateHead("S-20260712-local", "b".repeat(40)).head).toBe("b".repeat(40));
    cache.updateStatus("S-20260712-local", "sealed", "2026-07-12T23:59:59+05:30");

    expect(cache.getLiveSessionForAgent("local")).toBeUndefined();
    expect(cache.getSession(database, "S-20260712-local")?.status).toBe("sealed");
    database.close();
  });

  it("does not reread immutable Git metadata during normal context reads", async () => {
    const directory = await temporaryDirectory();
    const database = await ContextDatabase.open({ path: join(directory, "context.db") });
    const service = new SqliteGitContextService({ database, dataRoot: directory });
    services.push(service);
    const created = await service.ensureActiveSession({
      requestId: "REQ-session",
      date: "2026-07-12",
      timezone: "Asia/Kolkata",
      agentId: "local",
      at: "2026-07-12T09:00:00+05:30",
    });
    const metadata = join(created.session.repositoryPath, "session", "meta.json");
    const moved = metadata + ".moved";
    await rename(metadata, moved);

    const first = await service.getActiveContext({ sessionId: created.session.sessionId });
    const second = await service.getActiveContext({ sessionId: created.session.sessionId });

    expect(first.session?.session).toEqual(created.session);
    expect(second).toEqual(first);
    await rename(moved, metadata);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ayati-session-cache-"));
  directories.push(directory);
  return directory;
}
