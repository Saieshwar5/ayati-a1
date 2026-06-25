import { afterEach, describe, expect, it } from "vitest";
import { resolvePythonCwd } from "../../src/skills/builtins/python/runtime.js";

describe("python runtime", () => {
  const originalWorkspaceDir = process.env["AYATI_WORKSPACE_DIR"];

  afterEach(() => {
    if (originalWorkspaceDir === undefined) {
      delete process.env["AYATI_WORKSPACE_DIR"];
    } else {
      process.env["AYATI_WORKSPACE_DIR"] = originalWorkspaceDir;
    }
  });

  it("defaults cwd to the configured workspace root when deps do not override it", () => {
    process.env["AYATI_WORKSPACE_DIR"] = "/tmp/ayati-python-workspace";

    expect(resolvePythonCwd({ dataDir: "/tmp/ayati-python-data" })).toBe("/tmp/ayati-python-workspace");
    expect(resolvePythonCwd({ dataDir: "/tmp/ayati-python-data", defaultCwd: "/tmp/custom-cwd" }))
      .toBe("/tmp/custom-cwd");
  });
});
