import { describe, expect, it } from "vitest";
import { createGitContextSkill } from "../../src/skills/builtins/git-context/index.js";
import { CapabilityCatalog } from "../../src/ivec/agent-runner/capabilities/catalog.js";

describe("model-facing capability contract", () => {
  it("uses explicit workstream/resource capabilities without static skill prompts", () => {
    const gitContextSkill = createGitContextSkill({ service: {} as never });
    const activateWorkstream = gitContextSkill.tools.find((tool) => tool.name === "git_context_activate_workstream");
    const capabilityCatalog = new CapabilityCatalog();

    expect(activateWorkstream?.description).toContain("existing workstream");
    expect(activateWorkstream?.inputSchema?.properties?.["workstreamId"]).toMatchObject({
      pattern: "^W-[0-9]{8}-[0-9]{4}$",
    });
    expect(capabilityCatalog.get("attachment:read")?.coreTools).toContain("attachment_read");
    expect(capabilityCatalog.get("history:read")?.coreTools).toEqual([
      "agent_history_search",
      "agent_conversation_read",
      "agent_history_read",
    ]);
    expect(capabilityCatalog.list().flatMap((capability) => capability.coreTools)).not.toContain(
      "git_context_activate_workstream",
    );

    const allPromptText = [
      ...capabilityCatalog.list().flatMap((capability) => [
        capability.summary,
        capability.whenToUse,
      ]),
      activateWorkstream?.description,
    ].join("\n");
    expect(allPromptText).not.toContain("context.gitContext");
    expect(allPromptText).not.toContain("context.git.current");
    expect(allPromptText).not.toContain("V1 task");
    expect(allPromptText).not.toContain("task branch");
  });
});
