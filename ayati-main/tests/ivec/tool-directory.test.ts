import { describe, it, expect } from "vitest";
import { buildToolDirectory } from "../../src/ivec/tool-directory.js";
import type { ToolDefinition } from "../../src/skills/types.js";

function makeTool(name: string, description: string, schema?: Record<string, unknown>): ToolDefinition {
  return {
    name,
    description,
    inputSchema: schema,
    async execute() {
      return { ok: true };
    },
  };
}

describe("buildToolDirectory", () => {
  it("generates a markdown table with tool info", () => {
    const tools: ToolDefinition[] = [
      makeTool("read_file", "Read text file", {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
        },
        required: ["path"],
      }),
    ];

    const result = buildToolDirectory(tools);
    expect(result).toContain("| Tool | Description | Parameters |");
    expect(result).toContain("| read_file | Read text file | path* (string), offset (number) |");
  });

  it("marks required params with asterisk", () => {
    const tools: ToolDefinition[] = [
      makeTool("write_file", "Write to file", {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          createDirs: { type: "boolean" },
        },
        required: ["path", "content"],
      }),
    ];

    const result = buildToolDirectory(tools);
    expect(result).toContain("path* (string)");
    expect(result).toContain("content* (string)");
    expect(result).toContain("createDirs (boolean)");
  });

  it("shows types in parentheses", () => {
    const tools: ToolDefinition[] = [
      makeTool("calc", "Math eval", {
        type: "object",
        properties: {
          expression: { type: "string" },
          precision: { type: "integer" },
        },
        required: ["expression"],
      }),
    ];

    const result = buildToolDirectory(tools);
    expect(result).toContain("expression* (string)");
    expect(result).toContain("precision (integer)");
  });

  it("returns empty string for empty tools array", () => {
    const result = buildToolDirectory([]);
    expect(result).toBe("");
  });

  it("handles tools without inputSchema", () => {
    const tools: ToolDefinition[] = [
      makeTool("noop", "Does nothing"),
    ];

    const result = buildToolDirectory(tools);
    expect(result).toContain("| noop | Does nothing |  |");
  });
});
