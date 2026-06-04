import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DirectoryLibrary } from "../../src/files/directory-library.js";
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

  it("lists and searches attached directories through simplified attachment tools", async () => {
    const dataDir = makeTmpDir();
    const projectDir = join(dataDir, "project");
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(join(projectDir, "src", "agent.ts"), "export class AyatiAgent {}\n", "utf-8");

    try {
      const fileLibrary = new FileLibrary({ dataDir });
      const directoryLibrary = new DirectoryLibrary({ dataDir });
      const directory = await directoryLibrary.registerPath({
        path: projectDir,
        runId: "run-2",
      });
      const skill = createFilesSkill({ fileLibrary, directoryLibrary });
      const listTool = skill.tools.find((tool) => tool.name === "attachment_list");
      const queryTool = skill.tools.find((tool) => tool.name === "attachment_query");
      const directorySearchTool = skill.tools.find((tool) => tool.name === "directory_search");
      expect(listTool).toBeTruthy();
      expect(queryTool).toBeTruthy();
      expect(directorySearchTool).toBeTruthy();

      const listResult = await listTool!.execute({}, { runId: "run-2" });
      expect(listResult.ok).toBe(true);
      expect(JSON.stringify(parseOutput(listResult.output))).toContain(directory.directoryId);

      const queryResult = await queryTool!.execute(
        { attachmentId: directory.directoryId, query: "AyatiAgent", searchContents: true },
        { runId: "run-2" },
      );
      expect(queryResult.ok).toBe(true);
      expect(JSON.stringify(parseOutput(queryResult.output))).toContain("src/agent.ts");

      const searchResult = await directorySearchTool!.execute(
        { query: "agent.ts" },
        { runId: "run-2" },
      );
      expect(searchResult.ok).toBe(true);
      expect(JSON.stringify(parseOutput(searchResult.output))).toContain("src/agent.ts");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
