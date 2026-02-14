import { describe, it, expect } from "vitest";
import filesystemSkill from "../../../src/skills/builtins/filesystem/index.js";

describe("filesystemSkill", () => {
  it("has correct id and version", () => {
    expect(filesystemSkill.id).toBe("filesystem");
    expect(filesystemSkill.version).toBe("1.0.0");
  });

  it("has a non-empty prompt block", () => {
    expect(filesystemSkill.promptBlock.length).toBeGreaterThan(0);
    expect(filesystemSkill.promptBlock).toContain("Filesystem Skill");
  });

  it("exports all 9 tools", () => {
    expect(filesystemSkill.tools).toHaveLength(9);

    const names = filesystemSkill.tools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("delete");
    expect(names).toContain("list_directory");
    expect(names).toContain("create_directory");
    expect(names).toContain("move");
    expect(names).toContain("find_files");
    expect(names).toContain("search_in_files");
  });

  it("all tools have input schemas", () => {
    for (const tool of filesystemSkill.tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.execute).toBeTypeOf("function");
    }
  });
});
