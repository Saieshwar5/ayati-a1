import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createToolExecutor } from "../../../src/skills/tool-executor.js";
import { createExternalSkillBroker } from "../../../src/skills/external/broker.js";

describe("ExternalSkillBroker", () => {
  let tmpDir: string;
  let skillsDir: string;
  let secretsPath: string;
  let policyPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ayati-broker-"));
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

  function createBroker() {
    const executor = createToolExecutor([]);
    const broker = createExternalSkillBroker({
      roots: [{ skillsDir, source: "project" }],
      cachePath: join(tmpDir, "catalog.json"),
      secretMappingPath: secretsPath,
      policyPath,
      toolExecutor: executor,
      pluginStatusProvider: (name) => ({
        name,
        loaded: true,
        started: true,
      }),
    });

    return { executor, broker };
  }

  function writeSkill(
    skillId: string,
    manifest: Record<string, unknown>,
    tools: Array<{ fileName: string; manifest: Record<string, unknown> }>,
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
        defaultScope: "run",
        brief: `Activate ${skillId} to mount its tools for the current run.`,
      },
      policy: {
        capabilities: [],
      },
      ...manifest,
    }, null, 2));

    for (const tool of tools) {
      writeFileSync(join(toolsDir, tool.fileName), JSON.stringify(tool.manifest, null, 2));
    }
  }

  it("loads structured skills, searches, activates, and executes a command-backed external tool", async () => {
    writeSkill("demo-search", {
      title: "Demo Search",
      description: "Demo external search skill",
      domains: ["search", "web"],
      tags: ["lookup"],
      aliases: ["demo web"],
      triggers: ["search the demo web"],
      toolFiles: ["tools/query.json"],
    }, [{
      fileName: "query.json",
      manifest: {
        id: "query",
        title: "Query",
        description: "Run a demo query",
        aliases: ["demo query"],
        tags: ["search"],
        triggers: ["run a demo query"],
        action: "search",
        object: "web",
        provider: "demo",
        inputSchema: {
          type: "object",
          properties: {},
        },
        execution: {
          backend: "command",
          command: "node",
          argsTemplate: ["-e", "console.log('demo-search-ok')"],
        },
        policy: {
          capabilities: [],
          timeoutMs: 10000,
        },
      },
    }]);

    const { executor, broker } = createBroker();

    await broker.initialize();

    const searchResults = await broker.search({ query: "demo search query", limit: 5, kind: "tool" });
    expect(searchResults.some((result) => result.skillId === "demo-search")).toBe(true);
    expect(searchResults[0]?.toolName).toBe("demo-search.query");

    const description = await broker.describe("demo-search");
    expect(description?.tools).toHaveLength(1);
    expect(description?.tools[0]?.id).toBe("query");
    expect(description?.activatable).toBe(true);

    const activation = await broker.activate({ skillId: "demo-search" }, {
      clientId: "c1",
      runId: "r1",
      sessionId: "s1",
      stepNumber: 1,
    });
    expect(activation.ok).toBe(true);
    expect(activation.activation?.activatedTools.map((tool) => tool.toolName)).toEqual(["demo-search.query"]);
    expect(activation.activation?.windowSize).toBe(1);
    expect(executor.list({ runId: "r1", sessionId: "s1", stepNumber: 1 })).toContain("demo-search.query");

    const result = await executor.execute("demo-search.query", {}, {
      clientId: "c1",
      runId: "r1",
      sessionId: "s1",
      stepNumber: 2,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("demo-search-ok");
  });

  it("supports structured command args, cwd templates, json stdout parsing, and plugin health status", async () => {
    writeSkill("demo-runtime", {
      title: "Demo Runtime",
      description: "Demo external runtime skill",
      domains: ["demo"],
      tags: ["runtime"],
      integration: {
        plugin: {
          name: "demo-plugin",
          required: false,
        },
      },
      toolFiles: ["tools/inspect.json"],
    }, [{
      fileName: "inspect.json",
      manifest: {
        id: "inspect",
        title: "Inspect",
        description: "Inspect command runtime",
        execution: {
          backend: "command",
          command: "node",
          args: [
            { value: "-e" },
            { value: "console.log(JSON.stringify({cwd: process.cwd(), args: process.argv.slice(1)}))" },
            { value: "--" },
            { flag: "--limit", from: "limit" },
            { flag: "--tag", from: "tags", repeat: true },
          ],
          cwdTemplate: "{{workspace}}",
          outputMode: "json-stdout",
        },
        inputSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            limit: { type: "number" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
        policy: {
          capabilities: [],
          timeoutMs: 10000,
        },
      },
    }]);

    const { executor, broker } = createBroker();

    await broker.initialize();

    const activation = await broker.activate({ skillId: "demo-runtime" }, {
      clientId: "c1",
      runId: "r1",
      sessionId: "s1",
      stepNumber: 1,
    });
    expect(activation.ok).toBe(true);

    const runWorkspace = join(tmpDir, "workspace");
    mkdirSync(runWorkspace, { recursive: true });
    const result = await executor.execute("demo-runtime.inspect", {
      workspace: runWorkspace,
      limit: 5,
      tags: ["alpha", "beta"],
    }, {
      clientId: "c1",
      runId: "r1",
      sessionId: "s1",
      stepNumber: 2,
    });
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output ?? "{}") as { cwd?: string; args?: string[] };
    expect(parsed.cwd).toBe(runWorkspace);
    expect(parsed.args).toEqual(["--limit", "5", "--tag", "alpha", "--tag", "beta"]);

    const health = await broker.health("demo-runtime");
    expect(health[0]?.plugin).toEqual({
      name: "demo-plugin",
      loaded: true,
      started: true,
    });
  });

  it("hides blocked tools from normal search and reports readiness reasons in health", async () => {
    writeFileSync(secretsPath, JSON.stringify({
      "demo.token": {
        source: "env",
        env: "DEMO_TOKEN",
      },
    }, null, 2));

    writeSkill("secret-search", {
      description: "Requires a missing secret",
      auth: {
        required: true,
        secretRefs: ["demo.token"],
      },
      toolFiles: ["tools/query.json"],
    }, [{
      fileName: "query.json",
      manifest: {
        id: "query",
        title: "Query",
        description: "Needs a token",
        execution: {
          backend: "command",
          command: "node",
          argsTemplate: ["-e", "console.log('blocked')"],
        },
      },
    }]);

    writeSkill("http-no-allowlist", {
      description: "HTTP tool without allowedDomains",
      toolFiles: ["tools/fetch.json"],
    }, [{
      fileName: "fetch.json",
      manifest: {
        id: "fetch",
        title: "Fetch",
        description: "Missing allowedDomains",
        execution: {
          backend: "http",
          method: "GET",
          url: "https://example.com",
        },
      },
    }]);

    const { broker } = createBroker();
    await broker.initialize();

    const searchResults = await broker.search({ query: "query fetch token", kind: "tool", limit: 10 });
    expect(searchResults).toEqual([]);

    const health = await broker.health();
    expect(health.find((item) => item.skillId === "secret-search")?.reasons[0]?.code).toBe("missing_secret");
    expect(health.find((item) => item.skillId === "http-no-allowlist")?.tools[0]?.reasons[0]?.code).toBe("missing_http_allowlist");
  });

  it("keeps only 5 active external skills per run and evicts the oldest skill by FIFO", async () => {
    for (let index = 1; index <= 6; index += 1) {
      const id = `skill-${String(index).padStart(2, "0")}`;
      writeSkill(id, {
        toolFiles: ["tools/run.json"],
      }, [{
        fileName: "run.json",
        manifest: {
          id: "run",
          title: "Run",
          description: `${id} runner`,
          execution: {
            backend: "command",
            command: "node",
            argsTemplate: ["-e", `console.log('${id}')`],
          },
        },
      }]);
    }

    const { broker } = createBroker();
    await broker.initialize();

    for (let index = 1; index <= 5; index += 1) {
      const id = `skill-${String(index).padStart(2, "0")}`;
      const activation = await broker.activate({ skillId: id }, {
        clientId: "c1",
        runId: "r1",
        sessionId: "s1",
        stepNumber: index,
      });
      expect(activation.ok).toBe(true);
      expect(activation.activation?.evictedTools).toEqual([]);
      expect(activation.activation?.evictedSkills).toEqual([]);
    }

    const repeatActivation = await broker.activate({ skillId: "skill-01" }, {
      clientId: "c1",
      runId: "r1",
      sessionId: "s1",
      stepNumber: 6,
    });
    expect(repeatActivation.ok).toBe(true);
    expect(repeatActivation.activation?.status).toBe("already_active");
    expect(repeatActivation.activation?.evictedSkills).toEqual([]);

    const overflowActivation = await broker.activate({ skillId: "skill-06" }, {
      clientId: "c1",
      runId: "r1",
      sessionId: "s1",
      stepNumber: 7,
    });
    expect(overflowActivation.ok).toBe(true);
    expect(overflowActivation.activation?.evictedSkills).toEqual(["skill-01"]);
    expect(overflowActivation.activation?.evictedTools.map((tool) => tool.toolName)).toEqual(["skill-01.run"]);

    const active = broker.listActive({ runId: "r1", sessionId: "s1" });
    expect(active.windowSize).toBe(5);
    expect(active.tools.some((tool) => tool.toolName === "skill-01.run")).toBe(false);
    expect(active.tools.some((tool) => tool.toolName === "skill-02.run")).toBe(true);
    expect(active.tools.some((tool) => tool.toolName === "skill-06.run")).toBe(true);
  });

  it("reloads the catalog lazily when new skills are added after initialization", async () => {
    const { broker } = createBroker();
    await broker.initialize();

    expect(await broker.search({ query: "late skill", kind: "tool", limit: 5 })).toEqual([]);

    writeSkill("late-skill", {
      description: "Appears after broker initialization",
      toolFiles: ["tools/ping.json"],
    }, [{
      fileName: "ping.json",
      manifest: {
        id: "ping",
        title: "Ping",
        description: "Late-loaded tool",
        execution: {
          backend: "command",
          command: "node",
          argsTemplate: ["-e", "console.log('late-loaded')"],
        },
      },
    }]);

    const searchResults = await broker.search({ query: "late loaded ping", kind: "tool", limit: 5 });
    expect(searchResults.map((result) => result.toolName)).toContain("late-skill.ping");
  });
});
