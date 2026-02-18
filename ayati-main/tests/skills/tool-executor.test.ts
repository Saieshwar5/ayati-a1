import { describe, expect, it } from "vitest";
import { createToolExecutor } from "../../src/skills/tool-executor.js";

describe("createToolExecutor", () => {
  it("routes to registered tool by name", async () => {
    const executor = createToolExecutor([
      {
        name: "x.run",
        description: "x",
        async execute(input) {
          return { ok: true, output: String((input as { v: string }).v) };
        },
      },
    ]);

    const result = await executor.execute("x.run", { v: "hello" });
    expect(result).toEqual({ ok: true, output: "hello" });
  });

  it("returns unknown tool error", async () => {
    const executor = createToolExecutor([]);
    const result = await executor.execute("missing", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });

  it("validate() returns valid for correct input", () => {
    const executor = createToolExecutor([
      {
        name: "read_file",
        description: "Read file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, offset: { type: "number" } },
          required: ["path"],
        },
        async execute() {
          return { ok: true };
        },
      },
    ]);

    const result = executor.validate("read_file", { path: "/foo.txt" });
    expect(result.valid).toBe(true);
  });

  it("validate() returns error + schema for missing required field", () => {
    const executor = createToolExecutor([
      {
        name: "write_file",
        description: "Write file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
        async execute() {
          return { ok: true };
        },
      },
    ]);

    const result = executor.validate("write_file", { path: "/foo.txt" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("missing required field 'content'");
      expect(result.schema).toHaveProperty("required");
    }
  });

  it("validate() returns error + schema for wrong type", () => {
    const executor = createToolExecutor([
      {
        name: "calc",
        description: "Calculate",
        inputSchema: {
          type: "object",
          properties: { expression: { type: "string" } },
          required: ["expression"],
        },
        async execute() {
          return { ok: true };
        },
      },
    ]);

    const result = executor.validate("calc", { expression: 42 });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("expected type 'string'");
      expect(result.schema).toHaveProperty("properties");
    }
  });

  it("validate() returns error + tool list for unknown tool", () => {
    const executor = createToolExecutor([
      {
        name: "shell",
        description: "Run",
        async execute() {
          return { ok: true };
        },
      },
    ]);

    const result = executor.validate("readFile", {});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Unknown tool: readFile");
      expect(result.schema).toHaveProperty("availableTools");
      expect((result.schema as { availableTools: string[] }).availableTools).toContain("shell");
    }
  });
});
