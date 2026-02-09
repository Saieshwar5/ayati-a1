import { describe, it, expect } from "vitest";
import { buildExtractionMessages } from "../../src/context/evolution-prompt.js";
import { emptyUserProfileContext } from "../../src/context/types.js";
import type { ConversationTurn } from "../../src/memory/types.js";

const sampleTurns: ConversationTurn[] = [
  { role: "user", content: "Hi, my name is Alice", timestamp: "2025-01-01T00:00:00Z" },
  { role: "assistant", content: "Hello Alice!", timestamp: "2025-01-01T00:00:01Z" },
  { role: "user", content: "I work as a developer", timestamp: "2025-01-01T00:00:02Z" },
  { role: "assistant", content: "That's great!", timestamp: "2025-01-01T00:00:03Z" },
];

describe("buildExtractionMessages", () => {
  it("returns exactly 2 messages (system + user)", () => {
    const messages = buildExtractionMessages(sampleTurns, emptyUserProfileContext());
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
  });

  it("includes current profile JSON in user message", () => {
    const profile = emptyUserProfileContext();
    profile.name = "TestUser";
    const messages = buildExtractionMessages(sampleTurns, profile);
    const userContent = (messages[1] as { role: string; content: string }).content;
    expect(userContent).toContain('"name": "TestUser"');
    expect(userContent).toContain("Current User Profile");
  });

  it("does not include soul in user message", () => {
    const messages = buildExtractionMessages(sampleTurns, emptyUserProfileContext());
    const userContent = (messages[1] as { role: string; content: string }).content;
    expect(userContent).not.toContain("Current Soul");
  });

  it("formats conversation turns with role labels", () => {
    const messages = buildExtractionMessages(sampleTurns, emptyUserProfileContext());
    const userContent = (messages[1] as { role: string; content: string }).content;
    expect(userContent).toContain("[user]: Hi, my name is Alice");
    expect(userContent).toContain("[assistant]: Hello Alice!");
  });

  it("system message does not mention soul fields", () => {
    const messages = buildExtractionMessages(sampleTurns, emptyUserProfileContext());
    const systemContent = (messages[0] as { role: string; content: string }).content;
    expect(systemContent).not.toContain("soul_patch");
    expect(systemContent).not.toContain("soul.name");
    expect(systemContent).not.toContain("IMMUTABLE");
  });

  it("truncates to last 30 turns", () => {
    const manyTurns: ConversationTurn[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "user" as const : "assistant" as const,
      content: `Message ${i}`,
      timestamp: `2025-01-01T00:00:${String(i).padStart(2, "0")}Z`,
    }));

    const messages = buildExtractionMessages(manyTurns, emptyUserProfileContext());
    const userContent = (messages[1] as { role: string; content: string }).content;
    expect(userContent).not.toContain("Message 0");
    expect(userContent).not.toContain("Message 9");
    expect(userContent).toContain("Message 10");
    expect(userContent).toContain("Message 39");
  });
});
