import { describe, expect, it } from "vitest";
import {
  buildRecentFilesHotContextEntry,
  buildRecentWorkStatesHotContextEntry,
  buildRecentWorkstreamsHotContextEntry,
  buildRunHotContextEntries,
  createPersonalMemoryHotContextSource,
  FILES_RECENT_HOT_CONTEXT_KEY,
  HotContextRuntime,
  MAX_RECENT_HOT_CONTEXT_FILES,
  readRecentFilesHotContextContent,
  RUN_SCOPED_HOT_CONTEXT_KEYS,
  type HotContextSource,
  WORKSTATES_RECENT_HOT_CONTEXT_KEY,
  MAX_RECENT_HOT_CONTEXT_WORK_STATES,
  WORKSTREAMS_RECENT_HOT_CONTEXT_KEY,
} from "../../src/ivec/hot-context/index.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";

describe("HotContextRuntime", () => {
  it("registers recent files and workstreams as run-scoped Hot Context", () => {
    expect(RUN_SCOPED_HOT_CONTEXT_KEYS).toEqual([
      FILES_RECENT_HOT_CONTEXT_KEY,
      WORKSTREAMS_RECENT_HOT_CONTEXT_KEY,
      WORKSTATES_RECENT_HOT_CONTEXT_KEY,
    ]);
  });

  it("keeps the five active documents out of older recent-file Hot Context", () => {
    const context = contextEngineFixture();
    context.agentStream.recentFiles = Array.from({ length: 6 }, (_, index) => ({
      name: `field-brief-${index + 1}.txt`,
      path: `/workspace/archive/field-brief-${index + 1}.txt`,
      lastReadAt: `2026-07-25T08:21:0${index}.000Z`,
      evidenceRef: `run:RUN-${index + 1}:step:2:call:call-read`,
      coverage: "complete" as const,
      status: "navigation_only" as const,
      requestSeq: 19 + index * 2,
      responseSeq: 20 + index * 2,
    }));

    const entries = buildRunHotContextEntries({ context });

    expect(entries).toEqual([
      expect.objectContaining({
        key: FILES_RECENT_HOT_CONTEXT_KEY,
      }),
    ]);
    expect(readRecentFilesHotContextContent(entries[0]!.content)).toEqual([
      expect.objectContaining({
        path: "/workspace/archive/field-brief-6.txt",
        requestSeq: 29,
        responseSeq: 30,
      }),
    ]);
  });

  it("advertises metadata, mounts content for one run, and returns receipts without content", () => {
    let snapshot = "The user prefers concise architecture explanations.";
    const runtime = new HotContextRuntime({
      sources: [
        createPersonalMemoryHotContextSource({
          getSnapshot: () => snapshot,
        }),
      ],
      maxMountedTokens: 100,
    });

    const initial = runtime.project("client-1", "RUN-1");
    expect(initial.available).toEqual([
      expect.objectContaining({
        key: "personal.memory",
        description: expect.any(String),
        estimatedTokens: expect.any(Number),
      }),
    ]);
    expect(initial.available[0]).not.toHaveProperty("content");
    expect(initial.loaded).toEqual([]);

    const receipt = runtime.load({
      clientId: "client-1",
      runId: "RUN-1",
      keys: ["personal.memory"],
      stepNumber: 2,
    });
    expect(receipt).toMatchObject({
      loaded: ["personal.memory"],
      alreadyLoaded: [],
      rejected: [],
    });
    expect(JSON.stringify(receipt)).not.toContain(snapshot);

    const mounted = runtime.project("client-1", "RUN-1");
    expect(mounted.available).toEqual([]);
    expect(mounted.loaded).toEqual([
      expect.objectContaining({
        key: "personal.memory",
        content: snapshot,
        mountedAtStep: 2,
      }),
    ]);
    expect(runtime.project("client-1", "RUN-2").loaded).toEqual([]);

    snapshot = "The user now prefers detailed architecture explanations.";
    const afterSourceChange = runtime.project("client-1", "RUN-1");
    expect(afterSourceChange.loaded).toEqual([]);
    expect(afterSourceChange.available).toEqual([
      expect.objectContaining({
        key: "personal.memory",
      }),
    ]);
  });

  it("enforces one deterministic mounted-token budget", () => {
    const source: HotContextSource = {
      key: "large.context",
      read: () => ({
        key: "large.context",
        description: "A deliberately large test entry.",
        version: "1",
        estimatedTokens: 12,
        freshness: "current",
        sourceRefs: ["test:large"],
        content: "large content",
      }),
    };
    const runtime = new HotContextRuntime({
      sources: [source],
      maxMountedTokens: 10,
    });

    expect(runtime.load({
      clientId: "client-1",
      runId: "RUN-1",
      keys: ["large.context"],
      stepNumber: 1,
    })).toEqual({
      loaded: [],
      alreadyLoaded: [],
      rejected: [{ key: "large.context", reason: "token_budget" }],
      mountedTokens: 0,
      maxMountedTokens: 10,
    });
  });

  it("clears disposable run mounts without changing the source catalog", () => {
    const runtime = new HotContextRuntime({
      sources: [{
        key: "test.context",
        read: () => ({
          key: "test.context",
          description: "Test context.",
          version: "1",
          estimatedTokens: 2,
          freshness: "current",
          sourceRefs: ["test:context"],
          content: "test content",
        }),
      }],
    });
    runtime.load({
      clientId: "client-1",
      runId: "RUN-1",
      keys: ["test.context"],
      stepNumber: 1,
    });

    runtime.clearRun("client-1", "RUN-1");

    expect(runtime.project("client-1", "RUN-1")).toMatchObject({
      available: [{ key: "test.context" }],
      loaded: [],
      budget: { mountedTokens: 0 },
    });
  });

  it("advertises and mounts prepared recent-workstream metadata only for its run", () => {
    const runtime = new HotContextRuntime({
      sources: [],
      runScopedKeys: [WORKSTREAMS_RECENT_HOT_CONTEXT_KEY],
    });
    const entry = buildRecentWorkstreamsHotContextEntry([{
      workstreamId: "W-20260724-0001",
      title: "Hot Context implementation",
      lifecycleStatus: "active",
      repositoryHealth: "ready",
      currentRequest: {
        id: "R-0002",
        title: "Add recent workstreams",
        status: "active",
      },
      lastActivity: {
        kind: "bound",
        at: "2026-07-24T10:00:00.000Z",
      },
    }])!;
    runtime.syncRun({
      clientId: "client-1",
      runId: "RUN-1",
      entries: [entry],
    });

    const available = runtime.project("client-1", "RUN-1");
    expect(available.available).toEqual([
      expect.objectContaining({
        key: WORKSTREAMS_RECENT_HOT_CONTEXT_KEY,
        sourceRefs: ["workstream-catalog:recent"],
      }),
    ]);
    expect(JSON.stringify(available.available)).not.toContain("W-20260724-0001");
    expect(runtime.project("client-1", "RUN-2").available).toEqual([]);

    const receipt = runtime.load({
      clientId: "client-1",
      runId: "RUN-1",
      keys: [WORKSTREAMS_RECENT_HOT_CONTEXT_KEY],
      stepNumber: 1,
    });
    expect(receipt.loaded).toEqual([WORKSTREAMS_RECENT_HOT_CONTEXT_KEY]);
    expect(JSON.stringify(receipt)).not.toContain("W-20260724-0001");
    expect(runtime.project("client-1", "RUN-1").loaded[0]?.content)
      .toContain("W-20260724-0001");
  });

  it("caps recent-workstream Hot Context at ten distinct projected records", () => {
    const entry = buildRecentWorkstreamsHotContextEntry(
      Array.from({ length: 12 }, (_, index) => ({
        workstreamId: `W-20260724-${String(index + 1).padStart(4, "0")}`,
        title: `Workstream ${index + 1}`,
        lifecycleStatus: "active" as const,
        repositoryHealth: "ready" as const,
        lastActivity: {
          kind: "created" as const,
          at: `2026-07-24T10:${String(index).padStart(2, "0")}:00.000Z`,
        },
      })),
    )!;

    const content = JSON.parse(entry.content) as { workstreams: unknown[] };
    expect(content.workstreams).toHaveLength(10);
    expect(buildRecentWorkstreamsHotContextEntry([])).toBeUndefined();
  });

  it("advertises recent WorkState handoffs and mounts their content only on demand", () => {
    const runId = "RUN-RECENT-WORK-1";
    const summary = "Implemented deterministic validation and preserved the next action.";
    const entry = buildRecentWorkStatesHotContextEntry([{
      runId,
      sourceRef: `run:${runId}`,
      requestSeq: 21,
      responseSeq: 22,
      completedAt: "2026-07-26T10:00:00.000Z",
      runStatus: "done",
      stopReason: "completed",
      workState: {
        status: "done",
        summary,
        plan: [{
          id: "validation",
          task: "Implement deterministic validation.",
          status: "done",
        }],
        importantContext: [{
          kind: "artifact",
          value: "Created the verification index.",
          ref: `run:${runId}:step:2:call:write-index`,
        }],
        updateReason: "run_completed",
        updatedAt: "2026-07-26T10:00:00.000Z",
      },
      workstream: {
        workstreamId: "W-20260726-0001",
        title: "Validation redesign",
        requestId: "R-0001",
        requestTitle: "Build deterministic validation",
      },
    }])!;
    const runtime = new HotContextRuntime({
      sources: [],
      runScopedKeys: [WORKSTATES_RECENT_HOT_CONTEXT_KEY],
    });
    runtime.syncRun({
      clientId: "client-1",
      runId: "RUN-CURRENT",
      entries: [entry],
    });

    const available = runtime.project("client-1", "RUN-CURRENT");
    expect(available.available).toEqual([
      expect.objectContaining({
        key: WORKSTATES_RECENT_HOT_CONTEXT_KEY,
        sourceRefs: [`run:${runId}`],
      }),
    ]);
    expect(JSON.stringify(available.available)).not.toContain(summary);
    expect(available.loaded).toEqual([]);

    const receipt = runtime.load({
      clientId: "client-1",
      runId: "RUN-CURRENT",
      keys: [WORKSTATES_RECENT_HOT_CONTEXT_KEY],
      stepNumber: 1,
    });
    expect(receipt.loaded).toEqual([WORKSTATES_RECENT_HOT_CONTEXT_KEY]);
    expect(JSON.stringify(receipt)).not.toContain(summary);

    const loaded = runtime.project("client-1", "RUN-CURRENT").loaded[0];
    expect(loaded?.content).toContain(summary);
    expect(loaded?.content).toContain("\"historicalHandoffOnly\":true");
    expect(loaded?.mountedAtStep).toBe(1);
  });

  it("caps recent WorkState Hot Context at five distinct runs", () => {
    const entry = buildRecentWorkStatesHotContextEntry(
      Array.from(
        { length: MAX_RECENT_HOT_CONTEXT_WORK_STATES + 2 },
        (_, index) => {
          const runId = `RUN-${index + 1}`;
          return {
            runId,
            sourceRef: `run:${runId}`,
            completedAt: `2026-07-26T10:${String(index).padStart(2, "0")}:00.000Z`,
            runStatus: "done" as const,
            stopReason: "completed" as const,
            workState: {
              status: "done" as const,
              summary: `Completed material run ${index + 1}.`,
              plan: [],
              importantContext: [],
              updateReason: "run_completed" as const,
              updatedAt: `2026-07-26T10:${String(index).padStart(2, "0")}:00.000Z`,
            },
          };
        },
      ),
    )!;

    const content = JSON.parse(entry.content) as { workStates: unknown[] };
    expect(content.workStates).toHaveLength(MAX_RECENT_HOT_CONTEXT_WORK_STATES);
    expect(entry.sourceRefs).toHaveLength(MAX_RECENT_HOT_CONTEXT_WORK_STATES);
    expect(buildRecentWorkStatesHotContextEntry([])).toBeUndefined();
  });

  it("mounts bounded recent-file navigation metadata without caching file content", () => {
    const path = "/workspace/archive/lumen-garden-field-brief.txt";
    const evidenceRef = "run:RUN-1:step:2:call:call-read";
    const entry = buildRecentFilesHotContextEntry([{
      name: "lumen-garden-field-brief.txt",
      path,
      lastReadAt: "2026-07-25T08:21:08.000Z",
      evidenceRef,
      coverage: "complete",
      status: "navigation_only",
      requestSeq: 19,
      responseSeq: 20,
      sizeBytes: 376,
      lineCount: 8,
      sha256: "sha256-field-brief",
    }])!;
    const runtime = new HotContextRuntime({
      sources: [],
      runScopedKeys: [FILES_RECENT_HOT_CONTEXT_KEY],
    });
    runtime.syncRun({
      clientId: "client-1",
      runId: "RUN-2",
      entries: [entry],
    });

    expect(runtime.project("client-1", "RUN-2").available).toEqual([
      expect.objectContaining({
        key: FILES_RECENT_HOT_CONTEXT_KEY,
        sourceRefs: [evidenceRef],
      }),
    ]);
    expect(JSON.stringify(runtime.project("client-1", "RUN-2").available))
      .not.toContain(path);

    runtime.load({
      clientId: "client-1",
      runId: "RUN-2",
      keys: [FILES_RECENT_HOT_CONTEXT_KEY],
      stepNumber: 0,
    });
    const loaded = runtime.project("client-1", "RUN-2").loaded[0];
    expect(readRecentFilesHotContextContent(loaded!.content)).toEqual([
      expect.objectContaining({
        path,
        evidenceRef,
        status: "navigation_only",
        requestSeq: 19,
        responseSeq: 20,
      }),
    ]);
    expect(loaded!.content).not.toContain("Moonlace fern");
  });

  it("caps older recent-file Hot Context at 27 distinct paths", () => {
    const entry = buildRecentFilesHotContextEntry(
      Array.from({ length: MAX_RECENT_HOT_CONTEXT_FILES + 2 }, (_, index) => ({
        name: `file-${index + 1}.txt`,
        path: `/workspace/file-${index + 1}.txt`,
        lastReadAt: `2026-07-25T08:${String(index).padStart(2, "0")}:00.000Z`,
        evidenceRef: `run:RUN-${index + 1}:step:1:call:call-read`,
        coverage: "complete" as const,
        status: "navigation_only" as const,
      })),
    )!;

    expect(readRecentFilesHotContextContent(entry.content))
      .toHaveLength(MAX_RECENT_HOT_CONTEXT_FILES);
    expect(buildRecentFilesHotContextEntry([])).toBeUndefined();
  });
});
