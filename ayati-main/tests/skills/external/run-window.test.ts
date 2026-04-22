import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExternalSkillRegistry } from "../../../src/skills/external/registry.js";
import { RunExternalToolWindow } from "../../../src/skills/external/run-window.js";
import { createToolExecutor } from "../../../src/skills/tool-executor.js";

describe("RunExternalToolWindow", () => {
  let tmpDir: string;
  let skillsDir: string;
  let secretsPath: string;
  let policyPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ayati-run-window-"));
    skillsDir = join(tmpDir, "skills");
    secretsPath = join(tmpDir, "skill-secrets.json");
    policyPath = join(tmpDir, "skill-policy.json");

    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(secretsPath, JSON.stringify({}, null, 2));
    writeFileSync(policyPath, JSON.stringify({
      defaultMode: "allow",
      capabilities: {},
    }, null, 2));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSkill(skillId: string, toolCount: number): void {
    const skillDir = join(skillsDir, skillId);
    const toolsDir = join(skillDir, "tools");
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
      id: skillId,
      version: "1.0.0",
      title: "Demo Skill",
      description: "Demo skill description",
      status: "active",
      card: {
        summary: "Demo skill summary",
        whenToUse: "Use for demo tasks",
      },
      activation: {
        brief: "Activate this demo skill to mount its tools for the current run.",
      },
      toolFiles: Array.from({ length: toolCount }, (_, index) => `tools/tool-${index + 1}.json`),
    }, null, 2));

    for (let index = 0; index < toolCount; index++) {
      writeFileSync(join(toolsDir, `tool-${index + 1}.json`), JSON.stringify({
        id: `tool-${index + 1}`,
        description: `Demo tool ${index + 1}`,
        execution: {
          backend: "shell",
          command: "node",
          argsTemplate: ["-e", `console.log(${JSON.stringify(`tool-${index + 1}`)})`],
          outputMode: "text",
        },
      }, null, 2));
    }
  }

  it("keeps all skill cards visible and allows up to 20 mounted external tools", async () => {
    writeSkill("demo-skill", 12);

    const registry = new ExternalSkillRegistry({
      roots: [{ skillsDir, source: "project" }],
      secretMappingPath: secretsPath,
      policyPath,
    });
    await registry.initialize();

    const window = new RunExternalToolWindow({
      registry,
      toolExecutor: createToolExecutor([]),
      clientId: "c1",
      runId: "r1",
      sessionId: "s1",
      maxVisibleTools: 20,
    });

    const loaded = window.loadTools("demo-skill", Array.from({ length: 12 }, (_, index) => `tool-${index + 1}`));

    expect(window.getSkillCards()).toEqual([
      expect.objectContaining({
        skillId: "demo-skill",
        toolCount: 12,
        toolsPreview: expect.arrayContaining([
          expect.objectContaining({ toolName: "demo-skill.tool-1" }),
        ]),
      }),
    ]);
    expect(loaded.loaded).toHaveLength(12);
    expect(loaded.blockedReason).toBeUndefined();
    expect(window.getVisibleDefinitions()).toHaveLength(12);
    expect(window.getVisibleDefinitions().map((tool) => tool.name)).toEqual([
      "demo-skill.tool-12",
      "demo-skill.tool-11",
      "demo-skill.tool-10",
      "demo-skill.tool-9",
      "demo-skill.tool-8",
      "demo-skill.tool-7",
      "demo-skill.tool-6",
      "demo-skill.tool-5",
      "demo-skill.tool-4",
      "demo-skill.tool-3",
      "demo-skill.tool-2",
      "demo-skill.tool-1",
    ]);
  });

  it("fails deterministically instead of silently truncating when mounts would exceed the visible cap", async () => {
    writeSkill("demo-skill", 21);

    const registry = new ExternalSkillRegistry({
      roots: [{ skillsDir, source: "project" }],
      secretMappingPath: secretsPath,
      policyPath,
    });
    await registry.initialize();

    const window = new RunExternalToolWindow({
      registry,
      toolExecutor: createToolExecutor([]),
      clientId: "c1",
      runId: "r1",
      sessionId: "s1",
      maxVisibleTools: 20,
    });

    const loaded = window.loadTools("demo-skill", Array.from({ length: 21 }, (_, index) => `tool-${index + 1}`));

    expect(loaded.loaded).toHaveLength(0);
    expect(loaded.alreadyLoaded).toHaveLength(0);
    expect(loaded.blockedReason).toContain("visible external-tool limit of 20");
    expect(window.getVisibleDefinitions()).toHaveLength(0);
  });
});
