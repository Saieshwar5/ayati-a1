import { describe, it, expect } from "vitest";
import filesystemSkill from "../../../src/skills/builtins/filesystem/index.js";

describe("filesystemSkill", () => {
  it("has correct id and version", () => {
    expect(filesystemSkill.id).toBe("filesystem");
    expect(filesystemSkill.version).toBe("1.0.0");
  });

  it("has a non-empty prompt block", () => {
    expect(filesystemSkill.promptBlock.length).toBeGreaterThan(0);
    expect(filesystemSkill.promptBlock).toContain("Filesystem tools are built in.");
  });

  it("exports the reliable filesystem tools", () => {
    expect(filesystemSkill.tools).toHaveLength(10);

    const names = filesystemSkill.tools.map((t) => t.name);
    expect(names).toContain("inspect_paths");
    expect(names).toContain("read_files");
    expect(names).not.toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).toContain("write_files");
    expect(names).toContain("patch_files");
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
