import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const systemPromptPath = new URL("../../context/system_prompt.md", import.meta.url);

describe("system prompt contract", () => {
  it("keeps the base contract current without duplicating the decision protocol", async () => {
    const prompt = await readFile(systemPromptPath, "utf8");

    expect(prompt).toContain("A direct reply is a valid zero-step unbound");
    expect(prompt).toContain("bounded `State view` described by the current decision protocol");
    expect(prompt).toContain("Dynamic run-scoped harness feedback");
    expect(prompt).toContain("Candidates and summaries never grant ownership");
    expect(prompt).toContain("decision_transition_mode");
    expect(prompt).toContain("observe.locate");
    expect(prompt).toContain("observe.investigate");
    expect(prompt).toContain("decision_validate");
    expect(prompt).toContain("Rejected validation keeps the current mode");
    expect(prompt).toContain("Treat personal memory as advisory");
    expect(prompt).toContain("generic follow-up question or invitation");

    expect(prompt).not.toContain("`context.timeline`");
    expect(prompt).not.toContain("`context.git`");
    expect(prompt).not.toContain("decision_reply");
    expect(prompt).not.toContain("decision_ask_user");
    expect(prompt).not.toContain("decision_load_tools");
    expect(prompt).not.toContain("workstream_completion");
    expect(prompt).not.toContain("ask_user_feedback");
    expect(prompt).not.toContain("context.gitContext");
    expect(prompt).not.toContain("context.run.status");
    expect(prompt).not.toContain("selected work branch");
  });
});
