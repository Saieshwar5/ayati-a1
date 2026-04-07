import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import { emptyUserProfileContext } from "../../src/context/types.js";
import { UserWikiStore } from "../../src/context/wiki-store.js";
import { WikiEvolver } from "../../src/context/wiki-evolution.js";
import type { ConversationTurn } from "../../src/memory/types.js";

function makeTurns(count: number): ConversationTurn[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `Turn ${i}`,
    timestamp: `2026-04-05T00:00:${String(i).padStart(2, "0")}Z`,
    sessionPath: "sessions/test.md",
  }));
}

function makeProvider(response: LlmTurnOutput): LlmProvider {
  return {
    name: "test",
    version: "1.0.0",
    capabilities: { nativeToolCalling: false },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi.fn(async () => response),
  };
}

describe("WikiEvolver", () => {
  let tmpDir: string;
  let contextDir: string;
  let historyDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wiki-evolver-"));
    contextDir = join(tmpDir, "context");
    historyDir = join(tmpDir, "history");
    await mkdir(contextDir, { recursive: true });
    await mkdir(historyDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes wiki and projected profile on high-confidence updates", async () => {
    const store = new UserWikiStore({ contextDir, historyDir });
    const seedProfile = emptyUserProfileContext();
    await store.ensureInitialized(seedProfile);

    const provider = makeProvider({
      type: "assistant",
      content: JSON.stringify({
        section_updates: [
          { section: "Projects", add_items: ["Ayati"], source: "explicit" },
          { section: "Communication Preferences", set_fields: { Verbosity: "brief" }, source: "explicit" },
        ],
        confidence: "high",
        reasoning: "User mentioned the project and preferred concise replies.",
      }),
    });
    const callback = vi.fn();

    const evolver = new WikiEvolver({
      provider,
      wikiStore: store,
      currentProfile: seedProfile,
      onProfileUpdated: callback,
    });

    await evolver.evolveFromSession(makeTurns(6), "User prefers concise replies.");

    const wikiText = await readFile(join(contextDir, "user.wiki"), "utf-8");
    const profileText = await readFile(join(contextDir, "user_profile.json"), "utf-8");

    expect(wikiText).toContain("## Projects");
    expect(wikiText).toContain("- Ayati");
    expect(profileText).toContain('"projects": [');
    expect(profileText).toContain('"Ayati"');
    expect(profileText).toContain('"verbosity": "brief"');
    expect(callback).toHaveBeenCalledOnce();
  });

  it("skips writes on low confidence", async () => {
    const store = new UserWikiStore({ contextDir, historyDir });
    const seedProfile = emptyUserProfileContext();
    await store.ensureInitialized(seedProfile);

    const provider = makeProvider({
      type: "assistant",
      content: JSON.stringify({
        section_updates: [{ section: "Projects", add_items: ["Ayati"], source: "inferred" }],
        confidence: "low",
        reasoning: "Not confident.",
      }),
    });

    const evolver = new WikiEvolver({
      provider,
      wikiStore: store,
      currentProfile: seedProfile,
    });

    await evolver.evolveFromSession(makeTurns(6));

    const wikiText = await readFile(join(contextDir, "user.wiki"), "utf-8");
    expect(wikiText).not.toContain("Ayati");
  });
});
