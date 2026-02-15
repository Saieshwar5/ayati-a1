import { describe, expect, it } from "vitest";
import { selectTools } from "../../../src/ivec/tool-selection/selector.js";
import type { SelectableTool } from "../../../src/ivec/tool-selection/selector-types.js";

function makeTool(
  name: string,
  description: string,
  hints?: { tags?: string[]; aliases?: string[]; examples?: string[]; priority?: number },
): SelectableTool {
  return {
    schema: {
      name,
      description,
      inputSchema: { type: "object", properties: {} },
    },
    hints,
  };
}

describe("selectTools", () => {
  it("selects top tools by lexical relevance", () => {
    const tools: SelectableTool[] = [
      makeTool("shell", "Run shell commands"),
      makeTool("read_file", "Read file contents"),
      makeTool("calculator", "Evaluate math expressions"),
    ];

    const result = selectTools({
      query: "run command in shell",
      tools,
      topK: 2,
    });

    const names = result.selected.map((tool) => tool.schema.name);
    expect(names).toContain("shell");
    expect(names).toHaveLength(2);
  });

  it("honors alwaysInclude even when score is low", () => {
    const tools: SelectableTool[] = [
      makeTool("calculator", "Evaluate math expressions"),
      makeTool("context_recall_agent", "Search previous sessions"),
    ];

    const result = selectTools({
      query: "simple math",
      tools,
      topK: 1,
      alwaysInclude: ["context_recall_agent"],
    });

    const names = result.selected.map((tool) => tool.schema.name);
    expect(names).toContain("calculator");
    expect(names).toContain("context_recall_agent");
  });

  it("uses hint tokens to improve ranking", () => {
    const tools: SelectableTool[] = [
      makeTool("filesystem_read", "Read bytes", { aliases: ["cat_file"], tags: ["filesystem"] }),
      makeTool("calculator", "Compute math"),
    ];

    const result = selectTools({
      query: "cat file from filesystem",
      tools,
      topK: 1,
    });

    expect(result.selected[0]?.schema.name).toBe("filesystem_read");
  });
});
