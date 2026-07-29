import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeWorkstreamWorkspaceTargets,
  resolveWorkstreamWorkspaceTargets,
} from "../../src/ivec/workstream-binding/workspace-targets.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("workstream workspace targets", () => {
  it("normalizes typed portable file and directory targets", () => {
    expect(normalizeWorkstreamWorkspaceTargets([
      { kind: "file", relativePath: "balcony-herbs.md" },
      { kind: "directory", relativePath: "garden/notes" },
      { kind: "file", relativePath: "balcony-herbs.md" },
    ])).toEqual([
      { kind: "file", relativePath: "balcony-herbs.md" },
      { kind: "directory", relativePath: "garden/notes" },
    ]);
  });

  it("rejects traversal, absolute paths, and symbolic-link escape", async () => {
    const root = mkdtempSync(join(tmpdir(), "ayati-workspace-targets-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await symlink(outside, join(workspace, "escape"));

    expect(normalizeWorkstreamWorkspaceTargets([
      { kind: "file", relativePath: "../outside.txt" },
      { kind: "file", relativePath: "/tmp/outside.txt" },
    ])).toEqual([]);

    await expect(resolveWorkstreamWorkspaceTargets([
      { kind: "file", relativePath: "escape/outside.txt" },
    ], workspace)).resolves.toMatchObject({
      ok: false,
      invalidTargets: ["escape/outside.txt"],
    });
  });

  it("rejects conflicting file and directory kinds for one target", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ayati-workspace-target-"));
    temporaryDirectories.push(workspace);

    await expect(resolveWorkstreamWorkspaceTargets([
      { kind: "file", relativePath: "garden" },
      { kind: "directory", relativePath: "garden" },
    ], workspace)).resolves.toMatchObject({
      ok: false,
      invalidTargets: ["garden"],
    });
  });
});
