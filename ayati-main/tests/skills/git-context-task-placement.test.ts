import { describe, expect, it } from "vitest";
import type { ActiveContext } from "ayati-git-context";
import {
  parseTaskPlacement,
  resolveTaskPlacement,
} from "../../src/skills/builtins/git-context/task-placement.js";

const WORKSPACE_ROOT = "/tmp/ayati-task-placement-workspace";

describe("task placement", () => {
  it("accepts a requested path supported by the current user message", () => {
    const placement = parseTaskPlacement({
      mode: "requested",
      path: "workspace/aurora-coffee-site",
    });

    expect(placement).toBeDefined();
    expect(resolveTaskPlacement(placement!, activeContext(
      "Create it in workspace/aurora-coffee-site.",
    ), WORKSPACE_ROOT)).toEqual({
      ok: true,
      placement: {
        mode: "requested",
        workingDirectory: "/tmp/ayati-task-placement-workspace/aurora-coffee-site",
      },
      evidence: { source: "current_user_message" },
    });
  });

  it("accepts an absolute workspace path supported by a relative verified read", () => {
    const active = activeContext("Build the website from the requirements file.");
    active.readContext = {
      revision: "read-1",
      entries: [{
        key: "requirements-read",
        runId: "R-20260715-0001",
        step: 2,
        runClass: "session",
        tool: "read_files",
        purpose: "Read the website requirements.",
        resources: ["website-requirements.md"],
        output: "Create the website in a directory named `aurora-coffee-site` inside the active workspace.",
        verification: { status: "passed" },
        createdAt: "2026-07-15T09:00:00+05:30",
      }],
    };
    const placement = parseTaskPlacement({
      mode: "requested",
      path: "/tmp/ayati-task-placement-workspace/aurora-coffee-site",
    });

    expect(placement).toBeDefined();
    expect(resolveTaskPlacement(placement!, active, WORKSPACE_ROOT)).toEqual({
      ok: true,
      placement: {
        mode: "requested",
        workingDirectory: "/tmp/ayati-task-placement-workspace/aurora-coffee-site",
      },
      evidence: {
        source: "verified_read",
        readContextKey: "requirements-read",
      },
    });
  });

  it("does not authorize an external absolute path from its basename alone", () => {
    const active = activeContext("Build the website from the requirements file.");
    active.readContext = {
      revision: "read-1",
      entries: [{
        key: "requirements-read",
        runId: "R-20260715-0001",
        step: 2,
        runClass: "session",
        tool: "read_files",
        purpose: "Read the website requirements.",
        resources: ["website-requirements.md"],
        output: "Create it in aurora-coffee-site.",
        verification: { status: "passed" },
        createdAt: "2026-07-15T09:00:00+05:30",
      }],
    };
    const placement = parseTaskPlacement({
      mode: "requested",
      path: "/srv/customer/aurora-coffee-site",
    });

    expect(resolveTaskPlacement(placement!, active, WORKSPACE_ROOT)).toMatchObject({
      ok: false,
      message: expect.stringContaining("not supported"),
    });
  });

  it("does not accept a requested path that only prefixes a different path", () => {
    const placement = parseTaskPlacement({
      mode: "requested",
      path: "aurora-coffee-site",
    });

    expect(resolveTaskPlacement(placement!, activeContext(
      "Create the task in aurora-coffee-site-old.",
    ), WORKSPACE_ROOT)).toMatchObject({ ok: false });
  });

  it("rejects managed placement when the user refers to a requested directory", () => {
    const placement = parseTaskPlacement({ mode: "managed" });

    expect(resolveTaskPlacement(placement!, activeContext(
      "Build the site in the requested workspace directory.",
    ), WORKSPACE_ROOT)).toMatchObject({
      ok: false,
      message: expect.stringContaining("requested directory"),
    });
  });

  it("allows managed placement when no location was requested", () => {
    const placement = parseTaskPlacement({ mode: "managed" });

    expect(resolveTaskPlacement(placement!, activeContext(
      "Build a small coffee-shop website.",
    ), WORKSPACE_ROOT)).toEqual({ ok: true, placement: { mode: "managed" } });
  });

  it("rejects evidence that does not contain the requested path", () => {
    const placement = parseTaskPlacement({
      mode: "requested",
      path: "workspace/other-site",
    });

    expect(resolveTaskPlacement(placement!, activeContext(
      "Create it in workspace/aurora-coffee-site.",
    ), WORKSPACE_ROOT)).toMatchObject({ ok: false });
  });

  it("requires a path for requested placement and forbids it for managed placement", () => {
    expect(parseTaskPlacement({ mode: "requested" })).toBeUndefined();
    expect(parseTaskPlacement({ mode: "managed", path: "site" })).toBeUndefined();
  });
});

function activeContext(userMessage: string): ActiveContext {
  return {
    contextRevision: "context-1",
    session: {
      session: {
        sessionId: "S-20260715-local",
        repositoryPath: "/tmp/session",
        head: null,
        date: "2026-07-15",
        timezone: "Asia/Kolkata",
        status: "open",
      },
      summary: "",
      pendingConversation: [],
      pendingConversationContext: [{
        conversation: {
          conversationId: "C-1",
          sessionId: "S-20260715-local",
          sequence: 1,
          filePath: "",
          status: "active",
        },
        messages: [{
          messageId: "M-1",
          conversationId: "C-1",
          sessionSequence: 1,
          segmentSequence: 1,
          sequence: 1,
          role: "user",
          content: userMessage,
          at: "2026-07-15T09:00:00+05:30",
        }],
        contentHash: "hash",
      }],
      pendingDigest: "digest",
      recentCommits: [],
    },
    warnings: [],
  };
}
