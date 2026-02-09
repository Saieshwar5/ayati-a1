import { describe, expect, it } from "vitest";
import calculatorSkill, { calculatorTool } from "../../../src/skills/builtins/calculator/index.js";

describe("calculator skill definition", () => {
  it("has correct metadata", () => {
    expect(calculatorSkill.id).toBe("calculator");
    expect(calculatorSkill.version).toBe("1.0.0");
    expect(calculatorSkill.tools).toHaveLength(1);
    expect(calculatorSkill.promptBlock).toContain("Calculator Skill");
  });

  it("tool has correct name and schema", () => {
    expect(calculatorTool.name).toBe("calculator");
    expect(calculatorTool.inputSchema).toBeDefined();
  });
});

describe("calculator tool execute", () => {
  it("evaluates a valid expression", async () => {
    const result = await calculatorTool.execute({ expression: "2 + 3" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("5");
    expect(result.meta).toBeDefined();
    expect(result.meta!["expression"]).toBe("2 + 3");
    expect(typeof result.meta!["durationMs"]).toBe("number");
  });

  it("returns exact decimal result", async () => {
    const result = await calculatorTool.execute({ expression: "0.1 + 0.2" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("0.3");
  });

  it("rejects missing input", async () => {
    const result = await calculatorTool.execute(null);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid input");
  });

  it("rejects empty expression", async () => {
    const result = await calculatorTool.execute({ expression: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("non-empty string");
  });

  it("rejects non-string expression", async () => {
    const result = await calculatorTool.execute({ expression: 42 });
    expect(result.ok).toBe(false);
  });

  it("returns error for division by zero", async () => {
    const result = await calculatorTool.execute({ expression: "1/0" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("DIVISION_BY_ZERO");
    expect(result.meta).toBeDefined();
    expect(result.meta!["errorCode"]).toBe("DIVISION_BY_ZERO");
  });

  it("returns error for unknown function", async () => {
    const result = await calculatorTool.execute({ expression: "bogus(1)" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("UNKNOWN_FUNCTION");
  });

  it("handles complex expressions", async () => {
    const result = await calculatorTool.execute({ expression: "sqrt(3^2 + 4^2)" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("5");
  });

  it("trims whitespace from expression", async () => {
    const result = await calculatorTool.execute({ expression: "  2 + 3  " });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("5");
  });
});
