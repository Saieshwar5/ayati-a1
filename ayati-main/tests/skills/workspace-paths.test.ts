import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_DIR } from "../../src/config/runtime-config.js";
import {
  resolveWorkspaceCwd,
  resolveWorkspacePath,
  resolveWorkspaceRoots,
  workspaceRoot,
} from "../../src/skills/workspace-paths.js";

describe("workspace paths", () => {
  const originalWorkspaceDir = process.env["AYATI_WORKSPACE_DIR"];

  afterEach(() => {
    if (originalWorkspaceDir === undefined) {
      delete process.env["AYATI_WORKSPACE_DIR"];
    } else {
      process.env["AYATI_WORKSPACE_DIR"] = originalWorkspaceDir;
    }
  });

  it("keeps the exported default workspace root stable", () => {
    expect(workspaceRoot).toBe(DEFAULT_WORKSPACE_DIR);
  });

  it("resolves omitted cwd and roots to the default workspace root", () => {
    delete process.env["AYATI_WORKSPACE_DIR"];

    expect(resolveWorkspaceCwd()).toBe(DEFAULT_WORKSPACE_DIR);
    expect(resolveWorkspaceCwd("")).toBe(DEFAULT_WORKSPACE_DIR);
    expect(resolveWorkspaceCwd(".")).toBe(DEFAULT_WORKSPACE_DIR);
    expect(resolveWorkspaceRoots()).toEqual([DEFAULT_WORKSPACE_DIR]);
  });

  it("resolves relative paths inside the configured workspace root", () => {
    process.env["AYATI_WORKSPACE_DIR"] = "/tmp/ayati-custom-workspace";

    expect(resolveWorkspacePath("notes/report.md")).toBe("/tmp/ayati-custom-workspace/notes/report.md");
    expect(resolveWorkspaceCwd("scripts")).toBe("/tmp/ayati-custom-workspace/scripts");
    expect(resolveWorkspaceRoots(["docs"])).toEqual(["/tmp/ayati-custom-workspace/docs"]);
  });

  it("treats workspace aliases as the configured workspace root, not nested folders", () => {
    process.env["AYATI_WORKSPACE_DIR"] = "/tmp/ayati-custom-workspace";

    expect(resolveWorkspacePath("work_space/report.md")).toBe("/tmp/ayati-custom-workspace/report.md");
    expect(resolveWorkspacePath("workspace/report.md")).toBe("/tmp/ayati-custom-workspace/report.md");
    expect(resolveWorkspacePath("ayati-custom-workspace/report.md")).toBe("/tmp/ayati-custom-workspace/report.md");
    expect(resolveWorkspacePath("work_space/workspace/report.md")).toBe("/tmp/ayati-custom-workspace/report.md");
  });

  it("preserves explicit absolute paths", () => {
    process.env["AYATI_WORKSPACE_DIR"] = "/tmp/ayati-custom-workspace";

    expect(resolveWorkspacePath("/tmp/explicit/report.md")).toBe("/tmp/explicit/report.md");
  });

  it("keeps relative traversal attempts inside the workspace root", () => {
    process.env["AYATI_WORKSPACE_DIR"] = "/tmp/ayati-custom-workspace";

    expect(resolveWorkspacePath("../outside.md")).toBe("/tmp/ayati-custom-workspace");
    expect(resolveWorkspacePath(join("docs", "..", "report.md"))).toBe("/tmp/ayati-custom-workspace/report.md");
  });
});
