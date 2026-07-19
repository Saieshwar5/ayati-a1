import { describe, expect, it } from "vitest";
import { createAttachmentSkill } from "../../src/skills/builtins/attachments/index.js";
import { createGitContextSkill } from "../../src/skills/builtins/git-context/index.js";
import { createSkillBundle, SkillCatalog } from "../../src/skills/skill-catalog.js";

describe("model-facing skill prompt contract", () => {
  it("uses the workstream/resource and attachment context model", () => {
    const gitContextSkill = createGitContextSkill({ service: {} as never });
    const attachmentSkill = createAttachmentSkill({ sessionAttachmentService: {} as never });
    const activateWorkstream = gitContextSkill.tools.find((tool) => tool.name === "git_context_activate_workstream");
    const catalogPrompt = new SkillCatalog([
      createSkillBundle(gitContextSkill),
    ]).promptBlock();

    expect(gitContextSkill.promptBlock).toContain("workstream context repository contains only Ayati-maintained context");
    expect(gitContextSkill.promptBlock).toContain("Continue the active request only for the same unfinished outcome");
    expect(activateWorkstream?.description).toContain("existing workstream");
    expect(activateWorkstream?.inputSchema?.properties?.["workstreamId"]).toMatchObject({
      pattern: "^W-[0-9]{8}-[0-9]{4}$",
    });
    expect(attachmentSkill.promptBlock).toContain("context.git.current.workstream.resources");
    expect(catalogPrompt).toContain("durable workstreams, linked resources, requests, and recent evidence");

    const allPromptText = [
      gitContextSkill.promptBlock,
      attachmentSkill.promptBlock,
      activateWorkstream?.description,
      catalogPrompt,
    ].join("\n");
    expect(allPromptText).not.toContain("context.gitContext");
    expect(allPromptText).not.toContain("V1 task");
    expect(allPromptText).not.toContain("task branch");
  });
});
