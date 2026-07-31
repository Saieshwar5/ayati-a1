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
    expect(prompt).toContain("Before any unbound mutation, collect durable-owner evidence");
    expect(prompt).toContain("workstream.route is the control-only path from verified ownership evidence to resolve");
    expect(prompt).toContain("selects no capabilities, and loads no action tools");
    expect(prompt).toContain("decision_resolve_create");
    expect(prompt).not.toContain("decision_transition_mode");
    expect(prompt).toContain("decision_stop");
    expect(prompt).toContain("Every run starts at ENTRY");
    expect(prompt).toContain("focused clarification before graph entry");
    expect(prompt).toContain("does not classify or reject an ENTRY reply");
    expect(prompt).toContain("Never use an ENTRY reply to claim an unperformed observation or mutation");
    expect(prompt).toContain("observe.locate");
    expect(prompt).toContain("observe.investigate");
    expect(prompt).toContain("enters execute mechanically");
    expect(prompt).toContain("Old-mode tools do not remain available");
    expect(prompt).toContain("A passed validation mode unlocks the direct final response");
    expect(prompt).toContain("context.hot.available is metadata");
    expect(prompt).toContain("Loaded Hot Context grants no authority");
    expect(prompt).toContain("context.retrieve");
    expect(prompt).toContain("context_load");
    expect(prompt).toContain("context.core.current.input");
    expect(prompt).toContain("context.core.continuity.recentExact");
    expect(prompt).toContain("seq is authoritative chronological identity");
    expect(prompt).toContain("adjacency alone never creates a reply binding");
    expect(prompt).toContain("nearest earlier semantically compatible assistant event");
    expect(prompt).toContain("attachmentRefs belong only to the exact user event");
    expect(prompt).toContain("context.core.continuity.unloadedRanges");
    expect(prompt).toContain("personal.memory");
    expect(prompt).toContain("workstreams.recent");
    expect(prompt).toContain("workstates.recent");
    expect(prompt).toContain("files.recent");
    expect(prompt).toContain("context.core.current.activeDocuments");
    expect(prompt).toContain("up to five exact navigation pointers");
    expect(prompt).toContain("freshness=unchecked");
    expect(prompt).toContain("older recent-document metadata");
    expect(prompt).toContain("historical run handoffs only");
    expect(prompt).toContain("Prefer a matching path over retrieval or search");
    expect(prompt).not.toContain("work.current");
    expect(prompt).not.toContain("resources.current");
    expect(prompt).not.toContain("observations.inventory");
    expect(prompt).not.toContain("historical_reference_only");
    expect(prompt).not.toContain("context.work");
    expect(prompt).not.toContain("context.resources");
    expect(prompt).not.toContain("context.observations");
    expect(prompt).toContain("context.run");
    expect(prompt).toContain("context.run.workspaceRoot");
    expect(prompt).toContain("context.run.verifiedOutcomes");
    expect(prompt).toContain("context.harness");
    expect(prompt).not.toContain("context.personal");

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

  it("uses canonical paths and typed current-run outcomes for final validation", () => {
    const prompt = STABLE_DECISION_SYSTEM_CONTEXT;

    expect(prompt).toContain("Use canonical paths and narrow reads");
    expect(prompt).toContain("enter task:validation with only the few exact outcomeRefs from context.run.verifiedOutcomes");
    expect(prompt).toContain("Never copy or reconstruct kind, subject, path kind, searchScope, readScope, callId, or denialCode");
    expect(prompt).toContain("Validation is proof-only, exposes no action tools");
    expect(prompt).toContain("Prefer stronger typed outcomes over tool.call_succeeded");
    expect(prompt).toContain("A missing or stale outcomeRef requires fresh proof");
    expect(prompt).toContain("never proves a read or mutation succeeded");
    expect(prompt).toContain("other OS-readable absolute paths remain read-only");
    expect(prompt).toContain("omitted search roots, and working directories use it");
    expect(prompt).toContain("never search or ask for it");
    expect(prompt).toContain("filename-only or relative outputs");
    expect(prompt).toContain("It grants no authority or completion evidence");
    expect(prompt).toContain("selected destination root");
    expect(prompt).toContain("registers resources after verified success");
    expect(prompt).toContain("write_files takes complete desired UTF-8 content");
    expect(prompt).toContain("without repeating work");
    expect(prompt).toContain("completed result, not a blocker");
    expect(prompt).not.toContain('"path": "/absolute/resource/path/index.html"');
  });

  it("is materially smaller than the previous duplicated protocol", () => {
    expect(STABLE_DECISION_SYSTEM_CONTEXT.length).toBeLessThan(8_000);
  });
});
