import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FocusStore } from "../../src/memory/focus/index.js";

const tempDirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ayati-focus-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("FocusStore", () => {
  it("creates, activates, searches, and promotes session focus cards", () => {
    let now = new Date("2026-06-12T09:00:00.000Z");
    const store = new FocusStore({
      dataDir: tempDataDir(),
      now: () => now,
    });
    store.start();
    try {
      const card = store.upsertSessionFromTaskSummary({
        clientId: "c1",
        scope: "session",
        sessionId: "s1",
        runId: "r1",
        runPath: "data/runs/r1",
        status: "completed",
        taskStatus: "not_done",
        objective: "Build todo app",
        summary: "Created todo app shell in todo/index.html.",
        progressSummary: "Initial files are written.",
        openWork: ["make the todo app responsive"],
        keyFacts: ["todo/index.html exists"],
        evidence: ["write_files verified"],
        toolsUsed: ["write_files"],
        createdAt: now.toISOString(),
      });

      const sessionShelf = store.getSessionShelf("c1", "s1", 5);
      expect(sessionShelf).toHaveLength(1);
      expect(sessionShelf[0]).toMatchObject({
        focusId: card.focusId,
        scope: "session",
        sessionId: "s1",
        openWork: ["make the todo app responsive"],
      });

      now = new Date("2026-06-12T09:01:00.000Z");
      const activated = store.activateFocus({
        clientId: "c1",
        focusId: card.focusId,
        sessionId: "s1",
        reason: "user asked to continue",
      });
      expect(activated?.activeSessionId).toBe("s1");
      expect(store.getActiveFocus("c1", "s1", 3)[0]).toMatchObject({
        focusId: card.focusId,
        activatedReason: "user asked to continue",
      });

      const sessionMatches = store.search("c1", "responsive todo", {
        scope: "session",
        sessionId: "s1",
        limit: 5,
      });
      expect(sessionMatches[0]?.focusId).toBe(card.focusId);

      const promoted = store.promoteSessionCards("c1", "s1");
      expect(promoted).toHaveLength(1);
      expect(promoted[0]).toMatchObject({
        scope: "global",
        label: "Build todo app",
      });
      expect(store.getGlobalShelf("c1", 5)[0]?.scope).toBe("global");

      const globalMatches = store.search("c1", "responsive", { scope: "global", limit: 5 });
      expect(globalMatches[0]?.scope).toBe("global");
    } finally {
      store.stop();
    }
  });

  it("updates the same focus card with later run context and generic assets", () => {
    let now = new Date("2026-06-12T09:00:00.000Z");
    const store = new FocusStore({
      dataDir: tempDataDir(),
      now: () => now,
    });
    store.start();
    try {
      const first = store.upsertSessionFromTaskSummary({
        clientId: "c1",
        scope: "session",
        sessionId: "s1",
        runId: "r1",
        runPath: "data/runs/r1",
        status: "completed",
        taskStatus: "not_done",
        objective: "Build a product website",
        summary: "Created the product website in site/index.html.",
        progressSummary: "Initial website files are written.",
        openWork: ["improve the hero section"],
        keyFacts: ["site/index.html exists"],
        evidence: ["write_files verified"],
        toolsUsed: ["write_files"],
        focusAssets: [{
          assetId: "asset_site_index",
          kind: "file",
          origin: "agent_generated",
          role: "working_artifact",
          displayName: "index.html",
          path: "site/index.html",
          restore: { filePath: "site/index.html" },
          sourceRunId: "r1",
          sourceRunPath: "data/runs/r1",
          lastUsedRunId: "r1",
          lastUsedAt: now.toISOString(),
        }],
        createdAt: now.toISOString(),
      });

      expect(first.assets).toHaveLength(1);
      expect(first.runs.map((run) => run.runId)).toEqual(["r1"]);
      expect(first.currentState.changedFiles).toEqual(["site/index.html"]);

      store.activateFocus({
        clientId: "c1",
        focusId: first.focusId,
        sessionId: "s1",
        reason: "user asked to continue the website",
      });

      now = new Date("2026-06-12T09:10:00.000Z");
      const second = store.upsertSessionFromTaskSummary({
        clientId: "c1",
        focusId: first.focusId,
        scope: "session",
        sessionId: "s1",
        runId: "r2",
        runPath: "data/runs/r2",
        status: "completed",
        taskStatus: "done",
        objective: "Improve the hero section",
        summary: "Updated the product website hero in site/index.html.",
        progressSummary: "Hero copy and layout were refined.",
        keyFacts: ["site/index.html has the revised hero"],
        evidence: ["edit_file verified"],
        toolsUsed: ["edit_file"],
        focusAssets: [{
          assetId: "asset_site_index",
          kind: "file",
          origin: "agent_modified",
          role: "working_artifact",
          displayName: "index.html",
          path: "site/index.html",
          restore: { filePath: "site/index.html" },
          sourceRunId: "r1",
          sourceRunPath: "data/runs/r1",
          lastUsedRunId: "r2",
          lastUsedAt: now.toISOString(),
        }],
        createdAt: now.toISOString(),
      });

      expect(second.focusId).toBe(first.focusId);
      expect(second.runs.map((run) => run.runId)).toEqual(["r1", "r2"]);
      expect(second.assets).toHaveLength(1);
      expect(second.assets[0]?.origin).toBe("agent_modified");
      expect(second.assets[0]?.lastUsedRunId).toBe("r2");
      expect(second.currentState.changedFiles).toEqual(["site/index.html"]);
      expect(store.getSessionShelf("c1", "s1", 5)[0]?.topArtifacts).toContain("site/index.html");
      expect(store.search("c1", "hero index", { scope: "session", sessionId: "s1" })[0]?.focusId).toBe(first.focusId);
    } finally {
      store.stop();
    }
  });
});
