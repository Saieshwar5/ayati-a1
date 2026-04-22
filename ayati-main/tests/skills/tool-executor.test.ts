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

  it("converts thrown tool exceptions into normal tool errors", async () => {
    const executor = createToolExecutor([
      {
        name: "boom",
        description: "Throws",
        async execute() {
          throw new Error("unexpected failure");
        },
      },
    ]);

    const result = await executor.execute("boom", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Tool 'boom' threw an exception");
    expect(result.error).toContain("unexpected failure");
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

  it("supports mounting scoped dynamic tool groups and expiring step-scoped tools", async () => {
    const executor = createToolExecutor([
      {
        name: "shell",
        description: "Run",
        async execute() {
          return { ok: true };
        },
      },
    ]);

    executor.mount?.("dynamic:websearch", [
      {
        name: "websearch.search",
        description: "Search",
        async execute() {
          return { ok: true, output: "ok" };
        },
      },
    ], {
      scope: "step",
      runId: "r1",
      sessionId: "s1",
      activatedAtStep: 1,
      expiresAfterStep: 2,
      skillId: "websearch",
      toolIds: ["search"],
    });

    expect(executor.list({ runId: "r1", sessionId: "s1", stepNumber: 1 })).toContain("websearch.search");
    expect(executor.list({ runId: "other", sessionId: "s1", stepNumber: 1 })).not.toContain("websearch.search");

    const result = await executor.execute("websearch.search", {}, { runId: "r1", sessionId: "s1", stepNumber: 2 });
    expect(result.ok).toBe(true);

    const removed = executor.cleanupExpired?.({ runId: "r1", sessionId: "s1", stepNumber: 2 }) ?? [];
    expect(removed).toContain("dynamic:websearch");
    expect(executor.list({ runId: "r1", sessionId: "s1", stepNumber: 3 })).not.toContain("websearch.search");
  });

});
