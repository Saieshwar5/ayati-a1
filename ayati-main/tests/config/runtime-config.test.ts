import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  DEFAULT_AGENT_MAX_CAPABILITY_SURFACE_TOOLS,
  DEFAULT_AYATI_ROOT_DIR,
  DEFAULT_CONTEXT_ENGINE_AGENT_ID,
  DEFAULT_CONTEXT_ENGINE_TIMEZONE,
  DEFAULT_HTTP_ALLOW_ORIGIN,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_UPLOAD_MAX_BYTES,
  DEFAULT_WORKSPACE_DIR,
  loadAyatiRuntimeConfig,
  parsePositiveInt,
  resolveAyatiRootDir,
} from "../../src/config/runtime-config.js";

describe("ayati runtime config", () => {
  it("derives all storage from the default Ayati root", () => {
    const config = loadAyatiRuntimeConfig({});

    expect(config).toEqual({
      http: {
        host: DEFAULT_HTTP_HOST,
        port: DEFAULT_HTTP_PORT,
        allowOrigin: DEFAULT_HTTP_ALLOW_ORIGIN,
        maxUploadBytes: DEFAULT_UPLOAD_MAX_BYTES,
      },
      python: {},
      agent: { loopConfig: { maxCapabilitySurfaceTools: DEFAULT_AGENT_MAX_CAPABILITY_SURFACE_TOOLS } },
      filesystemAccess: {
        readScope: "machine",
        mutationScope: "workspace",
      },
      workspace: { root: DEFAULT_WORKSPACE_DIR },
      contextEngine: {
        rootDirectory: DEFAULT_AYATI_ROOT_DIR,
        databasePath: join(DEFAULT_AYATI_ROOT_DIR, ".ayati", "context.db"),
        timezone: DEFAULT_CONTEXT_ENGINE_TIMEZONE,
        agentId: DEFAULT_CONTEXT_ENGINE_AGENT_ID,
      },
    });
  });

  it("loads explicit runtime values around one Ayati root", () => {
    const config = loadAyatiRuntimeConfig({
      AYATI_ROOT_DIR: " /tmp/ayati-runtime ",
      AYATI_HTTP_HOST: " 0.0.0.0 ",
      AYATI_HTTP_PORT: "9090",
      AYATI_HTTP_ALLOW_ORIGIN: " https://app.example ",
      AYATI_UPLOAD_MAX_BYTES: "4096",
      AYATI_PYTHON_INTERPRETER: " /usr/bin/python3 ",
      AYATI_AGENT_MAX_CAPABILITY_SURFACE_TOOLS: "5",
      AYATI_FILESYSTEM_READ_SCOPE: "workspace",
      AYATI_FILESYSTEM_MUTATION_SCOPE: "bound_resource",
      AYATI_CONTEXT_ENGINE_DATABASE: " /tmp/ayati-db/context.db ",
      AYATI_CONTEXT_ENGINE_TIMEZONE: " UTC ",
      AYATI_CONTEXT_ENGINE_AGENT_ID: " local-agent ",
    });

    expect(config.workspace.root).toBe("/tmp/ayati-runtime/workspace");
    expect(config.contextEngine).toEqual({
      rootDirectory: "/tmp/ayati-runtime",
      databasePath: "/tmp/ayati-db/context.db",
      timezone: "UTC",
      agentId: "local-agent",
    });
    expect(config.http).toMatchObject({
      host: "0.0.0.0",
      port: 9090,
      allowOrigin: "https://app.example",
      maxUploadBytes: 4096,
    });
    expect(config.python.interpreterPath).toBe("/usr/bin/python3");
    expect(config.agent.loopConfig.maxCapabilitySurfaceTools).toBe(5);
    expect(config.filesystemAccess).toEqual({
      readScope: "workspace",
      mutationScope: "bound_resource",
    });
  });

  it("accepts legacy Git Context storage settings during the internal rename", () => {
    const config = loadAyatiRuntimeConfig({
      AYATI_GIT_CONTEXT_DATABASE: "/tmp/legacy-context.db",
      AYATI_GIT_CONTEXT_TIMEZONE: "UTC",
      AYATI_GIT_CONTEXT_AGENT_ID: "legacy-agent",
    });

    expect(config.contextEngine).toMatchObject({
      databasePath: "/tmp/legacy-context.db",
      timezone: "UTC",
      agentId: "legacy-agent",
    });
  });

  it("resolves a relative Ayati root from the package project root", () => {
    expect(resolveAyatiRootDir("custom-ayati")).toMatch(/\/ayati-main\/custom-ayati$/);
  });

  it("falls back for invalid positive integer values", () => {
    const config = loadAyatiRuntimeConfig({
      AYATI_HTTP_PORT: "-1",
      AYATI_UPLOAD_MAX_BYTES: "not-a-number",
    });

    expect(config.http.port).toBe(DEFAULT_HTTP_PORT);
    expect(config.http.maxUploadBytes).toBe(DEFAULT_UPLOAD_MAX_BYTES);
    expect(config.agent.loopConfig.maxCapabilitySurfaceTools).toBe(
      DEFAULT_AGENT_MAX_CAPABILITY_SURFACE_TOOLS,
    );
    expect(parsePositiveInt("42", 1)).toBe(42);
    expect(parsePositiveInt("0", 1)).toBe(1);
  });

  it("omits optional trimmed values when they are empty", () => {
    const config = loadAyatiRuntimeConfig({
      AYATI_PYTHON_INTERPRETER: "   ",
    });

    expect(config.python.interpreterPath).toBeUndefined();
  });

  it("rejects invalid filesystem policy values instead of weakening access policy", () => {
    expect(() => loadAyatiRuntimeConfig({
      AYATI_FILESYSTEM_READ_SCOPE: "everything",
    })).toThrow(/AYATI_FILESYSTEM_READ_SCOPE/);
    expect(() => loadAyatiRuntimeConfig({
      AYATI_FILESYSTEM_MUTATION_SCOPE: "machine",
    })).toThrow(/AYATI_FILESYSTEM_MUTATION_SCOPE/);
  });
});
