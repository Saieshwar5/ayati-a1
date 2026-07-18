import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const systemPromptPath = new URL("../../context/system_prompt.md", import.meta.url);

describe("system prompt contract", () => {
  it("documents only the current decision and context model", async () => {
    const prompt = await readFile(systemPromptPath, "utf8");

    expect(prompt).toContain("assistant text for a terminal user-facing reply");
    expect(prompt).toContain("`context.timeline`");
    expect(prompt).toContain("`context.git`");
    expect(prompt).toContain("`context.run`");
    expect(prompt).toContain("`context.harness`");
    expect(prompt).toContain("`context.tools`");
    expect(prompt).toContain("`context.personal`");
    expect(prompt).toContain("`decision_load_tools`");
    expect(prompt).toContain("`task_completion`");
    expect(prompt).toContain("`ask_user_feedback`");

    expect(prompt).not.toContain("decision_reply");
    expect(prompt).not.toContain("decision_ask_user");
    expect(prompt).not.toContain("context.gitContext");
    expect(prompt).not.toContain("selected work branch");
  });
});
