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
    let resourceLoads = 0;
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
      loadResources: () => {
        resourceLoads += 1;
        return undefined;
      },
      loadWorkstreamCandidates: async () => {
        candidateLoads += 1;
        return [];
      },
      workstreamCandidateMaxAgeMs: 300_000,
      now: () => "2026-07-12T09:00:00+05:30",
    });

    expect(cache.readContext("S-one")).toMatchObject({ revision: "read-1" });
    expect(cache.readContext("S-one")).toMatchObject({ revision: "read-1" });
    expect(cache.resources("S-one")).toBeUndefined();
    expect(cache.resources("S-one")).toBeUndefined();
    const candidateInput = {
      limit: 20,
      sessionId: "S-one",
      currentText: "Continue the cache workstream.",
    };
    await cache.workstreamCandidates(candidateInput);
    await cache.workstreamCandidates(candidateInput);
    expect({ readLoads, resourceLoads, candidateLoads }).toEqual({
      readLoads: 1,
      resourceLoads: 1,
      candidateLoads: 1,
    });
    await cache.workstreamCandidates({
      ...candidateInput,
      currentText: "Open a different workstream.",
    });
    expect(candidateLoads).toBe(2);

    cache.invalidateReadContext("S-one");
    cache.invalidateResources("S-one");
    cache.invalidateWorkstreamCandidates();
    cache.readContext("S-one");
    cache.resources("S-one");
    await cache.workstreamCandidates(candidateInput);
    expect({ readLoads, resourceLoads, candidateLoads }).toEqual({
      readLoads: 2,
      resourceLoads: 2,
      candidateLoads: 3,
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

    await fixture.service.prepareContextTurn({
      requestId: "REQ-second-session-turn",
      date: "2026-07-13",
      timezone: "Asia/Kolkata",
      agentId: "local",
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

  it("refreshes cached resource and workstream-candidate projections after their owners change", async () => {
    const fixture = await createFixture(() => "2026-07-12T09:00:00+05:30");
    const retainedDirectory = join(fixture.root, "retained");
    const retainedPath = join(retainedDirectory, "notes.txt");
    const content = "important notes\n";
    await mkdir(retainedDirectory, { recursive: true });
    await writeFile(retainedPath, content);
    const session = await ensureSession(
      fixture.service,
      "REQ-resource-session",
      "2026-07-12",
      "2026-07-12T09:00:00+05:30",
    );
    const initial = await fixture.service.getActiveContext({ sessionId: session.session.sessionId });
    expect(initial.session?.resources).toMatchObject({ count: 0, recent: [] });
    expect(initial.workstreamCandidates).toEqual([]);

    const prepared = await fixture.service.prepareContextTurn({
      requestId: "REQ-turn",
      date: "2026-07-12",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Retain a document and create a workstream.",
      resources: [{
        admissionId: "notes-upload",
        kind: "document",
        origin: "user_attachment",
        locator: { kind: "filesystem", path: retainedPath },
        displayName: "notes.txt",
        description: "Notes for the scoped cache workstream.",
        aliases: ["cache notes"],
        role: "attachment",
      }],
      at: "2026-07-12T09:01:00+05:30",
    });
    const resource = prepared.context.ingressResources?.[0];
    if (!resource) throw new Error("Expected admitted resource.");
    const workstream = await fixture.service.createWorkstreamForRun({
      requestId: "REQ-workstream",
      sessionId: prepared.session.sessionId,
      conversationId: prepared.conversation.conversationId,
      runId: prepared.run.runId,
      expectedHead: prepared.session.head ?? undefined,
      title: "Scoped Cache Workstream",
      objective: "Prove that shared workstream candidates refresh deterministically.",
      resources: [{ resourceId: resource.resourceId, role: "primary", access: "read", primary: true }],
      at: "2026-07-12T09:03:00+05:30",
    });

    const refreshed = await fixture.service.getActiveContext({
      sessionId: prepared.session.sessionId,
    });
    expect(refreshed.session?.resources).toMatchObject({
      count: 1,
      recent: [{ resourceId: resource.resourceId }],
    });
    expect(refreshed.workstreamCandidates).toContainEqual(
      expect.objectContaining({ workstreamId: workstream.workstream.workstreamId }),
    );
  });

  it("refreshes cached read context after a run step is persisted", async () => {
    const fixture = await createFixture(() => "2026-07-12T09:00:00+05:30");
    const prepared = await fixture.service.prepareContextTurn({
      requestId: "REQ-turn",
      date: "2026-07-12",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Read the requirements.",
      at: "2026-07-12T09:01:00+05:30",
    });
    expect((await fixture.service.getActiveContext({ sessionId: prepared.session.sessionId }))
      .readContext?.evidence).toEqual([]);

    await fixture.service.recordRunStep({
      requestId: "REQ-step",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      record: {
        version: 1,
        step: 1,
        status: "completed",
        summary: "Requirements are available.",
        toolCalls: [{
          callId: "call-read-requirements",
          tool: "read_files",
          toolPurpose: "read",
          toolEffect: "read_only",
          purpose: "Read the current requirements.",
          status: "success",
          input: { files: [{ path: "requirements.md" }] },
          output: { files: [{ path: "requirements.md", content: "current requirements" }] },
        }],
        verification: { passed: true },
        workStateAfter: {
          ...emptyWorkState(),
          summary: "Requirements are available.",
        },
        createdAt: "2026-07-12T09:01:02+05:30",
      },
    });

    expect((await fixture.service.getActiveContext({ sessionId: prepared.session.sessionId }))
      .readContext?.evidence).toEqual([
        expect.objectContaining({
          runId: prepared.run.runId,
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
    rootDirectory: root,
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
