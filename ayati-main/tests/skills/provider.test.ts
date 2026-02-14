import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/shared/index.js", () => ({
  devWarn: vi.fn(),
}));

describe("builtInSkillsProvider", () => {
  it("returns all built-in skills", async () => {
    const { builtInSkillsProvider } = await import("../../src/skills/provider.js");

    const skills = await builtInSkillsProvider.getAllSkills();

    expect(skills.length).toBeGreaterThanOrEqual(1);
    expect(skills.some((s) => s.id === "shell")).toBe(true);
    expect(skills.some((s) => s.id === "notes")).toBe(true);
  });

  it("returns prompt blocks for all skills", async () => {
    const { builtInSkillsProvider } = await import("../../src/skills/provider.js");

    const blocks = await builtInSkillsProvider.getAllSkillBlocks();

    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks.some((b) => b.id === "shell")).toBe(true);
    expect(blocks.some((b) => b.id === "notes")).toBe(true);
  });

  it("returns all tools", async () => {
    const { builtInSkillsProvider } = await import("../../src/skills/provider.js");

    const tools = await builtInSkillsProvider.getAllTools();

    expect(tools.some((t) => t.name === "shell")).toBe(true);
    expect(tools.some((t) => t.name === "notes")).toBe(true);
  });
});
