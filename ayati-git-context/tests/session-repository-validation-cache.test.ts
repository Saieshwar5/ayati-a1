import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { GitContextObserver, type GitContextObservabilityEvent } from "../src/observability.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const services: SqliteGitContextService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("session repository validation cache", () => {
  it("reuses one recent validation for later session ensures", async () => {
    const fixture = await createFixture();
    const first = await ensureSession(fixture.service, "REQ-session-1", fixture.now());
    const second = await ensureSession(fixture.service, "REQ-session-2", fixture.now());

    expect(second).toMatchObject({
      created: false,
      session: {
        sessionId: first.session.sessionId,
        head: first.session.head,
      },
    });
    expect(eventsNamed(fixture.events, "session_repository_validated")).toHaveLength(1);
    expect(eventsNamed(fixture.events, "session_repository_validation_reused")).toEqual([
      expect.objectContaining({
        sessionId: first.session.sessionId,
        data: expect.objectContaining({ reason: "request", head: first.session.head }),
      }),
    ]);
  });

  it("revalidates after expiry and records an externally changed HEAD", async () => {
    let currentTime = "2026-07-12T09:00:00+05:30";
    const fixture = await createFixture({ now: () => currentTime });
    const first = await ensureSession(fixture.service, "REQ-session-1", currentTime);
    await writeFile(join(first.session.repositoryPath, "external.txt"), "external change\n");
    await git(first.session.repositoryPath, ["add", "--", "external.txt"]);
    await git(first.session.repositoryPath, ["commit", "-m", "external session change"]);
    const externalHead = await git(first.session.repositoryPath, ["rev-parse", "HEAD"]);

    const beforeExpiry = await ensureSession(fixture.service, "REQ-session-2", currentTime);
    expect(beforeExpiry.session.head).toBe(first.session.head);

    currentTime = "2026-07-12T09:05:01+05:30";
    const afterExpiry = await ensureSession(fixture.service, "REQ-session-3", currentTime);

    expect(afterExpiry.session.head).toBe(externalHead);
    expect(fixture.database.prepare(
      "SELECT head_sha FROM sessions WHERE session_id = ?",
    ).get(first.session.sessionId)).toEqual({ head_sha: externalHead });
    expect(eventsNamed(fixture.events, "session_repository_validated").at(-1)).toMatchObject({
      data: {
        reason: "request",
        previousHead: first.session.head,
        head: externalHead,
        headChanged: true,
      },
    });
  });

  it("does not reuse an expired validation when repository metadata is invalid", async () => {
    let currentTime = "2026-07-12T09:00:00+05:30";
    const fixture = await createFixture({ now: () => currentTime });
    const first = await ensureSession(fixture.service, "REQ-session-1", currentTime);
    await writeFile(
      join(first.session.repositoryPath, "session", "meta.json"),
      JSON.stringify({ sessionId: "S-invalid" }, null, 2) + "\n",
    );

    await expect(ensureSession(fixture.service, "REQ-session-2", currentTime)).resolves
      .toMatchObject({ session: { sessionId: first.session.sessionId } });

    currentTime = "2026-07-12T09:05:01+05:30";
    await expect(ensureSession(fixture.service, "REQ-session-3", currentTime)).rejects
      .toMatchObject({ code: "REPOSITORY_UNAVAILABLE" });
    expect(eventsNamed(fixture.events, "session_repository_validation_failed").at(-1))
      .toMatchObject({
        sessionId: first.session.sessionId,
        data: { reason: "request", expectedHead: first.session.head },
      });
  });

  it("performs a cold validation again after service restart", async () => {
    const root = await createRoot();
    const databasePath = join(root, "context.db");
    const firstDatabase = await ContextDatabase.open({ path: databasePath });
    const firstService = new SqliteGitContextService({
      database: firstDatabase,
      dataRoot: root,
      now: () => "2026-07-12T09:00:00+05:30",
      rolloverCheckIntervalMs: 0,
    });
    services.push(firstService);
    const first = await ensureSession(
      firstService,
      "REQ-session-1",
      "2026-07-12T09:00:00+05:30",
    );
    await firstService.close();

    const events: GitContextObservabilityEvent[] = [];
    const secondDatabase = await ContextDatabase.open({ path: databasePath });
    const secondService = new SqliteGitContextService({
      database: secondDatabase,
      dataRoot: root,
      now: () => "2026-07-12T09:01:00+05:30",
      observer: new GitContextObserver("git-context-engine", (event) => events.push(event)),
      rolloverCheckIntervalMs: 0,
    });
    services.push(secondService);

    const restored = await secondService.getActiveContext({});

    expect(restored.session?.session.head).toBe(first.session.head);
    expect(eventsNamed(events, "session_repository_validated")).toEqual([
      expect.objectContaining({
        sessionId: first.session.sessionId,
        data: expect.objectContaining({ reason: "startup", headChanged: false }),
      }),
    ]);
  });
});

async function createFixture(options: { now?: () => string } = {}): Promise<{
  database: ContextDatabase;
  service: SqliteGitContextService;
  events: GitContextObservabilityEvent[];
  now: () => string;
}> {
  const root = await createRoot();
  const database = await ContextDatabase.open({ path: join(root, "context.db") });
  const events: GitContextObservabilityEvent[] = [];
  const now = options.now ?? (() => "2026-07-12T09:00:00+05:30");
  const service = new SqliteGitContextService({
    database,
    dataRoot: root,
    now,
    observer: new GitContextObserver("git-context-engine", (event) => events.push(event)),
    rolloverCheckIntervalMs: 0,
  });
  services.push(service);
  return { database, service, events, now };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ayati-session-validation-"));
  roots.push(root);
  return root;
}

async function ensureSession(
  service: SqliteGitContextService,
  requestId: string,
  at: string,
) {
  return await service.ensureActiveSession({
    requestId,
    date: "2026-07-12",
    timezone: "Asia/Kolkata",
    agentId: "local",
    at,
  });
}

function eventsNamed(
  events: GitContextObservabilityEvent[],
  event: string,
): GitContextObservabilityEvent[] {
  return events.filter((entry) => entry.event === event);
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: repositoryPath, encoding: "utf8" });
  return result.stdout.trim();
}
