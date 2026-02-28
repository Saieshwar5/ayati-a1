import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "../../src/memory/types.js";
import {
  evaluateSessionRotation,
  isLikelyTopicShift,
  isSmallTalkMessage,
} from "../../src/ivec/session-rotation-policy.js";

function turn(role: "user" | "assistant", content: string, date: Date): ConversationTurn {
  return {
    role,
    content,
    timestamp: date.toISOString(),
    sessionPath: "sessions/test.md",
  };
}

describe("session rotation policy", () => {
  it("treats greetings as small talk", () => {
    expect(isSmallTalkMessage("hi")).toBe(true);
    expect(isSmallTalkMessage("how are you?")).toBe(true);
    expect(isSmallTalkMessage("thanks")).toBe(true);
  });

  it("does not treat substantive requests as small talk", () => {
    expect(isSmallTalkMessage("can you check the nginx config and restart plan")).toBe(false);
  });

  it("detects likely topic shift from recent user context", () => {
    const base = new Date(Date.UTC(2026, 1, 20, 12, 0, 0));
    const turns: ConversationTurn[] = [
      turn("user", "check disk usage and inode counts for the server", new Date(base.getTime() - 20_000)),
      turn("assistant", "I can inspect disk usage details.", new Date(base.getTime() - 10_000)),
    ];

    expect(isLikelyTopicShift("what movie should I watch tonight", turns)).toBe(true);
    expect(isLikelyTopicShift("also check disk usage for /var", turns)).toBe(false);
  });

  it("forces rotation when context is at or above hard threshold", () => {
    const now = new Date(Date.UTC(2026, 1, 20, 12, 0, 0));
    const result = evaluateSessionRotation({
      now,
      userMessage: "new question",
      contextPercent: 96,
      turns: [],
      previousSessionSummary: "",
    });

    expect(result.rotate).toBe(true);
    expect(result.reason).toBe("context_overflow");
  });

  it("rotates at midnight when the user is not actively chatting", () => {
    const last = new Date(2026, 1, 28, 22, 0, 0);
    const now = new Date(2026, 2, 1, 0, 15, 0);

    const result = evaluateSessionRotation({
      now,
      userMessage: "continue",
      contextPercent: 40,
      turns: [turn("user", "working on deployment", last)],
      previousSessionSummary: "deployment notes",
    });

    expect(result.rotate).toBe(true);
    expect(result.reason).toBe("midnight_rollover");
  });

  it("defers midnight rollover while user is active", () => {
    const last = new Date(2026, 1, 28, 23, 59, 0);
    const now = new Date(2026, 2, 1, 0, 2, 0);

    const result = evaluateSessionRotation({
      now,
      userMessage: "still fixing the same bug",
      contextPercent: 40,
      turns: [turn("user", "working on auth bug", last)],
      previousSessionSummary: "",
    });

    expect(result.rotate).toBe(false);
    expect(result.pendingMidnight).not.toBeNull();
  });

  it("rotates after midnight deferral limit is reached", () => {
    const last = new Date(2026, 2, 1, 1, 9, 0);
    const firstDetect = new Date(2026, 2, 1, 0, 2, 0);
    const now = new Date(2026, 2, 1, 1, 10, 0);

    const pending = {
      fromDayKey: "2026-02-28",
      toDayKey: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
      firstDetectedAtMs: firstDetect.getTime(),
    };

    const result = evaluateSessionRotation({
      now,
      userMessage: "still same task",
      contextPercent: 40,
      turns: [turn("user", "working on auth bug", last)],
      previousSessionSummary: "",
      pendingMidnight: pending,
    });

    expect(result.rotate).toBe(true);
    expect(result.reason).toBe("midnight_rollover_deferred_limit");
  });

  it("only rotates for topic shift when context is at least 25%", () => {
    const now = new Date(Date.UTC(2026, 1, 20, 12, 0, 0));
    const turns: ConversationTurn[] = [
      turn("user", "check disk usage and inode counts", new Date(now.getTime() - 60_000)),
      turn("assistant", "I can do that.", new Date(now.getTime() - 30_000)),
    ];

    const lowContext = evaluateSessionRotation({
      now,
      userMessage: "what movie should I watch tonight",
      contextPercent: 24,
      turns,
      previousSessionSummary: "",
    });
    expect(lowContext.rotate).toBe(false);

    const readyContext = evaluateSessionRotation({
      now,
      userMessage: "what movie should I watch tonight",
      contextPercent: 25,
      turns,
      previousSessionSummary: "",
    });
    expect(readyContext.rotate).toBe(true);
    expect(readyContext.reason).toBe("topic_shift");
  });

  it("never rotates for small-talk-only message", () => {
    const now = new Date(Date.UTC(2026, 1, 20, 12, 0, 0));
    const turns: ConversationTurn[] = [
      turn("user", "check disk usage and inode counts", new Date(now.getTime() - 60_000)),
      turn("assistant", "I can do that.", new Date(now.getTime() - 30_000)),
    ];

    const result = evaluateSessionRotation({
      now,
      userMessage: "hi",
      contextPercent: 70,
      turns,
      previousSessionSummary: "",
    });

    expect(result.rotate).toBe(false);
  });
});
