import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { GitContextObserver, type GitContextObservabilityEvent } from "../src/observability.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";
import { ActiveContextDataCache } from "../src/services/active-context-data-cache.js";

const roots: string[] = [];
const services: SqliteGitContextService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("active context cache scope", () => {
  it("reuses derived projections until their explicit owner is invalidated", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-context-data-cache-"));
    roots.push(root);
    const database = await ContextDatabase.open({ path: join(root, "context.db") });
    let readLoads = 0;
    let attachmentLoads = 0;
    let candidateLoads = 0;
    const cache = new ActiveContextDataCache({
      database,
      loadReadContext: () => {
        readLoads += 1;
        return {
          revision: "read-" + readLoads,
          inventory: [],
          discovery: [],
          evidence: [],
          actions: [],
        };
      },
      loadAttachments: () => {
        attachmentLoads += 1;
        return undefined;
      },
      loadTaskCandidates: async () => {
        candidateLoads += 1;
        return [];
      },
      taskCandidateMaxAgeMs: 300_000,
      now: () => "2026-07-12T09:00:00+05:30",
    });

    expect(cache.readContext("S-one")).toMatchObject({ revision: "read-1" });
    expect(cache.readContext("S-one")).toMatchObject({ revision: "read-1" });
    expect(cache.attachments("S-one")).toBeUndefined();
    expect(cache.attachments("S-one")).toBeUndefined();
    await cache.taskCandidates(20);
    await cache.taskCandidates(20);
    expect({ readLoads, attachmentLoads, candidateLoads }).toEqual({
      readLoads: 1,
      attachmentLoads: 1,
      candidateLoads: 1,
    });

    cache.invalidateReadContext("S-one");
    cache.invalidateAttachments("S-one");
    cache.invalidateTaskCandidates();
    cache.readContext("S-one");
    cache.attachments("S-one");
    await cache.taskCandidates(20);
    expect({ readLoads, attachmentLoads, candidateLoads }).toEqual({
      readLoads: 2,
      attachmentLoads: 2,
      candidateLoads: 2,
    });
    database.close();
  });

  it("keeps another session cached when one session conversation changes", async () => {
    let currentTime = "2026-07-12T09:00:00+05:30";
    const fixture = await createFixture(() => currentTime);
    const first = await ensureSession(fixture.service, "REQ-session-1", "2026-07-12", currentTime);
    await fixture.service.getActiveContext({ sessionId: first.session.sessionId });

    currentTime = "2026-07-13T00:00:01+05:30";
    const second = await ensureSession(
      fixture.service,
      "REQ-session-2",
      "2026-07-13",
      currentTime,
      first.session.head ?? undefined,
    );
    await fixture.service.getActiveContext({ sessionId: first.session.sessionId });
    await fixture.service.getActiveContext({ sessionId: second.session.sessionId });
    fixture.events.length = 0;

    await fixture.service.appendConversation({
      requestId: "REQ-second-session-message",
      sessionId: second.session.sessionId,
      role: "user",
      content: "Change only the current session conversation.",
      at: currentTime,
    });
    await fixture.service.getActiveContext({ sessionId: first.session.sessionId });
    await fixture.service.getActiveContext({ sessionId: second.session.sessionId });

    expect(eventsNamed(fixture.events, "active_context_invalidated")).toContainEqual(
      expect.objectContaining({
        sessionId: second.session.sessionId,
        data: expect.objectContaining({
          reason: "conversation_persisted",
          scope: "session",
          invalidatedEntries: 1,
        }),
      }),
    );
    expect(eventsNamed(fixture.events, "active_context_cache_hit")).toContainEqual(
      expect.objectContaining({ sessionId: first.session.sessionId }),
    );
    expect(eventsNamed(fixture.events, "active_context_cache_miss")).toContainEqual(
      expect.objectContaining({ sessionId: second.session.sessionId }),
    );
  });

  it("refreshes cached attachment and task-candidate projections after their owners change", async () => {
    const fixture = await createFixture(() => "2026-07-12T09:00:00+05:30");
    const session = await ensureSession(
      fixture.service,
      "REQ-session",
      "2026-07-12",
      "2026-07-12T09:00:00+05:30",
    );
    const conversation = await fixture.service.appendConversation({
      requestId: "REQ-message",
      sessionId: session.session.sessionId,
      role: "user",
      content: "Retain a document and create a task.",
      at: "2026-07-12T09:01:00+05:30",
    });
    const initial = await fixture.service.getActiveContext({
      sessionId: session.session.sessionId,
    });
    expect(initial.session?.attachments).toBeUndefined();
    expect(initial.taskCandidates).toEqual([]);

    const retainedDirectory = join(fixture.root, "retained");
    const retainedPath = join(retainedDirectory, "notes.txt");
    const content = "important notes\n";
    await mkdir(retainedDirectory, { recursive: true });
    await writeFile(retainedPath, content);
    await fixture.service.recordSessionAttachments({
      requestId: "REQ-attachment",
      sessionId: session.session.sessionId,
      conversationId: conversation.conversation.conversationId,
      attachments: [{
        sessionAssetId: "SA-notes",
        kind: "file",
        name: "notes.txt",
        source: "user_upload",
        status: "ready",
        storedPath: retainedPath,
        sizeBytes: Buffer.byteLength(content),
        checksum: createHash("sha256").update(content).digest("hex"),
        createdAt: "2026-07-12T09:02:00+05:30",
      }],
      at: "2026-07-12T09:02:00+05:30",
    });
    const task = await fixture.service.createTaskRun({
      requestId: "REQ-task",
      sessionId: session.session.sessionId,
      conversationId: conversation.conversation.conversationId,
      expectedHead: session.session.head ?? undefined,
      trigger: "user",
      workState: emptyWorkState(),
      title: "Scoped Cache Task",
      objective: "Prove that shared task candidates refresh deterministically.",
      placement: { mode: "managed" },
      at: "2026-07-12T09:03:00+05:30",
    });

    const refreshed = await fixture.service.getActiveContext({
      sessionId: session.session.sessionId,
    });
    expect(refreshed.session?.attachments).toMatchObject({
      count: 1,
      recent: [{ sessionAssetId: "SA-notes" }],
    });
    expect(refreshed.taskCandidates).toContainEqual(
      expect.objectContaining({ taskId: task.task.taskId }),
    );
  });

  it("refreshes cached read context after a run step is persisted", async () => {
    const fixture = await createFixture(() => "2026-07-12T09:00:00+05:30");
    const session = await ensureSession(
      fixture.service,
      "REQ-session",
      "2026-07-12",
      "2026-07-12T09:00:00+05:30",
    );
    const conversation = await fixture.service.appendConversation({
      requestId: "REQ-message",
      sessionId: session.session.sessionId,
      role: "user",
      content: "Read the requirements.",
      at: "2026-07-12T09:01:00+05:30",
    });
    const run = await fixture.service.startRun({
      requestId: "REQ-run",
      sessionId: session.session.sessionId,
      conversationId: conversation.conversation.conversationId,
      trigger: "user",
      workState: emptyWorkState(),
      at: "2026-07-12T09:01:01+05:30",
    });
    expect((await fixture.service.getActiveContext({ sessionId: session.session.sessionId }))
      .readContext?.evidence).toEqual([]);

    await fixture.service.recordRunStep({
      requestId: "REQ-step",
      sessionId: session.session.sessionId,
      runId: run.run.runId,
      step: 1,
      tool: "read_files",
      toolEffect: "read_only",
      purpose: "Read the current requirements.",
      status: "completed",
      input: { files: [{ path: "requirements.md" }] },
      output: { files: [{ path: "requirements.md", content: "current requirements" }] },
      verification: { passed: true },
      workState: {
        ...emptyWorkState(),
        summary: "Requirements are available.",
      },
      at: "2026-07-12T09:01:02+05:30",
    });

    expect((await fixture.service.getActiveContext({ sessionId: session.session.sessionId }))
      .readContext?.evidence).toEqual([
        expect.objectContaining({
          runId: run.run.runId,
          tool: "read_files",
          resources: ["requirements.md"],
        }),
      ]);
  });
});

async function createFixture(now: () => string): Promise<{
  root: string;
  database: ContextDatabase;
  service: SqliteGitContextService;
  events: GitContextObservabilityEvent[];
}> {
  const root = await mkdtemp(join(tmpdir(), "ayati-context-cache-scope-"));
  roots.push(root);
  const database = await ContextDatabase.open({ path: join(root, "context.db") });
  const events: GitContextObservabilityEvent[] = [];
  const service = new SqliteGitContextService({
    database,
    dataRoot: root,
    now,
    observer: new GitContextObserver("git-context-engine", (event) => events.push(event)),
    rolloverCheckIntervalMs: 0,
  });
  services.push(service);
  return { root, database, service, events };
}

async function ensureSession(
  service: SqliteGitContextService,
  requestId: string,
  date: string,
  at: string,
  expectedHead?: string,
) {
  return await service.ensureActiveSession({
    requestId,
    date,
    timezone: "Asia/Kolkata",
    agentId: "local",
    at,
    ...(expectedHead ? { expectedHead } : {}),
  });
}

function eventsNamed(
  events: GitContextObservabilityEvent[],
  event: string,
): GitContextObservabilityEvent[] {
  return events.filter((entry) => entry.event === event);
}

function emptyWorkState() {
  return {
    status: "not_done" as const,
    summary: "",
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
  };
}
