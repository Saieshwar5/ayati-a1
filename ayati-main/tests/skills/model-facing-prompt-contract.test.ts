import { describe, expect, it } from "vitest";
import { createAttachmentSkill } from "../../src/skills/builtins/attachments/index.js";
import { createGitContextSkill } from "../../src/skills/builtins/git-context/index.js";
import { createSkillBundle, SkillCatalog } from "../../src/skills/skill-catalog.js";

describe("model-facing skill prompt contract", () => {
  it("uses the grouped V1 task and attachment context model", () => {
    const gitContextSkill = createGitContextSkill({ service: {} as never });
    const attachmentSkill = createAttachmentSkill({ sessionAttachmentService: {} as never });
    const activateTask = gitContextSkill.tools.find((tool) => tool.name === "git_context_activate_task");
    const catalogPrompt = new SkillCatalog([
      createSkillBundle(gitContextSkill),
    ]).promptBlock();

    expect(gitContextSkill.promptBlock).toContain("independent Git repositories");
    expect(gitContextSkill.promptBlock).toContain("requestDecision=continue");
    expect(activateTask?.description).toContain("V1 task repository");
    expect(activateTask?.inputSchema?.properties?.["taskId"]).toMatchObject({
      pattern: "^T-[0-9]{8}-[0-9]{4}$",
    });
    expect(attachmentSkill.promptBlock).toContain("context.git.current.task.assets");
    expect(catalogPrompt).toContain("V1 task repositories, requests, and recent task evidence");

    const allPromptText = [
      gitContextSkill.promptBlock,
      attachmentSkill.promptBlock,
      activateTask?.description,
      catalogPrompt,
    ].join("\n");
    expect(allPromptText).not.toContain("context.gitContext");
    expect(allPromptText).not.toContain("task branch");
    expect(allPromptText).not.toContain("work branch");
  });
});
