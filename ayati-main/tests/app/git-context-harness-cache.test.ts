import { describe, expect, it } from "vitest";
import type { ActiveContext } from "ayati-git-context";
import { GitContextHarnessCache } from "../../src/app/git-context-harness-cache.js";

describe("Git Context harness cache", () => {
  it("reuses an unchanged projection and refuses dirty state", () => {
    const cache = new GitContextHarnessCache();
    const first = cache.set("S-1", emptyContext("revision-1"));

    expect(cache.getProjection("S-1")).toBe(first);
    expect(cache.getActive("S-1")?.contextRevision).toBe("revision-1");
    expect(cache.set("S-1", emptyContext("revision-1"))).toBe(first);

    cache.markDirty("S-1");
    expect(cache.getProjection("S-1")).toBeUndefined();
    expect(cache.getActive("S-1")).toBeUndefined();

    const refreshed = cache.set("S-1", emptyContext("revision-2"));
    expect(refreshed).not.toBe(first);
    expect(cache.getProjection("S-1")).toBe(refreshed);
    expect(cache.getStats("S-1")).toMatchObject({
      revision: "revision-2",
      hits: 2,
      misses: 1,
      refreshes: 2,
      dirtyTransitions: 1,
      dirty: false,
    });
  });

  it("removes session mirrors independently", () => {
    const cache = new GitContextHarnessCache();
    cache.set("S-1", emptyContext("revision-1"));
    cache.set("S-2", emptyContext("revision-2"));

    cache.remove("S-1");

    expect(cache.getProjection("S-1")).toBeUndefined();
    expect(cache.getProjection("S-2")).toBeDefined();
  });

  it("projects the service read working set into agent-ready context", () => {
    const cache = new GitContextHarnessCache();
    const active: ActiveContext = {
      contextRevision: "revision-read",
      session: {
        session: {
          sessionId: "S-1",
          repositoryPath: "/session",
          head: "a".repeat(40),
          date: "2026-07-14",
          timezone: "UTC",
          status: "open",
        },
        summary: "",
        pendingConversation: [],
        pendingConversationContext: [],
        pendingDigest: "digest",
        recentCommits: [],
      },
      readContext: {
        revision: "read-revision",
        inventory: [],
        discovery: [],
        evidence: [{
          key: "evidence:read_files:requirements.md",
          runId: "R-1",
          step: 1,
          runClass: "session",
          tool: "read_files",
          purpose: "Read requirements.",
          resources: ["requirements.md"],
          input: { files: [{ path: "requirements.md" }] },
          output: { files: [{ path: "requirements.md", content: "requirements" }] },
          verification: { passed: true },
          createdAt: "2026-07-14T10:00:00.000Z",
        }],
        actions: [],
      },
      warnings: [],
    };

    const projected = cache.set("S-1", active);

    expect(projected.readContext).toEqual(active.readContext);
  });
});

function emptyContext(contextRevision: string): ActiveContext {
  return {
    contextRevision,
    session: null,
    warnings: [],
  };
}
