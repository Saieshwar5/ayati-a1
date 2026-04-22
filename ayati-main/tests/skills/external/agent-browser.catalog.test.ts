import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadExternalSkillCatalog } from "../../../src/skills/external/catalog.js";
import { createExternalSkillBroker } from "../../../src/skills/external/broker.js";
import { ExternalSkillRegistry } from "../../../src/skills/external/registry.js";
import { createToolExecutor } from "../../../src/skills/tool-executor.js";

const AGENT_BROWSER_TOOL_IDS = [
  "search",
  "open",
  "snapshot",
  "find",
  "click",
  "fill",
  "type",
  "press",
  "wait",
  "get_text",
  "get_url",
  "get_title",
  "screenshot",
  "tab_new",
  "tab_switch",
  "close",
  "help",
  "advanced",
];

const AGENT_BROWSER_TOOL_NAMES = AGENT_BROWSER_TOOL_IDS.map((toolId) => `agent-browser.${toolId}`);

describe("real agent-browser skill catalog", () => {
  let tempDir: string;
  let secretsPath: string;
  let policyPath: string;
  let skillsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ayati-web-catalog-"));
    secretsPath = join(tempDir, "skill-secrets.json");
    policyPath = join(tempDir, "skill-policy.json");
    skillsDir = resolve(process.cwd(), "data", "skills");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(secretsPath, JSON.stringify({}, null, 2));
    writeFileSync(policyPath, JSON.stringify({
      defaultMode: "allow",
      capabilities: {},
    }, null, 2));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exposes agent-browser as the only active browser/web skill in the catalog and registry", async () => {
    const catalog = await loadExternalSkillCatalog([{ skillsDir, source: "project" }]);
    const skillIds = catalog.skills.map((skill) => skill.id);
    expect(skillIds).toContain("agent-browser");
    expect(skillIds).not.toContain("web");
    expect(skillIds).not.toContain("websearch");
    expect(skillIds).not.toContain("playwright");

    const agentBrowserSkill = catalog.skills.find((skill) => skill.id === "agent-browser");
    expect(agentBrowserSkill).toBeDefined();
    expect(agentBrowserSkill?.tools.map((tool) => tool.id)).toEqual(AGENT_BROWSER_TOOL_IDS);
    expect(agentBrowserSkill?.cardSummary).toContain("Search the public web");
    expect(agentBrowserSkill?.activationWorkflow).toEqual([
      "Use agent-browser.search when the right site is not known yet.",
      "Use agent-browser.open followed by agent-browser.snapshot to discover fresh refs on the page.",
      "Use click, fill, type, press, wait, get_text, get_url, get_title, screenshot, and tabs for the normal loop.",
      "Use agent-browser.help before agent-browser.advanced when the needed browser command family is uncommon.",
    ]);

    const registry = new ExternalSkillRegistry({
      roots: [{ skillsDir, source: "project" }],
      secretMappingPath: secretsPath,
      policyPath,
    });
    await registry.initialize();

    const cards = registry.getSkillCards();
    const agentBrowserCard = cards.find((card) => card.skillId === "agent-browser");
    expect(agentBrowserCard).toEqual(expect.objectContaining({
      skillId: "agent-browser",
      roleLabel: "Browser Agent",
      toolCount: AGENT_BROWSER_TOOL_IDS.length,
    }));
    expect(cards.some((card) => card.skillId === "web")).toBe(false);
    expect(cards.some((card) => card.skillId === "websearch")).toBe(false);
    expect(cards.some((card) => card.skillId === "playwright")).toBe(false);
  });

  it("activates the full agent-browser toolset and reports it as the active skill context", async () => {
    const executor = createToolExecutor([]);
    const broker = createExternalSkillBroker({
      roots: [{ skillsDir, source: "project" }],
      cachePath: join(tempDir, "catalog.json"),
      secretMappingPath: secretsPath,
      policyPath,
      toolExecutor: executor,
    });

    await broker.initialize();

    const activation = await broker.activate({ skillId: "agent-browser" }, {
      clientId: "c1",
      runId: "r1",
      sessionId: "s1",
      stepNumber: 1,
    });

    expect(activation.ok).toBe(true);
    expect(activation.activation?.activatedTools.map((tool) => tool.toolName)).toEqual(AGENT_BROWSER_TOOL_NAMES);
    expect(executor.list({
      clientId: "c1",
      runId: "r1",
      sessionId: "s1",
      stepNumber: 1,
    }).sort()).toEqual([...AGENT_BROWSER_TOOL_NAMES].sort());

    const active = broker.listActive({
      clientId: "c1",
      runId: "r1",
      sessionId: "s1",
    });

    expect(active.skills).toEqual([
      expect.objectContaining({
        skillId: "agent-browser",
        toolNames: AGENT_BROWSER_TOOL_NAMES,
      }),
    ]);
  });
});
