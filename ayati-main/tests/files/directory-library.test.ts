import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DirectoryLibrary } from "../../src/files/directory-library.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-directory-library-"));
}

describe("DirectoryLibrary", () => {
  it("registers a directory manifest with limits, defaults, and run references", async () => {
    const dataDir = makeTmpDir();
    const projectDir = join(dataDir, "project");
    mkdirSync(join(projectDir, "src"), { recursive: true });
    mkdirSync(join(projectDir, "node_modules", "leftpad"), { recursive: true });
    mkdirSync(join(projectDir, "data"), { recursive: true });
    writeFileSync(join(projectDir, "README.md"), "# Project\n", "utf-8");
    writeFileSync(join(projectDir, "src", "index.ts"), "export const name = 'ayati';\n", "utf-8");
    writeFileSync(join(projectDir, "src", "agent.ts"), "export class AyatiAgent {}\n", "utf-8");
    writeFileSync(join(projectDir, "node_modules", "leftpad", "index.ts"), "ignored\n", "utf-8");
    writeFileSync(join(projectDir, "data", "secret.ts"), "ignored\n", "utf-8");

    try {
      const library = new DirectoryLibrary({ dataDir });
      const directory = await library.registerPath({
        path: projectDir,
        runId: "run-1",
        include: ["*.ts"],
        maxDepth: 5,
      });

      expect(directory.directoryId).toMatch(/^dir_[a-f0-9]{16}$/);
      expect(directory.fileCount).toBe(2);
      expect(directory.entries.map((entry) => entry.relativePath)).toEqual(expect.arrayContaining([
        "src",
        "src/agent.ts",
        "src/index.ts",
      ]));
      expect(directory.entries.map((entry) => entry.relativePath)).not.toContain("node_modules/leftpad/index.ts");
      expect(directory.entries.map((entry) => entry.relativePath)).not.toContain("data/secret.ts");
      expect(existsSync(join(dataDir, "directories", directory.directoryId, "metadata.json"))).toBe(true);
      expect(existsSync(join(dataDir, "runs", "run-1", "directories.json"))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("searches attached directory file contents on demand", async () => {
    const dataDir = makeTmpDir();
    const projectDir = join(dataDir, "project");
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(join(projectDir, "src", "agent.ts"), "export class AyatiAgent {}\n", "utf-8");

    try {
      const library = new DirectoryLibrary({ dataDir });
      const directory = await library.registerPath({
        path: projectDir,
        runId: "run-2",
      });

      const result = await library.searchDirectory({
        directoryId: directory.directoryId,
        query: "AyatiAgent",
        searchContents: true,
      });

      expect(result["matchCount"]).toBe(1);
      expect(JSON.stringify(result["matches"])).toContain("src/agent.ts");
      expect(JSON.stringify(result["matches"])).toContain("AyatiAgent");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
