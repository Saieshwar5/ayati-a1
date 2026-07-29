import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const systemPromptPath = new URL("../../context/system_prompt.md", import.meta.url);

describe("system prompt contract", () => {
  it("keeps the base contract current without duplicating the decision protocol", async () => {
    const prompt = await readFile(systemPromptPath, "utf8");

    expect(prompt).toContain("A direct reply is a valid zero-step unbound");
    expect(prompt).toContain("ask one focused clarification directly");
    expect(prompt).toContain("Do not claim that an");
    expect(prompt).toContain("bounded `State view` described by the current decision protocol");
    expect(prompt).toContain("Dynamic run-scoped harness feedback");
    expect(prompt).toContain("Candidates and summaries never grant ownership");
    expect(prompt).toContain("Before any unbound mutation, enter");
    expect(prompt).toContain("`workstream.route`");
    expect(prompt).toContain("Direct `ENTRY -> resolve` is unavailable");
    expect(prompt).toContain("controls remain hidden until one of those routing tools succeeds");
    expect(prompt).toContain("decision_resolve_create");
    expect(prompt).not.toContain("decision_transition_mode");
    expect(prompt).toContain("observe.locate");
    expect(prompt).toContain("observe.investigate");
    expect(prompt).toContain("decision_stop");
    expect(prompt).toContain("Validation runs no action tools and never repeats a read");
    expect(prompt).toContain("`file.search_no_match`");
    expect(prompt).toContain("observational conclusion");
    expect(prompt).toContain("failed checks");
    expect(prompt).toContain("keep the graph active");
    expect(prompt).toContain("Treat loaded Hot Context, including personal memory, as advisory");
    expect(prompt).toContain("Treat loaded `workstates.recent` as historical handoffs");
    expect(prompt).toContain("`context.core.current.activeDocuments`");
    expect(prompt).toContain("at most five exact navigation");
    expect(prompt).toContain("Treat loaded `files.recent` as older recent-document metadata");
    expect(prompt).toContain("context.hot.available");
    expect(prompt).toContain("context.retrieve");
    expect(prompt).toContain("context_load");
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
