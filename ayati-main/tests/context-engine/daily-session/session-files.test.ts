import { describe, expect, it } from "vitest";
import {
  SESSION_ASSETS_PATH,
  SESSION_CONVERSATION_PATH,
  SESSION_EVENTS_PATH,
  SESSION_META_PATH,
  validateConversationRecord,
  validateSessionAssetRecord,
  validateSessionEventRecord,
  validateSessionMetaFile,
} from "../../../src/context-engine/daily-session/index.js";

describe("daily session main files", () => {
  it("keeps daily main files small and machine-readable", () => {
    expect(SESSION_META_PATH).toBe("session/meta.json");
    expect(SESSION_CONVERSATION_PATH).toBe("session/conversation.jsonl");
    expect(SESSION_ASSETS_PATH).toBe("session/assets.jsonl");
    expect(SESSION_EVENTS_PATH).toBe("session/events.jsonl");
  });

  it("validates session metadata and simple conversation records", () => {
    expect(validateSessionMetaFile({
      schemaVersion: 1,
      sessionId: "2026-06-27",
      date: "2026-06-27",
      timezone: "Asia/Kolkata",
      createdAt: "2026-06-27T00:00:00+05:30",
    }).ok).toBe(true);

    expect(validateConversationRecord({
      seq: 1,
      role: "user",
      at: "2026-06-27T10:00:00+05:30",
      text: "Analyze these files",
    }).ok).toBe(true);

    expect(validateConversationRecord({
      seq: 1,
      role: "assistant",
      at: "2026-06-27T10:00:05+05:30",
      text: "I will inspect the attached files first.",
    }).ok).toBe(true);
  });

  it("validates assets and routing-neutral session events", () => {
    expect(validateSessionAssetRecord({
      assetId: "A-20260627-0001",
      kind: "user_file",
      name: "contract.pdf",
      path: "/home/user/contract.pdf",
      sha256: "abc123",
      createdAt: "2026-06-27T10:00:00+05:30",
    }).ok).toBe(true);

    expect(validateSessionEventRecord({
      seq: 2,
      type: "task_branch_created",
      at: "2026-06-27T10:00:10+05:30",
      workId: "W-20260627-0001",
      branch: "work/W-20260627-0001-analyze-files",
      ref: "refs/heads/work/W-20260627-0001-analyze-files",
    }).ok).toBe(true);
  });
});
