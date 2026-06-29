import { describe, expect, it } from "vitest";
import {
  GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
  GIT_MEMORY_SESSION_CONVERSATION_PATH,
  GIT_MEMORY_SESSION_EVENTS_PATH,
  GIT_MEMORY_SESSION_META_PATH,
  GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH,
  GIT_MEMORY_SESSION_TASKS_PATH,
  gitMemoryTaskActionsPath,
  gitMemoryTaskAssetsPath,
  gitMemoryTaskContextPath,
  gitMemoryTaskEvidenceManifestPath,
  gitMemoryTaskFilePath,
  gitMemoryTaskMarkdownPath,
  gitMemoryTaskNotesPath,
  gitMemoryTaskRunMarkdownPath,
  gitMemoryTaskRunPath,
  gitMemoryTaskStatePath,
  validateGitMemoryActionRecord,
  validateGitMemoryConversationRecord,
  validateGitMemoryEvidenceManifestRecord,
  validateGitMemoryRunFile,
  validateGitMemorySessionEventRecord,
  validateGitMemorySessionMetaFile,
  validateGitMemoryTaskFile,
  validateGitMemoryTaskIndexFile,
  validateGitMemoryTaskMessageLinkRecord,
  validateGitMemoryTaskStateFile,
} from "../../../src/context-engine/git-memory/index.js";

describe("git memory schema", () => {
  it("defines the canonical daily repo paths", () => {
    expect(GIT_MEMORY_SESSION_META_PATH).toBe("session/meta.json");
    expect(GIT_MEMORY_SESSION_CONVERSATION_PATH).toBe("session/conversation.jsonl");
    expect(GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH).toBe("session/conversation.md");
    expect(GIT_MEMORY_SESSION_EVENTS_PATH).toBe("session/events.jsonl");
    expect(GIT_MEMORY_SESSION_TASKS_PATH).toBe("session/tasks.json");
    expect(GIT_MEMORY_SESSION_TASK_MESSAGE_LINKS_PATH).toBe("session/task-message-links.jsonl");

    expect(gitMemoryTaskFilePath("W-20260628-0001")).toBe("tasks/W-20260628-0001/task.json");
    expect(gitMemoryTaskMarkdownPath("W-20260628-0001")).toBe("tasks/W-20260628-0001/task.md");
    expect(gitMemoryTaskStatePath("W-20260628-0001")).toBe("tasks/W-20260628-0001/state.json");
    expect(gitMemoryTaskRunPath("W-20260628-0001", "R-20260628-0001"))
      .toBe("tasks/W-20260628-0001/runs/R-20260628-0001.json");
    expect(gitMemoryTaskRunMarkdownPath("W-20260628-0001", "R-20260628-0001"))
      .toBe("tasks/W-20260628-0001/runs/R-20260628-0001.md");
    expect(gitMemoryTaskActionsPath("W-20260628-0001", "R-20260628-0001"))
      .toBe("tasks/W-20260628-0001/actions/R-20260628-0001.jsonl");
    expect(gitMemoryTaskEvidenceManifestPath("W-20260628-0001", "R-20260628-0001"))
      .toBe("tasks/W-20260628-0001/evidence/R-20260628-0001/manifest.jsonl");
    expect(gitMemoryTaskAssetsPath("W-20260628-0001")).toBe("tasks/W-20260628-0001/assets.jsonl");
    expect(gitMemoryTaskNotesPath("W-20260628-0001")).toBe("tasks/W-20260628-0001/notes.md");
    expect(gitMemoryTaskContextPath("W-20260628-0001")).toBe("tasks/W-20260628-0001/context.md");
  });

  it("validates startup session files created before the first user message", () => {
    expect(validateGitMemorySessionMetaFile({
      schemaVersion: 1,
      sessionId: "S-20260628-local",
      date: "2026-06-28",
      timezone: "Asia/Kolkata",
      createdAt: "2026-06-28T00:00:00+05:30",
      repoKind: "daily_session",
      agentId: "local",
    }).ok).toBe(true);

    expect(validateGitMemorySessionEventRecord({
      v: 1,
      seq: 1,
      eventId: "E-20260628-000001",
      type: "session_initialized",
      at: "2026-06-28T00:00:00+05:30",
    }).ok).toBe(true);

    expect(validateGitMemoryTaskIndexFile({
      schemaVersion: 1,
      tasks: [],
    }).ok).toBe(true);
  });

  it("validates compact debug and legacy conversation records", () => {
    expect(validateGitMemoryConversationRecord({
      seq: 1,
      role: "user",
      at: "2026-06-28T09:00:00+05:30",
      text: "Fix upload handling",
      branch: "main",
    }).ok).toBe(true);

    expect(validateGitMemoryConversationRecord({
      v: 1,
      seq: 2,
      messageId: "M-20260628-000002",
      turnId: "T-20260628-000001",
      role: "assistant",
      at: "2026-06-28T09:00:05+05:30",
      text: null,
      contentRef: "messages/M-20260628-000002.md",
      sha256: "abc123",
      taskId: "W-20260628-0001",
      runId: "R-20260628-0001",
    }).ok).toBe(true);

    const result = validateGitMemoryConversationRecord({
      v: 1,
      seq: 3,
      messageId: "M-20260628-000003",
      turnId: "T-20260628-000002",
      role: "user",
      at: "2026-06-28T09:02:00+05:30",
      text: "",
      contentRef: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("conversation record must include non-empty text or contentRef.");
    }
  });

  it("validates task-message links as the retrieval map for conversation ranges", () => {
    expect(validateGitMemoryTaskMessageLinkRecord({
      v: 1,
      linkId: "L-20260628-000001",
      taskId: "W-20260628-0001",
      branch: "task/W-20260628-0001-fix-upload-handling",
      reason: "task_created",
      at: "2026-06-28T09:01:00+05:30",
      fromSeq: 1,
      toSeq: 2,
      turnIds: ["T-20260628-000001"],
      runId: "R-20260628-0001",
      summary: "User started upload handling work.",
    }).ok).toBe(true);

    const result = validateGitMemoryTaskMessageLinkRecord({
      v: 1,
      linkId: "L-20260628-000002",
      taskId: "W-20260628-0001",
      branch: "work/W-20260628-0001-old-branch-prefix",
      reason: "task_continued",
      at: "2026-06-28T09:02:00+05:30",
      fromSeq: 5,
      toSeq: 4,
      turnIds: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("branch must be a valid task branch.");
      expect(result.errors).toContain("toSeq must be greater than or equal to fromSeq.");
    }
  });

  it("validates task branch state, run files, and action records", () => {
    expect(validateGitMemoryTaskFile({
      schemaVersion: 1,
      taskId: "W-20260628-0001",
      title: "Fix upload handling",
      objective: "Find and fix the upload handling issue.",
      status: "open",
      createdAt: "2026-06-28T09:01:00+05:30",
      updatedAt: "2026-06-28T09:01:00+05:30",
      createdFrom: {
        sessionId: "S-20260628-local",
        fromSeq: 1,
        toSeq: 2,
      },
    }).ok).toBe(true);

    expect(validateGitMemoryTaskStateFile({
      schemaVersion: 1,
      status: "in_progress",
      summary: "Upload handling fails during document registration.",
      completed: ["Inspected UploadServer wiring"],
      open: ["Patch validation handling"],
      blockers: [],
      facts: ["Uploads are handled by UploadServer."],
      next: "Patch validation handling.",
      updatedAt: "2026-06-28T09:10:00+05:30",
    }).ok).toBe(true);

    expect(validateGitMemoryRunFile({
      schemaVersion: 1,
      runId: "R-20260628-0001",
      taskId: "W-20260628-0001",
      status: "completed",
      startedAt: "2026-06-28T09:01:00+05:30",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: 1, toSeq: 2 }],
      summary: "Inspected upload handling and found validation mismatch.",
      assistantResponse: "I found the upload validation issue.",
      toolCallCount: 3,
      changedFiles: [],
      newFacts: ["UploadServer owns upload request handling."],
      next: "Patch validation handling.",
    }).ok).toBe(true);

    expect(validateGitMemoryActionRecord({
      v: 1,
      actionId: "ACT-20260628-000001",
      runId: "R-20260628-0001",
      tool: "read_file",
      status: "completed",
      summary: "Read upload server implementation.",
      startedAt: "2026-06-28T09:02:00+05:30",
      completedAt: "2026-06-28T09:02:01+05:30",
      evidenceRef: "evidence/ACT-20260628-000001.txt",
    }).ok).toBe(true);

    expect(validateGitMemoryEvidenceManifestRecord({
      v: 1,
      runId: "R-20260628-0001",
      taskId: "W-20260628-0001",
      step: 1,
      actionId: "ACT-20260628-000001",
      tool: "read_file",
      status: "completed",
      summary: "Read upload server implementation.",
      evidenceRef: "read upload-server.ts lines 1-80",
      artifacts: ["ayati-main/src/server/upload-server.ts"],
      facts: ["UploadServer owns upload request handling."],
      accessModes: ["summary"],
      outputSize: 1200,
      lineCount: 80,
      truncated: false,
      source: { kind: "harness-step" },
    }).ok).toBe(true);
  });
});
