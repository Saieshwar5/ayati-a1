import { afterEach, describe, expect, it } from "vitest";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_DIR } from "../../src/config/runtime-config.js";
import {
  ensureWorkspaceRoot,
  resolveWorkspaceMutationPath,
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

  it("creates the configured workspace root when resolving tool paths", async () => {
    const root = `/tmp/ayati-missing-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await rm(root, { recursive: true, force: true });
    process.env["AYATI_WORKSPACE_DIR"] = root;

    expect(resolveWorkspacePath("notes/report.md")).toBe(join(root, "notes", "report.md"));
    await expect(access(root)).resolves.toBeUndefined();

    await rm(root, { recursive: true, force: true });
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

  it("rejects external mutation paths unless explicitly allowed", async () => {
    const root = `/tmp/ayati-mutation-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    process.env["AYATI_WORKSPACE_DIR"] = root;
    await ensureWorkspaceRoot(root);

    expect(resolveWorkspaceMutationPath("/tmp/explicit/report.md", { operation: "write_file" })).toMatchObject({
      ok: false,
      code: "EXTERNAL_WORKSPACE_PATH_REQUIRES_ALLOW",
      resolvedPath: "/tmp/explicit/report.md",
      workspaceRoot: root,
    });
    expect(resolveWorkspaceMutationPath("/tmp/explicit/report.md", {
      allowExternalPath: true,
      operation: "write_file",
    })).toMatchObject({
      ok: true,
      path: "/tmp/explicit/report.md",
      workspaceRoot: root,
    });
    expect(resolveWorkspaceMutationPath(join(root, "inside.txt"), { operation: "write_file" })).toMatchObject({
      ok: true,
      path: join(root, "inside.txt"),
      workspaceRoot: root,
    });

    await rm(root, { recursive: true, force: true });
  });

  it("keeps relative traversal attempts inside the workspace root", () => {
    process.env["AYATI_WORKSPACE_DIR"] = "/tmp/ayati-custom-workspace";

    expect(resolveWorkspacePath("../outside.md")).toBe("/tmp/ayati-custom-workspace");
    expect(resolveWorkspacePath(join("docs", "..", "report.md"))).toBe("/tmp/ayati-custom-workspace/report.md");
  });
});
