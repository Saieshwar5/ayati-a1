import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/shared/index.js", () => ({
  devWarn: vi.fn(),
}));

describe("builtInSkillsProvider", () => {
  it("returns all built-in skills", async () => {
    const { builtInSkillsProvider } = await import("../../src/skills/provider.js");

    const skills = await builtInSkillsProvider.getAllSkills();

    expect(skills.length).toBeGreaterThanOrEqual(1);
    expect(skills.some((s) => s.id === "process")).toBe(true);
    expect(skills.some((s) => s.id === "database")).toBe(true);
  }, 20000);
});
