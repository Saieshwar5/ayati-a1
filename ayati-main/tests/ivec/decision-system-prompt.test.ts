import { describe, expect, it } from "vitest";
import { STABLE_DECISION_SYSTEM_CONTEXT } from "../../src/ivec/agent-runner/decision-system-prompt.js";

describe("stable decision system prompt", () => {
  it("keeps the complete workstream/resource protocol without legacy context or controls", () => {
    const prompt = STABLE_DECISION_SYSTEM_CONTEXT;

    expect(prompt).toContain("Workstream and resource ownership:");
    expect(prompt).toContain("Decision and execution rules:");
    expect(prompt).toContain("Verification and completion:");
    expect(prompt).toContain("User interaction and final replies:");
    expect(prompt).toContain("git_context_activate_workstream");
    expect(prompt).toContain("git_context_create_workstream");
    expect(prompt).toContain("decision_load_tools");
    expect(prompt).toContain("workstream_completion");
    expect(prompt).toContain("ask_user_feedback");

    expect(prompt).not.toContain("decision_reply");
    expect(prompt).not.toContain("decision_ask_user");
    expect(prompt).not.toContain("context.gitContext");
    expect(prompt).not.toContain("State view.progress");
    expect(prompt).not.toContain("selected work branch");
    expect(prompt).not.toMatch(/(?<!decision_)load_tools/);
  });

  it("separates absolute execution paths from portable completion resource paths", () => {
    const prompt = STABLE_DECISION_SYSTEM_CONTEXT;

    expect(prompt).toContain("Filesystem and command paths are canonical absolute host paths");
    expect(prompt).toContain("a portable path relative to that resource");
    expect(prompt).toContain('"path": "index.html"');
    expect(prompt).not.toContain('"path": "/absolute/resource/path/index.html"');
  });

  it("is materially smaller than the previous duplicated protocol", () => {
    expect(STABLE_DECISION_SYSTEM_CONTEXT.length).toBeLessThan(10_000);
  });
});
