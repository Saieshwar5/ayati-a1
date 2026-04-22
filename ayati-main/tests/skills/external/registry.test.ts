import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExternalSkillRegistry } from "../../../src/skills/external/registry.js";

describe("ExternalSkillRegistry", () => {
  let tmpDir: string;
  let skillsDir: string;
  let secretsPath: string;
  let policyPath: string;
  let originalDemoToken: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ayati-registry-"));
    skillsDir = join(tmpDir, "skills");
    secretsPath = join(tmpDir, "skill-secrets.json");
    policyPath = join(tmpDir, "skill-policy.json");
    originalDemoToken = process.env["DEMO_TOKEN"];

    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(secretsPath, JSON.stringify({
      "demo.token": {
        source: "env",
        env: "DEMO_TOKEN",
      },
    }, null, 2));
    writeFileSync(policyPath, JSON.stringify({
      defaultMode: "allow",
      capabilities: {},
    }, null, 2));
  });

  afterEach(() => {
    if (originalDemoToken === undefined) {
      delete process.env["DEMO_TOKEN"];
    } else {
      process.env["DEMO_TOKEN"] = originalDemoToken;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSkill(
    skillId: string,
    manifest: Record<string, unknown>,
    tools: Array<{ fileName: string; manifest: string | Record<string, unknown> }>,
  ): void {
    const skillDir = join(skillsDir, skillId);
    const toolsDir = join(skillDir, "tools");
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(join(skillDir, "skill.json"), JSON.stringify({
      id: skillId,
      version: "1.0.0",
      title: skillId,
      description: `${skillId} skill`,
      status: "active",
      card: {
        summary: `${skillId} summary`,
        whenToUse: `Use ${skillId} when its capability is needed.`,
      },
      activation: {
        brief: `Activate ${skillId} to mount its tools for the current run.`,
      },
      policy: {
        capabilities: [],
      },
      ...manifest,
    }, null, 2));

    for (const tool of tools) {
      writeFileSync(
        join(toolsDir, tool.fileName),
        typeof tool.manifest === "string" ? tool.manifest : JSON.stringify(tool.manifest, null, 2),
      );
    }
  }

  function createRegistry(): ExternalSkillRegistry {
    return new ExternalSkillRegistry({
      roots: [{ skillsDir, source: "project" }],
      secretMappingPath: secretsPath,
      policyPath,
    });
  }

  it("preloads active tools and searches them from memory", async () => {
    writeSkill("demo-search", {
      title: "Demo Search",
      description: "Demo search skill",
      domains: ["search"],
      tags: ["lookup"],
      card: {
        summary: "Search the public web for current information.",
        whenToUse: "Use for current facts and public web results.",
        roleLabel: "Search Engine",
        useFor: ["latest public information", "finding the right website"],
        notFor: ["clicking through rendered pages"],
        workflowHint: "Use before a browser skill when the site is not known.",
        pairedSkillId: "demo-browser",
      },
      toolFiles: ["tools/query.json"],
    }, [{
      fileName: "query.json",
      manifest: {
        id: "query",
        title: "Query",
        description: "Run a demo query",
        tags: ["search"],
        execution: {
          backend: "shell",
          command: "node",
          argsTemplate: ["-e", "console.log('demo-search-ok')"],
          outputMode: "text",
        },
      },
    }]);

    writeSkill("disabled-search", {
      status: "disabled",
      toolFiles: ["tools/query.json"],
    }, [{
      fileName: "query.json",
      manifest: {
        id: "query",
        description: "Should stay hidden",
        execution: {
          backend: "shell",
          command: "node",
          argsTemplate: ["-e", "console.log('hidden')"],
          outputMode: "text",
        },
      },
    }]);

    const registry = createRegistry();
    await registry.initialize();

    const results = registry.search("demo search query");
    expect(results.map((result) => result.toolName)).toContain("demo-search.query");
    expect(results.map((result) => result.toolName)).not.toContain("disabled-search.query");
    expect(registry.getToolDefinition("demo-search.query")).toBeDefined();
    expect(registry.searchSkills("current public web results").map((result) => result.skillId)).toContain("demo-search");
    expect(registry.getSkillCards()).toEqual([
      expect.objectContaining({
        skillId: "demo-search",
        summary: "Search the public web for current information.",
        whenToUse: "Use for current facts and public web results.",
        roleLabel: "Search Engine",
        useFor: ["latest public information", "finding the right website"],
        notFor: ["clicking through rendered pages"],
        workflowHint: "Use before a browser skill when the site is not known.",
        pairedSkillId: "demo-browser",
        toolCount: 1,
      }),
    ]);
    expect(registry.getSkillDetail("demo-search")).toEqual(expect.objectContaining({
      skillId: "demo-search",
      roleLabel: "Search Engine",
      useFor: ["latest public information", "finding the right website"],
      notFor: ["clicking through rendered pages"],
      workflowHint: "Use before a browser skill when the site is not known.",
      pairedSkillId: "demo-browser",
      toolCount: 1,
      tools: [
        expect.objectContaining({
          toolId: "query",
          toolName: "demo-search.query",
        }),
      ],
    }));
  });

  it("quarantines broken active skills and excludes them from search", async () => {
    writeSkill("broken-search", {
      title: "Broken Search",
      toolFiles: ["tools/query.json"],
    }, [{
      fileName: "query.json",
      manifest: "{ not-valid-json",
    }]);

    const registry = createRegistry();
    await registry.initialize();

    expect(registry.search("broken search")).toHaveLength(0);
    expect(registry.getQuarantinedSkills()).toEqual([
      expect.objectContaining({
        skillId: "broken-search",
      }),
    ]);
  });

  it("resolves secrets only at execution time for shell-backed tools", async () => {
    process.env["DEMO_TOKEN"] = "super-secret-token";

    writeSkill("secret-search", {
      title: "Secret Search",
      auth: {
        required: true,
        secretRefs: ["demo.token"],
      },
      toolFiles: ["tools/status.json"],
    }, [{
      fileName: "status.json",
      manifest: {
        id: "status",
        description: "Check secret-backed CLI readiness",
        execution: {
          backend: "shell",
          command: "node",
          argsTemplate: ["-e", "console.log(process.env.DEMO_TOKEN ? 'present' : 'missing')"],
          outputMode: "text",
        },
      },
    }]);

    const registry = createRegistry();
    await registry.initialize();

    const tool = registry.getToolDefinition("secret-search.status");
    expect(tool).toBeDefined();

    const result = await tool!.execute({});
    expect(result.ok).toBe(true);
    expect(result.output).toContain("present");
    expect(result.output).not.toContain("super-secret-token");
  });

  it("resolves tool names by skill id using tool ids or full tool names", async () => {
    writeSkill("demo-browser", {
      title: "Demo Browser",
      description: "Demo browser skill",
      card: {
        summary: "Render and inspect pages.",
        whenToUse: "Use for screenshots and page interaction.",
      },
      toolFiles: ["tools/open.json", "tools/screenshot.json"],
    }, [
      {
        fileName: "open.json",
        manifest: {
          id: "open",
          description: "Open a browser session",
          execution: {
            backend: "shell",
            command: "node",
            argsTemplate: ["-e", "console.log('open')"],
            outputMode: "text",
          },
        },
      },
      {
        fileName: "screenshot.json",
        manifest: {
          id: "screenshot",
          description: "Capture a screenshot",
          execution: {
            backend: "shell",
            command: "node",
            argsTemplate: ["-e", "console.log('shot')"],
            outputMode: "text",
          },
        },
      },
    ]);

    const registry = createRegistry();
    await registry.initialize();

    expect(registry.resolveSkillToolNames("demo-browser", ["open", "demo-browser.screenshot", "missing"])).toEqual({
      resolved: ["demo-browser.open", "demo-browser.screenshot"],
      missing: ["missing"],
    });
  });

  it("uses skill-card guidance to distinguish search-engine and browser skills", async () => {
    writeSkill("websearch", {
      title: "Websearch",
      description: "Search engine for the public web",
      domains: ["search", "web"],
      tags: ["search"],
      card: {
        summary: "Search engine for websites and current public information.",
        whenToUse: "Use when you need to discover the right website or latest public information.",
        roleLabel: "Search Engine",
        useFor: [
          "finding the right website before browsing",
          "latest public information, market data, news, and current events",
        ],
        notFor: [
          "clicking through websites",
          "browser interaction or web app testing",
        ],
        workflowHint: "Use websearch first, then switch to playwright if a page must be opened.",
        pairedSkillId: "playwright",
      },
      toolFiles: ["tools/search.json"],
    }, [{
      fileName: "search.json",
      manifest: {
        id: "search",
        description: "Run a search",
        execution: {
          backend: "shell",
          command: "node",
          argsTemplate: ["-e", "console.log('search')"],
          outputMode: "text",
        },
      },
    }]);

    writeSkill("playwright", {
      title: "Playwright",
      description: "Browser automation skill",
      domains: ["browser", "web", "testing"],
      tags: ["browser"],
      card: {
        summary: "Web browser for opening and using websites.",
        whenToUse: "Use when you know the target URL or need to interact with a page.",
        roleLabel: "Web Browser",
        useFor: [
          "opening a known URL in a browser",
          "clicking, filling forms, and browsing rendered pages",
          "testing web app flows and taking screenshots",
        ],
        notFor: [
          "broad web discovery",
          "search engine style lookup of latest public information",
        ],
        workflowHint: "Use after websearch finds the site, or directly when the URL is already known.",
        pairedSkillId: "websearch",
      },
      toolFiles: ["tools/goto.json"],
    }, [{
      fileName: "goto.json",
      manifest: {
        id: "goto",
        description: "Open a URL in the browser",
        execution: {
          backend: "shell",
          command: "node",
          argsTemplate: ["-e", "console.log('goto')"],
          outputMode: "text",
        },
      },
    }]);

    const registry = createRegistry();
    await registry.initialize();

    expect(registry.searchSkills("today indian stock market latest news")[0]).toEqual(expect.objectContaining({
      skillId: "websearch",
      roleLabel: "Search Engine",
    }));

    expect(registry.searchSkills("open this url and click login form")[0]).toEqual(expect.objectContaining({
      skillId: "playwright",
      roleLabel: "Web Browser",
    }));
  });
});
