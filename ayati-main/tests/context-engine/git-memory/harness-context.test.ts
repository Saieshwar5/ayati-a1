import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGitMemoryHarnessContextFromMemoryState,
  buildGitMemoryHarnessContextPack,
  createGitContextMemoryStateHydrator,
  GitMemoryContextReader,
  GitMemoryDailySessionStore,
} from "../../../src/context-engine/git-memory/index.js";

describe("buildGitMemoryHarnessContextPack", () => {
  it("maps session-only git-memory context into the harness context shape", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-harness-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });

    const raw = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
    });
    const harness = buildGitMemoryHarnessContextPack(raw);

    expect(harness).toMatchObject({
      session: {
        sessionId: "S-20260628-local",
        assetCount: 0,
        conversationTail: [],
        activityTail: [{
          seq: 1,
          type: "session_started",
          sessionId: "S-20260628-local",
        }],
        recentCommits: [{
          subject: "ayati: initialize session S-20260628-local",
        }],
      },
      focus: { status: "none" },
    });
    expect(harness.task).toBeUndefined();

    const memory = await createGitContextMemoryStateHydrator(store).hydrate({
      sessionId: session.sessionId,
    });
    expect(buildGitMemoryHarnessContextFromMemoryState(memory)).toEqual(harness);
  });

  it("maps active task context into the harness context shape expected by the agent", async () => {
    const contextStoreDir = await mkdtemp(join(tmpdir(), "ayati-git-memory-harness-"));
    const store = new GitMemoryDailySessionStore({ contextStoreDir });
    const session = await store.openOrCreateDailySession({
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      agentId: "local",
      createdAt: "2026-06-28T00:00:00+05:30",
    });
    const user = await store.appendConversationMessage({
      sessionId: session.sessionId,
      role: "user",
      text: "Fix upload handling",
      at: "2026-06-28T09:00:00+05:30",
    });
    const task = await store.createTaskBranch({
      sessionId: session.sessionId,
      title: "Fix upload handling",
      objective: "Find and fix upload handling failures.",
      fromSeq: user.seq,
      toSeq: user.seq,
      at: "2026-06-28T09:01:00+05:30",
    });
    await store.commitTaskRun({
      sessionId: session.sessionId,
      taskId: task.taskId,
      status: "completed",
      startedAt: "2026-06-28T09:02:00+05:30",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: user.seq, toSeq: user.seq }],
      summary: "Inspected upload handling.",
      evidence: [{
        step: 1,
        tool: "read_file",
        status: "completed",
        summary: "Read upload server implementation.",
        evidenceRef: "evidence/read-upload-server.txt",
        artifacts: ["ayati-main/src/server/upload-server.ts"],
        facts: ["Upload route validates MIME type."],
        accessModes: ["summary"],
        outputSize: 1200,
        lineCount: 80,
        truncated: false,
        source: {
          kind: "tool-output",
          toolCalls: [{
            kind: "tool-output",
            tool: "read_file",
            callId: "call-read-upload",
            filePath: "ayati-main/src/server/upload-server.ts",
            rawOutputPath: "raw/001-call-read-upload-read_file.txt",
          }],
        },
      }],
      assets: [{
        assetId: "asset-upload-log",
        role: "reference",
        kind: "file",
        name: "upload.log",
        path: "/tmp/upload.log",
      }],
      newFacts: ["Upload route validates MIME type."],
      next: "Patch upload validation handling.",
      state: {
        status: "in_progress",
        completed: ["Inspected upload server"],
        open: ["Patch upload validation handling."],
        next: "Patch upload validation handling.",
      },
    });

    const raw = await new GitMemoryContextReader(store).buildActiveContext({
      sessionId: session.sessionId,
    });
    const harness = buildGitMemoryHarnessContextPack(raw);
    const memory = await createGitContextMemoryStateHydrator(store).hydrate({
      sessionId: session.sessionId,
    });
    const memoryHarness = buildGitMemoryHarnessContextFromMemoryState(memory);

    expect(harness).toMatchObject({
      session: {
        sessionId: "S-20260628-local",
        assetCount: 0,
        conversationTail: [{
          seq: 1,
          role: "user",
          text: "Fix upload handling",
        }],
        conversationMarkdownTail: expect.stringContaining("Fix upload handling"),
      },
      focus: {
        status: "active",
        ref: task.ref,
        workId: task.taskId,
      },
      task: {
        ref: task.ref,
        workId: task.taskId,
        title: "Fix upload handling",
        objective: "Find and fix upload handling failures.",
        status: "in_progress",
        completed: ["Inspected upload server"],
        open: ["Patch upload validation handling."],
        facts: [{
          text: "Upload route validates MIME type.",
          source: "git-memory/task-state",
        }],
        next: "Patch upload validation handling.",
        conversationMarkdownTail: expect.stringContaining("Fix upload handling"),
        assets: [{
          assetId: "asset-upload-log",
          role: "reference",
          kind: "file",
          name: "upload.log",
          path: "/tmp/upload.log",
        }],
        recentRuns: [{
          runId: "R-20260628-0001",
          workId: task.taskId,
          status: "completed",
          summary: "Inspected upload handling.",
          open: ["Patch upload validation handling."],
          actions: [],
          createdAt: "2026-06-28T09:10:00+05:30",
        }],
        recentEvidence: [{
          runId: "R-20260628-0001",
          workId: task.taskId,
          step: 1,
          tool: "read_file",
          status: "completed",
          summary: "Read upload server implementation.",
          evidenceRef: "evidence/read-upload-server.txt",
          artifacts: ["ayati-main/src/server/upload-server.ts"],
          facts: ["Upload route validates MIME type."],
          accessModes: ["summary"],
          outputSize: 1200,
          lineCount: 80,
          truncated: false,
          source: {
            kind: "tool-output",
            toolCalls: [{
              kind: "tool-output",
              tool: "read_file",
              callId: "call-read-upload",
              filePath: "ayati-main/src/server/upload-server.ts",
              rawOutputPath: "raw/001-call-read-upload-read_file.txt",
            }],
          },
        }],
      },
    });
    expect(memoryHarness).toEqual(harness);
    expect(harness.session.recentCommits[0]).toMatchObject({
      subject: "ayati: record user message",
      trailers: {
        event: "conversation_appended",
      },
    });
  });
});
