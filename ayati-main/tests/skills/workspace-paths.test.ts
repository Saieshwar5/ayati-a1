import { afterEach, describe, expect, it } from "vitest";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_DIR } from "../../src/config/runtime-config.js";
import {
  ensureWorkspaceRoot,
  requireAbsolutePath,
  resolveWorkspaceMutationPath,
  resolveWorkspaceCwd,
  resolveWorkspacePath,
  resolveWorkspaceRoots,
  workspaceRoot,
} from "../../src/skills/workspace-paths.js";

describe("workspace paths", () => {
  const originalRoot = process.env["AYATI_ROOT_DIR"];

  afterEach(() => {
    if (originalRoot === undefined) delete process.env["AYATI_ROOT_DIR"];
    else process.env["AYATI_ROOT_DIR"] = originalRoot;
  });

  it("keeps the exported default workspace root stable", () => {
    expect(workspaceRoot).toBe(DEFAULT_WORKSPACE_DIR);
  });

  it("derives the user-visible workspace from the single Ayati root", () => {
    process.env["AYATI_ROOT_DIR"] = "/tmp/ayati-custom-root";

    expect(resolveWorkspacePath("notes/report.md"))
      .toBe("/tmp/ayati-custom-root/workspace/notes/report.md");
    expect(resolveWorkspaceCwd("scripts"))
      .toBe("/tmp/ayati-custom-root/workspace/scripts");
    expect(resolveWorkspaceRoots(["docs"]))
      .toEqual(["/tmp/ayati-custom-root/workspace/docs"]);
  });

  it("uses one explicit resource root when the executor supplies it", () => {
    process.env["AYATI_ROOT_DIR"] = "/tmp/ayati-global";
    const resourceRoot = "/tmp/existing-project";

    expect(resolveWorkspacePath("workspace/site/app.js", resourceRoot))
      .toBe("/tmp/existing-project/site/app.js");
    expect(resolveWorkspaceCwd(undefined, resourceRoot)).toBe(resourceRoot);
    expect(resolveWorkspaceRoots(undefined, resourceRoot)).toEqual([resourceRoot]);
    expect(resolveWorkspaceMutationPath("site/app.js", {
      operation: "write_files",
      root: resourceRoot,
    })).toMatchObject({
      ok: true,
      path: "/tmp/existing-project/site/app.js",
      workspaceRoot: resourceRoot,
    });
  });

  it("creates the derived workspace root when resolving tool paths", async () => {
    const root = `/tmp/ayati-missing-root-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = join(root, "workspace");
    await rm(root, { recursive: true, force: true });
    process.env["AYATI_ROOT_DIR"] = root;

    expect(resolveWorkspacePath("notes/report.md")).toBe(join(workspace, "notes", "report.md"));
    await expect(access(workspace)).resolves.toBeUndefined();

    await rm(root, { recursive: true, force: true });
  });

  it("treats workspace aliases as the derived workspace root", () => {
    process.env["AYATI_ROOT_DIR"] = "/tmp/ayati-custom-root";
    const workspace = "/tmp/ayati-custom-root/workspace";

    expect(resolveWorkspacePath("work_space/report.md")).toBe(join(workspace, "report.md"));
    expect(resolveWorkspacePath("workspace/report.md")).toBe(join(workspace, "report.md"));
    expect(resolveWorkspacePath("work_space/workspace/report.md")).toBe(join(workspace, "report.md"));
  });

  it("preserves explicit absolute paths", () => {
    process.env["AYATI_ROOT_DIR"] = "/tmp/ayati-custom-root";
    expect(resolveWorkspacePath("/tmp/explicit/report.md")).toBe("/tmp/explicit/report.md");
  });

  it("requires canonical absolute paths at agent tool boundaries", () => {
    expect(requireAbsolutePath("notes/report.md", "path")).toMatchObject({
      ok: false,
      code: "ABSOLUTE_PATH_REQUIRED",
    });
    expect(requireAbsolutePath("~/report.md", "path")).toMatchObject({
      ok: false,
      code: "ABSOLUTE_PATH_REQUIRED",
    });
    expect(requireAbsolutePath("/tmp/../tmp/report.md", "path")).toEqual({
      ok: true,
      absolutePath: "/tmp/report.md",
    });
  });

  it("rejects external mutation paths unless explicitly allowed", async () => {
    const root = `/tmp/ayati-mutation-root-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspace = join(root, "workspace");
    process.env["AYATI_ROOT_DIR"] = root;
    await ensureWorkspaceRoot(workspace);

    expect(resolveWorkspaceMutationPath("/tmp/explicit/report.md", { operation: "write_files" })).toMatchObject({
      ok: false,
      code: "EXTERNAL_WORKSPACE_PATH_REQUIRES_ALLOW",
      resolvedPath: "/tmp/explicit/report.md",
      workspaceRoot: workspace,
    });
    expect(resolveWorkspaceMutationPath(join(workspace, "inside.txt"), { operation: "write_files" }))
      .toMatchObject({ ok: true, path: join(workspace, "inside.txt"), workspaceRoot: workspace });

    await rm(root, { recursive: true, force: true });
  });

  it("keeps relative traversal attempts inside the workspace root", () => {
    process.env["AYATI_ROOT_DIR"] = "/tmp/ayati-custom-root";
    const workspace = "/tmp/ayati-custom-root/workspace";

    expect(resolveWorkspacePath("../outside.md")).toBe(workspace);
    expect(resolveWorkspacePath(join("docs", "..", "report.md"))).toBe(join(workspace, "report.md"));
  });
});
