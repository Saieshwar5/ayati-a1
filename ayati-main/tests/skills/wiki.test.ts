import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyUserProfileContext } from "../../src/context/types.js";
import { UserWikiStore } from "../../src/context/wiki-store.js";
import { createWikiSkill } from "../../src/skills/builtins/wiki/index.js";

describe("wiki skill", () => {
  let tmpDir: string;
  let contextDir: string;
  let historyDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wiki-skill-"));
    contextDir = join(tmpDir, "context");
    historyDir = join(tmpDir, "history");
    await mkdir(contextDir, { recursive: true });
    await mkdir(historyDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("lists, searches, reads, and updates wiki sections", async () => {
    const store = new UserWikiStore({ contextDir, historyDir });
    await store.ensureInitialized(emptyUserProfileContext());
    const onProfileUpdated = vi.fn();
    const skill = createWikiSkill({ wikiStore: store, onProfileUpdated });

    const listTool = skill.tools.find((tool) => tool.name === "wiki_list_sections");
    const searchTool = skill.tools.find((tool) => tool.name === "wiki_search");
    const readTool = skill.tools.find((tool) => tool.name === "wiki_read_section");
    const updateTool = skill.tools.find((tool) => tool.name === "wiki_update");

    expect(listTool).toBeTruthy();
    expect(searchTool).toBeTruthy();
    expect(readTool).toBeTruthy();
    expect(updateTool).toBeTruthy();

    const updateResult = await updateTool!.execute({
      section: "Projects",
      content: "- Ayati\n- Personal OS",
    });
    expect(updateResult.ok).toBe(true);

    const searchResult = await searchTool!.execute({ query: "Ayati" });
    expect(searchResult.ok).toBe(true);
    expect(searchResult.output).toContain("Projects");

    const readResult = await readTool!.execute({ section: "Projects" });
    expect(readResult.ok).toBe(true);
    expect(readResult.output).toContain("Ayati");
    expect(readResult.output).toContain("Personal OS");

    const listResult = await listTool!.execute({});
    expect(listResult.ok).toBe(true);
    expect(listResult.output).toContain("Projects");

    const profileText = await readFile(join(contextDir, "user_profile.json"), "utf-8");
    expect(profileText).toContain('"projects": [');
    expect(profileText).toContain('"Ayati"');
    expect(onProfileUpdated).toHaveBeenCalledOnce();
  });
});
