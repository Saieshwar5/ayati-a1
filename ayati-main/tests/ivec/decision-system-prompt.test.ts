import { describe, expect, it } from "vitest";
import { STABLE_DECISION_SYSTEM_CONTEXT } from "../../src/ivec/agent-runner/decision-system-prompt.js";

describe("stable decision system prompt", () => {
  it("keeps the virtual navigation and context contract without legacy controls", () => {
    const prompt = STABLE_DECISION_SYSTEM_CONTEXT;

    expect(prompt).toContain("Context contract:");
    expect(prompt).toContain("Navigation:");
    expect(prompt).toContain("Decision and execution:");
    expect(prompt).toContain("Validation and terminal responses:");
    expect(prompt).not.toContain("workstream_resolve");
    expect(prompt).toContain("decision_transition_mode");
    expect(prompt).toContain("decision_validate");
    expect(prompt).toContain("Every run starts at ENTRY");
    expect(prompt).toContain("genuinely tool-free request");
    expect(prompt).toContain("observe.locate");
    expect(prompt).toContain("observe.investigate");
    expect(prompt).toContain("enters execute mechanically");
    expect(prompt).toContain("Old-mode tools do not remain available");
    expect(prompt).toContain("Accepted validation finalizes that response without another model call");
    expect(prompt).toContain("Apply context.personal only when relevant");
    expect(prompt).toContain("context.temporal.recent");
    expect(prompt).toContain("context.current");
    expect(prompt).toContain("context.stream");
    expect(prompt).toContain("context.work");
    expect(prompt).toContain("context.resources");
    expect(prompt).toContain("context.observations");
    expect(prompt).toContain("context.run");
    expect(prompt).toContain("context.harness");
    expect(prompt).toContain("context.personal");

    expect(prompt).not.toContain("decision_load_tools");
    expect(prompt).not.toContain("workstream_completion");
    expect(prompt).not.toContain("ask_user_feedback");
    expect(prompt).not.toContain("decision_reply");
    expect(prompt).not.toContain("decision_ask_user");
    expect(prompt).not.toContain("context.timeline");
    expect(prompt).not.toContain("context.git");
    expect(prompt).not.toContain("context.gitContext");
    expect(prompt).not.toContain("State view.progress");
    expect(prompt).not.toContain("selected work branch");
    expect(prompt).not.toContain("git_context_activate_workstream");
    expect(prompt).not.toContain("git_context_create_workstream");
    expect(prompt).not.toContain("load_tools");
  });

  it("separates absolute execution paths from portable completion resource paths", () => {
    const prompt = STABLE_DECISION_SYSTEM_CONTEXT;

    expect(prompt).toContain("Filesystem and command paths are canonical absolute host paths");
    expect(prompt).toContain("a portable path relative to that resource");
    expect(prompt).not.toContain('"path": "/absolute/resource/path/index.html"');
  });

  it("is materially smaller than the previous duplicated protocol", () => {
    expect(STABLE_DECISION_SYSTEM_CONTEXT.length).toBeLessThan(8_000);
  });
});
