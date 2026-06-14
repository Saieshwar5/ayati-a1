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
});
