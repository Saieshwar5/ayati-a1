import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/shared/index.js", () => ({
  devWarn: vi.fn(),
}));

describe("builtInSkillsProvider", () => {
  it("loads shell skill by whitelist", async () => {
    const { builtInSkillsProvider } = await import("../../src/skills/provider.js");

    const skills = await builtInSkillsProvider.getEnabledSkills(["shell"]);
    const blocks = await builtInSkillsProvider.getEnabledSkillBlocks(["shell"]);
    const tools = await builtInSkillsProvider.getEnabledTools(["shell"]);

    expect(skills).toHaveLength(1);
    expect(skills[0]?.id).toBe("shell");
    expect(blocks[0]?.id).toBe("shell");
    expect(tools.some((t) => t.name === "shell")).toBe(true);
  });

  it("ignores unknown skills", async () => {
    const { builtInSkillsProvider } = await import("../../src/skills/provider.js");

    const skills = await builtInSkillsProvider.getEnabledSkills(["unknown-skill"]);
    expect(skills).toHaveLength(0);
  });
});
