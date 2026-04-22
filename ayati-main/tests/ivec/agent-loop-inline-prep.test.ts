import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentLoop } from "../../src/ivec/agent-loop.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { SessionMemory } from "../../src/memory/types.js";
import type { ToolDefinition } from "../../src/skills/types.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import { createSkillBrokerSkill } from "../../src/skills/builtins/skill-broker/index.js";
import { createExternalSkillBroker } from "../../src/skills/external/broker.js";
import { ExternalSkillRegistry } from "../../src/skills/external/registry.js";

function goalContract(objective: string): Record<string, unknown> {
  return {
    objective,
    done_when: [`${objective} is complete`],
    required_evidence: [],
    ask_user_when: [],
    stop_when_no_progress: [],
  };
}

function createMockSessionMemory(): SessionMemory {
  return {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    beginRun: vi.fn().mockReturnValue({ sessionId: "s1", runId: "r1" }),
    recordToolCall: vi.fn(),
    recordToolResult: vi.fn(),
    recordAssistantFinal: vi.fn(),
    recordRunFailure: vi.fn(),
    recordAgentStep: vi.fn(),
    recordRunLedger: vi.fn(),
    recordTaskSummary: vi.fn(),
    recordAssistantNotification: vi.fn(),
    getPromptMemoryContext: vi.fn().mockReturnValue({
      conversationTurns: [{ role: "user", content: "hello", timestamp: "", sessionPath: "" }],
      previousSessionSummary: "",
      recentRunLedgers: [],
      recentSystemActivity: [],
    }),
    setStaticTokenBudget: vi.fn(),
  };
}

function stepVerifySuccessResponse(summary = "step verified successfully"): string {
  return JSON.stringify({
    passed: true,
    summary,
    evidenceSummary: summary,
    evidenceItems: [summary],
    newFacts: [],
    artifacts: [],
  });
}

function taskVerifyResponse(status = "done", progressSummary = "work is complete"): string {
  return JSON.stringify({
    status,
    progressSummary,
    evidence: [progressSummary],
    keyFacts: [],
  });
}

const sendEmailTool: ToolDefinition = {
  name: "send_email",
  description: "Send an email draft",
  inputSchema: {
    type: "object",
    required: ["to"],
    properties: {
      to: { type: "string" },
      subject: { type: "string" },
    },
  },
  execute: vi.fn().mockResolvedValue({ ok: true, output: "Draft sent." }),
};

describe("agentLoop inline prep directives", () => {
  it("retries direct after read_run_state and re-calls direct with retrieved context", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-inline-read-run-state-"));
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput): Promise<LlmTurnOutput> => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("finish the email task"),
                approach: "inspect prior run context before executing the next step",
                session_context_summary: "",
                dependent_task: false,
              }),
            };
          }

          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                kind: "read_run_state",
                payload: {
                  done: false,
                  read_run_state: true,
                  action: "read_summary_window",
                  window: { from: 1, to: 3 },
                  reason: "Need older run context before sending",
                },
              }),
            };
          }

          if (callCount === 3) {
            const prompt = input.messages.find((message) => message.role === "user")?.content;
            expect(typeof prompt === "string" ? prompt : "").toContain("Retrieved run state:");
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                execution_contract: "Send the email after reviewing prior run state",
                tool_plan: [
                  {
                    tool: "send_email",
                    input: { to: "demo@example.com", subject: "Follow-up" },
                    origin: "builtin",
                    source_refs: [],
                    retry_policy: "none",
                  },
                ],
                success_criteria: "The email draft is sent",
                context: "Use the retrieved run-state context to proceed safely.",
              }),
            };
          }

          if (callCount === 4) {
            return { type: "assistant", content: stepVerifySuccessResponse("Step succeeded after using read_run_state") };
          }

          if (callCount === 5) {
            return { type: "assistant", content: taskVerifyResponse("done", "The email task is complete") };
          }

          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Finished after reading the relevant run-state context.",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([sendEmailTool]),
        toolDefinitions: [sendEmailTool],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
      });

      expect(result.status).toBe("completed");
      expect(result.content).toContain("reading the relevant run-state context");
      expect(provider.generateTurn).toHaveBeenCalledTimes(6);
      const logLines = consoleSpy.mock.calls.map((call) => call.map(String).join(" "));
      expect(logLines.some((line) =>
        line.includes("[controller] direct -> read_run_state action=read_summary_window window=1..3"),
      )).toBe(true);
      expect(logLines.some((line) =>
        line.includes("[controller] direct prep appended read_run_state request=read_summary_window:1:3"),
      )).toBe(true);
      expect(logLines.some((line) =>
        line.includes("[controller] direct -> step execution_mode=dependent tools=send_email"),
      )).toBe(true);
    } finally {
      consoleSpy.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("activates an external skill inline, then uses the mounted external tool in the same iteration", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-inline-skill-activate-"));
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const skillsDir = join(dataDir, "skills");
    const secretsPath = join(dataDir, "skill-secrets.json");
    const policyPath = join(dataDir, "skill-policy.json");
    const skillDir = join(skillsDir, "demo-search");
    const toolsDir = join(skillDir, "tools");

    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(secretsPath, JSON.stringify({}, null, 2));
    writeFileSync(policyPath, JSON.stringify({
      defaultMode: "allow",
      capabilities: {},
    }, null, 2));
    writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
      id: "demo-search",
      version: "1.0.0",
      title: "Demo Search",
      description: "Demo external search skill",
      status: "active",
      card: {
        summary: "Search public information.",
        whenToUse: "Use for current public facts.",
      },
      activation: {
        brief: "Activate demo-search to mount its query tool for this run.",
        workflow: ["Activate the skill, then call demo-search.query."],
        rules: ["Use this skill for public lookup only."],
      },
      toolFiles: ["tools/query.json"],
    }, null, 2));
    writeFileSync(join(toolsDir, "query.json"), JSON.stringify({
      id: "query",
      description: "Run a demo search query",
      execution: {
        backend: "shell",
        command: "node",
        argsTemplate: ["-e", "console.log('demo-search-ok')"],
        outputMode: "text",
      },
    }, null, 2));

    const externalSkillRegistry = new ExternalSkillRegistry({
      roots: [{ skillsDir, source: "project" }],
      secretMappingPath: secretsPath,
      policyPath,
    });
    await externalSkillRegistry.initialize();
    const toolExecutor = createToolExecutor([]);
    const externalSkillBroker = createExternalSkillBroker({
      roots: [{ skillsDir, source: "project" }],
      cachePath: join(dataDir, "catalog.json"),
      secretMappingPath: secretsPath,
      policyPath,
      toolExecutor,
    });
    await externalSkillBroker.initialize();
    const skillBrokerSkill = createSkillBrokerSkill(externalSkillBroker);
    toolExecutor.mount?.("static:skill-broker", skillBrokerSkill.tools, {
      scope: "static",
      description: skillBrokerSkill.description,
    });

    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput): Promise<LlmTurnOutput> => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("find current public info"),
                approach: "activate the external search skill before running its query tool",
                session_context_summary: "",
                dependent_task: false,
              }),
            };
          }

          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                kind: "activate_skill",
                payload: {
                  done: false,
                  activate_skill: true,
                  skill_id: "demo-search",
                  reason: "Need the demo external query tool before the next step",
                },
              }),
            };
          }

          if (callCount === 3) {
            const prompt = input.messages.find((message) => message.role === "user")?.content;
            expect(typeof prompt === "string" ? prompt : "").toContain("Retrieved skill activation:");
            expect(typeof prompt === "string" ? prompt : "").toContain("- status: activated");
            expect(typeof prompt === "string" ? prompt : "").toContain("- mounted_tools: demo-search.query");
            expect(typeof prompt === "string" ? prompt : "").toContain("Available tools");
            expect(typeof prompt === "string" ? prompt : "").toContain("Active external skills:");
            expect(typeof prompt === "string" ? prompt : "").toContain("demo-search");
            expect(typeof prompt === "string" ? prompt : "").toContain("demo-search.query");
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                execution_mode: "dependent",
                execution_contract: "Run the demo external search query",
                tool_plan: [
                  {
                    tool: "demo-search.query",
                    input: {},
                    origin: "external_tool",
                    source_refs: [],
                    retry_policy: "none",
                  },
                ],
                success_criteria: "The demo external query runs successfully",
                context: "Use the selected external tool after skill inspection.",
              }),
            };
          }

          if (callCount === 4) {
            return { type: "assistant", content: stepVerifySuccessResponse("The external search tool ran successfully") };
          }

          if (callCount === 5) {
            return { type: "assistant", content: taskVerifyResponse("done", "The external skill task is complete") };
          }

          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "Finished after reading skill details and running the external tool.",
              status: "completed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: skillBrokerSkill.tools,
        externalSkillBroker,
        externalSkillRegistry,
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
      });

      expect(result.status).toBe("completed");
      expect(result.content).toContain("external tool");
      expect((provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(6);
      const logLines = consoleSpy.mock.calls.map((call) => call.map(String).join(" "));
      expect(logLines.some((line) =>
        line.includes("[controller] direct -> activate_skill skill_id=demo-search"),
      )).toBe(true);
      expect(logLines.some((line) =>
        line.includes("[controller] direct prep appended activate_skill request=demo-search status=activated"),
      )).toBe(true);
      expect(logLines.some((line) =>
        line.includes("[controller] direct -> step execution_mode=dependent tools=demo-search.query"),
      )).toBe(true);
    } finally {
      consoleSpy.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("passes activation failures back to direct as inline prep context", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-inline-activate-skill-failure-"));

    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput): Promise<LlmTurnOutput> => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("use a missing external skill"),
                approach: "try to activate the missing external skill first",
                session_context_summary: "",
                dependent_task: false,
              }),
            };
          }

          if (callCount === 2) {
            return {
              type: "assistant",
              content: JSON.stringify({
                kind: "activate_skill",
                payload: {
                  done: false,
                  activate_skill: true,
                  skill_id: "missing-skill",
                  reason: "Need an unavailable external capability",
                },
              }),
            };
          }

          const prompt = input.messages.find((message) => message.role === "user")?.content;
          expect(typeof prompt === "string" ? prompt : "").toContain("Retrieved skill activation:");
          expect(typeof prompt === "string" ? prompt : "").toContain("- status: failed");
          expect(typeof prompt === "string" ? prompt : "").toContain("External skill activation is unavailable in this run.");
          return {
            type: "assistant",
            content: JSON.stringify({
              done: true,
              summary: "External skill activation is unavailable in this run.",
              status: "failed",
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([sendEmailTool]),
        toolDefinitions: [sendEmailTool],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
      });

      expect(result.status).toBe("failed");
      expect(result.content).toContain("External skill activation is unavailable");
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fails when direct repeats the same activate_skill request in one resolution", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ayati-inline-activate-skill-repeat-"));
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (): Promise<LlmTurnOutput> => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "assistant",
              content: JSON.stringify({
                done: false,
                understand: true,
                goal: goalContract("retry the same missing skill"),
                approach: "keep asking for the same missing skill",
                session_context_summary: "",
                dependent_task: false,
              }),
            };
          }

          return {
            type: "assistant",
            content: JSON.stringify({
              kind: "activate_skill",
              payload: {
                done: false,
                activate_skill: true,
                skill_id: "missing-skill",
                reason: "Need the same missing skill again",
              },
            }),
          };
        }),
      };

      const result = await agentLoop({
        provider,
        toolExecutor: createToolExecutor([sendEmailTool]),
        toolDefinitions: [sendEmailTool],
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        dataDir,
      });

      expect(result.status).toBe("failed");
      expect(result.content).toContain("repeated the same activate_skill request");
      const logLines = consoleSpy.mock.calls.map((call) => call.map(String).join(" "));
      expect(logLines.some((line) =>
        line.includes("[controller] direct repeated prep directive activate_skill request=missing-skill"),
      )).toBe(true);
    } finally {
      consoleSpy.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
