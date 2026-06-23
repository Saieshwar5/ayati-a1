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
        triggerSeq: 5,
        discussionStartSeq: 1,
        discussionEndSeq: 5,
        status: "completed",
        taskStatus: "not_done",
        objective: "Build a product website",
        summary: "Created the product website in site/index.html.",
        progressSummary: "Initial website files are written.",
        assumptions: ["Use a static HTML prototype"],
        constraints: ["Do not deploy"],
        openWork: ["improve the hero section"],
        keyFacts: ["site/index.html exists"],
        evidence: ["write_files verified"],
        assistantResponse: "Built the first version.",
        entityHints: ["product website"],
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
      expect(activity?.cues.some((cue) => cue.normalizedText === "what is next for build a product website")).toBe(true);
      expect(activity?.entities.some((entity) => entity.normalizedName === "product website")).toBe(true);
      expect(activity?.runs.map((run) => run.runId)).toEqual(["r1"]);
      expect(activity?.runs[0]).toMatchObject({
        triggerSeq: 5,
        discussionStartSeq: 1,
        discussionEndSeq: 5,
      });
      expect(activity?.discussionRanges).toEqual([{
        sessionId: "s1",
        startSeq: 1,
        endSeq: 5,
        reason: "initial_discussion",
      }]);
      expect(activity?.state).toMatchObject({
        objective: "Build a product website",
        status: "open",
        userIntent: "Build a product website",
        assumptions: ["Use a static HTML prototype"],
        constraints: ["Do not deploy"],
        evidence: ["write_files verified"],
        assets: ["site/index.html"],
        lastAssistantResponse: "Built the first version.",
      });
      expect(activity?.state.changedFiles).toContain("site/index.html");
      expect(activity?.state.runHistory.map((run) => run.runId)).toEqual(["r1"]);
      expect(store.findLatestDurableTaskBoundary("c1", "s1")).toMatchObject({
        activityId: activity?.activityId,
        runId: "r1",
        kind: "project",
        status: "open",
        startSeq: 1,
        endSeq: 5,
      });

      const byPath = store.getActivityByIdentity("c1", "file_path", "site/index.html");
      expect(byPath?.activityId).toBe(activity?.activityId);
      expect(store.search("c1", "what is next for Build a product website")[0]?.activityId).toBe(activity?.activityId);
      expect(store.search("c1", "product website")[0]?.activityId).toBe(activity?.activityId);

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
        triggerSeq: 9,
        discussionStartSeq: 6,
        discussionEndSeq: 9,
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
      expect(updated?.discussionRanges.map((range) => [range.startSeq, range.endSeq, range.reason])).toEqual([
        [1, 5, "initial_discussion"],
        [6, 9, "follow_up"],
      ]);
      expect(updated?.state.status).toBe("done");
      expect(updated?.state.completedWork).toContain("Hero copy and layout were refined.");
      expect(updated?.assets[0]?.origin).toBe("agent_modified");
      expect(store.search("c1", "hero index")[0]?.activityId).toBe(activity?.activityId);
      expect(store.findLatestDurableTaskBoundary("c1", "s1")).toMatchObject({
        activityId: activity?.activityId,
        runId: "r2",
        status: "done",
        startSeq: 6,
        endSeq: 9,
      });
    } finally {
      store.stop();
    }
  });

  it("creates a new activity when the user explicitly asks for unrelated work", () => {
    const now = new Date("2026-06-12T09:00:00.000Z");
    const store = new ActivityStore({
      dataDir: tempDataDir(),
      now: () => now,
    });
    store.start();
    try {
      const first = store.upsertFromTaskSummary({
        clientId: "c1",
        sessionId: "s1",
        runId: "r1",
        runPath: "data/runs/r1",
        status: "completed",
        taskStatus: "done",
        objective: "Build a product website",
        summary: "Created site/index.html.",
        progressSummary: "Website is complete.",
        keyFacts: ["site/index.html exists"],
        toolsUsed: ["write_files"],
        userMessage: "Build a product website in site/index.html",
        createdAt: now.toISOString(),
      });
      const second = store.upsertFromTaskSummary({
        clientId: "c1",
        sessionId: "s1",
        runId: "r2",
        runPath: "data/runs/r2",
        status: "completed",
        taskStatus: "done",
        objective: "Start a different site from scratch in site/index.html",
        summary: "Created a different site/index.html.",
        progressSummary: "New website draft is complete.",
        keyFacts: ["site/index.html exists"],
        toolsUsed: ["write_files"],
        userMessage: "Start a different site from scratch in site/index.html",
        createdAt: now.toISOString(),
      });

      expect(first?.activityId).toBeTruthy();
      expect(second?.activityId).toBeTruthy();
      expect(second?.activityId).not.toBe(first?.activityId);
      expect(second?.runs.map((run) => run.runId)).toEqual(["r2"]);
    } finally {
      store.stop();
    }
  });

  it("stores tool-using machine checks as ephemeral records without auto-reopening them", () => {
    const now = new Date("2026-06-12T09:00:00.000Z");
    const store = new ActivityStore({
      dataDir: tempDataDir(),
      now: () => now,
    });
    store.start();
    try {
      const first = store.upsertFromTaskSummary({
        clientId: "c1",
        sessionId: "s1",
        runId: "ram-1",
        runPath: "data/runs/ram-1",
        status: "completed",
        taskStatus: "done",
        objective: "Check current RAM usage",
        summary: "RAM used is 3.5Gi.",
        progressSummary: "Checked current RAM usage.",
        keyFacts: ["RAM used is 3.5Gi"],
        evidence: ["free -h output captured"],
        toolsUsed: ["shell"],
        userMessage: "what is my ram usage and what programs are using it?",
        createdAt: now.toISOString(),
      });
      const second = store.upsertFromTaskSummary({
        clientId: "c1",
        sessionId: "s1",
        runId: "ram-2",
        runPath: "data/runs/ram-2",
        status: "completed",
        taskStatus: "done",
        objective: "Check current RAM usage again",
        summary: "RAM used is 3.7Gi.",
        progressSummary: "Checked current RAM usage again.",
        keyFacts: ["RAM used is 3.7Gi"],
        evidence: ["free -h output captured"],
        toolsUsed: ["shell"],
        userMessage: "check my ram usage again",
        createdAt: now.toISOString(),
      });

      expect(first?.kind).toBe("ephemeral");
      expect(first?.state.status).toBe("done");
      expect(second?.kind).toBe("ephemeral");
      expect(second?.activityId).not.toBe(first?.activityId);

      const resolver = new ContinuityResolver({ store, now: () => now });
      expect(resolver.resolve({
        clientId: "c1",
        sessionId: "s1",
        userMessage: "check my ram usage again",
      }).mode).toBe("new");

      const historical = resolver.resolve({
        clientId: "c1",
        sessionId: "s1",
        userMessage: "compare with previous ram usage",
      });
      expect(historical.mode).toBe("ambiguous");
      expect(historical.candidates?.map((candidate) => candidate.kind)).toContain("ephemeral");
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
      for (const name of ["product website", "portfolio website", "docs website", "learning website"]) {
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
      expect(resolved.candidates).toHaveLength(3);
    } finally {
      store.stop();
    }
  });
});
