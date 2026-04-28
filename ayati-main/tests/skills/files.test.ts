import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileLibrary } from "../../src/files/file-library.js";
import { createFilesSkill } from "../../src/skills/builtins/files/index.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-files-skill-"));
}

function parseOutput(output: string | undefined): Record<string, unknown> {
  expect(output).toBeTruthy();
  return JSON.parse(output ?? "{}") as Record<string, unknown>;
}

describe("files built-in skill", () => {
  it("auto-selects the only run file for text queries", async () => {
    const dataDir = makeTmpDir();
    try {
      const library = new FileLibrary({ dataDir });
      await library.registerUpload({
        originalName: "policy.txt",
        bytes: Buffer.from("Termination requires thirty days written notice."),
        mimeType: "text/plain",
        origin: "user_upload",
        runId: "run-1",
      });
      const skill = createFilesSkill({ fileLibrary: library });
      const queryTool = skill.tools.find((tool) => tool.name === "file_query");
      expect(queryTool).toBeTruthy();

      const result = await queryTool!.execute({ query: "termination notice" }, { runId: "run-1" });
      expect(result.ok).toBe(true);
      expect(JSON.stringify(parseOutput(result.output))).toContain("thirty days");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
