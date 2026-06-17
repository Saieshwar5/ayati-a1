import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityStore, ContinuityResolver } from "../../src/memory/activity/index.js";

const tempDirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ayati-activity-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ActivityStore", () => {
  it("creates activity threads with durable identities and resolves exact continuation", () => {
    let now = new Date("2026-06-12T09:00:00.000Z");
    const store = new ActivityStore({
      dataDir: tempDataDir(),
      now: () => now,
    });
    store.start();
    try {
      const activity = store.upsertFromTaskSummary({
        clientId: "c1",
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
        activityAssets: [{
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

      expect(activity?.activityId).toBeTruthy();
      expect(activity?.assets).toHaveLength(1);
      expect(activity?.runs.map((run) => run.runId)).toEqual(["r1"]);
      expect(activity?.state.changedFiles).toContain("site/index.html");

      const byPath = store.getActivityByIdentity("c1", "file_path", "site/index.html");
      expect(byPath?.activityId).toBe(activity?.activityId);

      const resolver = new ContinuityResolver({ store, now: () => now });
      const resolved = resolver.resolve({
        clientId: "c1",
        sessionId: "s1",
        userMessage: "continue work on site/index.html",
      });
      expect(resolved.mode).toBe("continue");
      expect(resolved.current?.activityId).toBe(activity?.activityId);

      now = new Date("2026-06-12T09:10:00.000Z");
      const updated = store.upsertFromTaskSummary({
        clientId: "c1",
        sessionId: "s1",
        activityId: activity!.activityId,
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
        activityAssets: [{
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

      expect(updated?.activityId).toBe(activity?.activityId);
      expect(updated?.runs.map((run) => run.runId)).toEqual(["r1", "r2"]);
      expect(updated?.assets[0]?.origin).toBe("agent_modified");
      expect(store.search("c1", "hero index")[0]?.activityId).toBe(activity?.activityId);
    } finally {
      store.stop();
    }
  });

  it("returns ambiguous continuity instead of guessing between close activity matches", () => {
    const now = new Date("2026-06-12T10:00:00.000Z");
    const store = new ActivityStore({
      dataDir: tempDataDir(),
      now: () => now,
    });
    store.start();
    try {
      for (const name of ["product website", "portfolio website"]) {
        store.upsertFromTaskSummary({
          clientId: "c1",
          sessionId: "s1",
          runId: `run-${name}`,
          runPath: `data/runs/${name}`,
          status: "completed",
          objective: `Build ${name}`,
          summary: `Created ${name}.`,
          progressSummary: `Initial ${name} files are written.`,
          openWork: ["make website responsive"],
          toolsUsed: ["write_files"],
          createdAt: now.toISOString(),
        });
      }

      const resolver = new ContinuityResolver({ store, now: () => now });
      const resolved = resolver.resolve({
        clientId: "c1",
        sessionId: "s1",
        userMessage: "continue the website",
      });

      expect(resolved.mode).toBe("ambiguous");
      expect(resolved.candidates?.length).toBeGreaterThan(1);
    } finally {
      store.stop();
    }
  });
});
