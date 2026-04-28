import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../src/prompt/builder.js";
import { emptySoulContext } from "../../src/context/types.js";

describe("buildSystemPrompt", () => {
  it("assembles deterministic section order and metadata", () => {
    const soul = emptySoulContext();
    soul.identity.name = "CustomName";
    soul.identity.role = "General-purpose autonomous AI teammate";
    soul.identity.responsibility = "Help the user complete useful work.";
    soul.behavior.communication = ["Warm and direct"];

    const output = buildSystemPrompt({
      basePrompt: "Base rules",
      soul,
      runtimeContext: {
        nowUtc: "2026-04-24T10:15:30.000Z",
        timezone: "Asia/Kolkata",
        localDate: "2026-04-24",
        localTime: "15:45:30",
        weekday: "friday",
      },
      conversationTurns: [
        { role: "user", content: "A", timestamp: "t1", sessionPath: "s/p" },
        { role: "assistant", content: "B", timestamp: "t2", sessionPath: "s/p", assistantResponseKind: "reply" },
      ],
      previousSessionSummary: "Session summary",
      activeSessionPath: "sessions/s-123.md",
      recentTaskSummaries: [
        {
          timestamp: "2026-02-16T00:00:00.000Z",
          runId: "run-1",
          runPath: "data/runs/run-1",
          runStatus: "completed",
          taskStatus: "done",
          objective: "Finish the task",
          summary: "Finished task successfully",
          completedMilestones: [],
          openWork: [],
          blockers: [],
          keyFacts: [],
          evidence: [],
          attachmentNames: [],
        },
      ],
      skillBlocks: [{ id: "skill-1", content: "Do X" }],
    });

    expect(output.systemPrompt).toMatch(/^# Base System Prompt/);
    const soulPos = output.systemPrompt.indexOf("# Soul");
    const runtimeContextPos = output.systemPrompt.indexOf("# Runtime Context");
    const conversationPos = output.systemPrompt.indexOf("# Previous Conversation");
    const memoryPos = output.systemPrompt.indexOf("# Memory");
    const currentSessionPos = output.systemPrompt.indexOf("# Current Session");
    const recentTasksPos = output.systemPrompt.indexOf("# Recent Tasks");
    const skillsPos = output.systemPrompt.indexOf("# Skills");

    expect(soulPos).toBeGreaterThan(0);
    expect(runtimeContextPos).toBeGreaterThan(soulPos);
    expect(conversationPos).toBeGreaterThan(runtimeContextPos);
    expect(memoryPos).toBeGreaterThan(conversationPos);
    expect(currentSessionPos).toBeGreaterThan(memoryPos);
    expect(recentTasksPos).toBeGreaterThan(currentSessionPos);
    expect(skillsPos).toBeGreaterThan(recentTasksPos);
    expect(output.systemPrompt).toContain("[t1]");
    expect(output.systemPrompt).toContain("[t2]");
    expect(output.systemPrompt).toContain("assistant[reply]: B");
    expect(output.systemPrompt).toContain("Name: CustomName");
    expect(output.systemPrompt).toContain("Role: General-purpose autonomous AI teammate");
    expect(output.systemPrompt).toContain("Responsibility: Help the user complete useful work.");
    expect(output.systemPrompt).toContain("## Communication");
    expect(output.systemPrompt).toContain("- local_date: 2026-04-24");
    expect(output.systemPrompt).toContain("- weekday: friday");
    expect(output.systemPrompt).toContain("Session summary");
    expect(output.systemPrompt).toContain("session_path: sessions/s-123.md");
    expect(output.systemPrompt).toContain("objective=Finish the task");
    expect(output.systemPrompt).toContain("task_status=done");

    expect(output.sections.map((s) => s.id)).toEqual([
      "base",
      "soul",
      "runtime_context",
      "personal_memory",
      "conversation",
      "memory",
      "current_session",
      "recent_tasks",
      "system_activity",
      "skills",
      "tools",
      "session_status",
    ]);
    const emptyOptionalIds = new Set(["personal_memory", "system_activity", "tools", "session_status"]);
    const includedSections = output.sections.filter((s) => !emptyOptionalIds.has(s.id));
    expect(includedSections.every((s) => s.included)).toBe(true);
    const activitySection = output.sections.find((s) => s.id === "system_activity");
    expect(activitySection?.included).toBe(false);
    const toolsSection = output.sections.find((s) => s.id === "tools");
    expect(toolsSection?.included).toBe(false);
    const statusSection = output.sections.find((s) => s.id === "session_status");
    expect(statusSection?.included).toBe(false);
  });

  it("memory section renders previous session summary only", () => {
    const output = buildSystemPrompt({
      basePrompt: "Base rules",
      soul: emptySoulContext(),
      previousSessionSummary: "Last session: completed auth migration.",
    });

    expect(output.systemPrompt).toContain("## Previous Session Summary");
    expect(output.systemPrompt).toContain("Last session: completed auth migration.");
    expect(output.systemPrompt).not.toContain("## Reasoning History");
    expect(output.systemPrompt).not.toContain("## Tool History");
    expect(output.systemPrompt).not.toContain("## Recalled Context Evidence");
  });

  it("marks empty layers as not included", () => {
    const output = buildSystemPrompt({
      basePrompt: "Base rules",
      soul: emptySoulContext(),
      conversationTurns: [],
      previousSessionSummary: "",
      skillBlocks: [],
    });

    const conversation = output.sections.find((s) => s.id === "conversation");
    const memory = output.sections.find((s) => s.id === "memory");
    const skills = output.sections.find((s) => s.id === "skills");

    expect(conversation?.included).toBe(false);
    expect(memory?.included).toBe(false);
    expect(skills?.included).toBe(false);
  });

  it("renders recent system activity when present", () => {
    const output = buildSystemPrompt({
      basePrompt: "Base rules",
      soul: emptySoulContext(),
      recentSystemActivity: [
        {
          timestamp: "2026-02-16T00:01:00.000Z",
          source: "pulse",
          event: "reminder_due",
          eventId: "evt-2",
          summary: "Checked memory usage",
          responseKind: "notification",
          userVisible: true,
        },
      ],
    });

    expect(output.systemPrompt).toContain("# Recent System Activity");
    expect(output.systemPrompt).toContain("Checked memory usage");
    expect(output.sections.find((s) => s.id === "system_activity")?.included).toBe(true);
  });
});
