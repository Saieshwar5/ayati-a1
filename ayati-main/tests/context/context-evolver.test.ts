import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContextEvolver } from "../../src/context/context-evolver.js";
import { emptyUserProfileContext } from "../../src/context/types.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { ConversationTurn } from "../../src/memory/types.js";

vi.mock("../../src/context/loaders/io.js", () => ({
  writeJsonFileAtomic: vi.fn(async () => {}),
  backupFile: vi.fn(async () => "/backup/file.json"),
}));

function makeTurns(count: number): ConversationTurn[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `Turn ${i}`,
    timestamp: `2025-01-01T00:00:${String(i).padStart(2, "0")}Z`,
  }));
}

function makeProvider(response: LlmTurnOutput): LlmProvider {
  return {
    name: "test",
    version: "1.0",
    capabilities: { nativeToolCalling: false },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi.fn(async () => response),
  };
}

function highConfidenceResponse(): LlmTurnOutput {
  return {
    type: "assistant",
    content: JSON.stringify({
      user_profile_patch: { name: "Alice", interests: ["Rust"] },
      confidence: "high",
      reasoning: "User stated their name and interests",
    }),
  };
}

function noneConfidenceResponse(): LlmTurnOutput {
  return {
    type: "assistant",
    content: JSON.stringify({
      user_profile_patch: {},
      confidence: "none",
      reasoning: "Nothing extractable",
    }),
  };
}

function lowConfidenceResponse(): LlmTurnOutput {
  return {
    type: "assistant",
    content: JSON.stringify({
      user_profile_patch: { name: "Maybe" },
      confidence: "low",
      reasoning: "Not confident",
    }),
  };
}

describe("ContextEvolver", () => {
  let ioMocks: {
    writeJsonFileAtomic: ReturnType<typeof vi.fn>;
    backupFile: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const ioModule = await import("../../src/context/loaders/io.js");
    ioMocks = {
      writeJsonFileAtomic: ioModule.writeJsonFileAtomic as unknown as ReturnType<typeof vi.fn>,
      backupFile: ioModule.backupFile as unknown as ReturnType<typeof vi.fn>,
    };
  });

  it("calls generateTurn with extraction prompt on high-confidence patch", async () => {
    const provider = makeProvider(highConfidenceResponse());
    const callback = vi.fn();

    const evolver = new ContextEvolver({
      provider,
      contextDir: "/ctx",
      historyDir: "/history",
      currentProfile: emptyUserProfileContext(),
      onContextUpdated: callback,
    });

    await evolver.evolveFromSession(makeTurns(6));

    expect(provider.generateTurn).toHaveBeenCalledTimes(1);
    const callArgs = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0]!;
    expect(callArgs.messages).toHaveLength(2);
  });

  it("writes files and fires callback on high-confidence patch", async () => {
    const provider = makeProvider(highConfidenceResponse());
    const callback = vi.fn();

    const evolver = new ContextEvolver({
      provider,
      contextDir: "/ctx",
      historyDir: "/history",
      currentProfile: emptyUserProfileContext(),
      onContextUpdated: callback,
    });

    await evolver.evolveFromSession(makeTurns(6));

    expect(ioMocks.backupFile).toHaveBeenCalledTimes(1);
    expect(ioMocks.writeJsonFileAtomic).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);

    const updated = callback.mock.calls[0]![0]!;
    expect(updated.userProfile.name).toBe("Alice");
    expect(updated.userProfile.interests).toContain("Rust");
  });

  it("skips when confidence is none", async () => {
    const provider = makeProvider(noneConfidenceResponse());
    const callback = vi.fn();

    const evolver = new ContextEvolver({
      provider,
      contextDir: "/ctx",
      historyDir: "/history",
      currentProfile: emptyUserProfileContext(),
      onContextUpdated: callback,
    });

    await evolver.evolveFromSession(makeTurns(6));

    expect(ioMocks.writeJsonFileAtomic).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it("skips when confidence is low", async () => {
    const provider = makeProvider(lowConfidenceResponse());
    const callback = vi.fn();

    const evolver = new ContextEvolver({
      provider,
      contextDir: "/ctx",
      historyDir: "/history",
      currentProfile: emptyUserProfileContext(),
      onContextUpdated: callback,
    });

    await evolver.evolveFromSession(makeTurns(6));

    expect(ioMocks.writeJsonFileAtomic).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not crash on malformed LLM JSON", async () => {
    const provider = makeProvider({ type: "assistant", content: "not json at all {{{" });
    const callback = vi.fn();

    const evolver = new ContextEvolver({
      provider,
      contextDir: "/ctx",
      historyDir: "/history",
      currentProfile: emptyUserProfileContext(),
      onContextUpdated: callback,
    });

    await expect(evolver.evolveFromSession(makeTurns(6))).resolves.toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not crash when provider throws", async () => {
    const provider = makeProvider(highConfidenceResponse());
    (provider.generateTurn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API down"));
    const callback = vi.fn();

    const evolver = new ContextEvolver({
      provider,
      contextDir: "/ctx",
      historyDir: "/history",
      currentProfile: emptyUserProfileContext(),
      onContextUpdated: callback,
    });

    await expect(evolver.evolveFromSession(makeTurns(6))).resolves.toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
  });

  it("skips when fewer than 4 turns", async () => {
    const provider = makeProvider(highConfidenceResponse());

    const evolver = new ContextEvolver({
      provider,
      contextDir: "/ctx",
      historyDir: "/history",
      currentProfile: emptyUserProfileContext(),
    });

    await evolver.evolveFromSession(makeTurns(3));

    expect(provider.generateTurn).not.toHaveBeenCalled();
  });

  it("skips when rate limited (within 60s)", async () => {
    const provider = makeProvider(highConfidenceResponse());

    const evolver = new ContextEvolver({
      provider,
      contextDir: "/ctx",
      historyDir: "/history",
      currentProfile: emptyUserProfileContext(),
    });

    await evolver.evolveFromSession(makeTurns(6));
    expect(provider.generateTurn).toHaveBeenCalledTimes(1);

    await evolver.evolveFromSession(makeTurns(6));
    expect(provider.generateTurn).toHaveBeenCalledTimes(1);
  });

  it("handles response wrapped in markdown code fences", async () => {
    const response: LlmTurnOutput = {
      type: "assistant",
      content: "```json\n" + JSON.stringify({
        user_profile_patch: { name: "Bob" },
        confidence: "high",
        reasoning: "Name found",
      }) + "\n```",
    };

    const provider = makeProvider(response);
    const callback = vi.fn();

    const evolver = new ContextEvolver({
      provider,
      contextDir: "/ctx",
      historyDir: "/history",
      currentProfile: emptyUserProfileContext(),
      onContextUpdated: callback,
    });

    await evolver.evolveFromSession(makeTurns(6));

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]!.userProfile.name).toBe("Bob");
  });
});
