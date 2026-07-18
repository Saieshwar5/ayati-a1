import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  DEFAULT_DOCUMENT_EMBED_BATCH_SIZE,
  DEFAULT_DOCUMENT_VECTOR_MIN_CHUNKS,
  DEFAULT_AGENT_MAX_SELECTED_TOOLS,
  DEFAULT_GIT_CONTEXT_AGENT_ID,
  DEFAULT_GIT_CONTEXT_STORE_DIR,
  DEFAULT_GIT_CONTEXT_START_TIMEOUT_MS,
  DEFAULT_GIT_CONTEXT_STOP_TIMEOUT_MS,
  DEFAULT_GIT_CONTEXT_REQUEST_TIMEOUT_MS,
  DEFAULT_GIT_CONTEXT_TIMEZONE,
  DEFAULT_HTTP_ALLOW_ORIGIN,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_UPLOAD_MAX_BYTES,
  DEFAULT_WORKSPACE_DIR,
  loadAyatiRuntimeConfig,
  parsePositiveInt,
  resolveGitContextStoreDir,
  resolveWorkspaceDir,
} from "../../src/config/runtime-config.js";

describe("ayati runtime config", () => {
  it("loads default app-level runtime config", () => {
    const config = loadAyatiRuntimeConfig({});

    expect(config).toEqual({
      http: {
        host: DEFAULT_HTTP_HOST,
        port: DEFAULT_HTTP_PORT,
        allowOrigin: DEFAULT_HTTP_ALLOW_ORIGIN,
        maxUploadBytes: DEFAULT_UPLOAD_MAX_BYTES,
      },
      documents: {
        vectorEnabled: true,
        embedBatchSize: DEFAULT_DOCUMENT_EMBED_BATCH_SIZE,
        vectorMinChunks: DEFAULT_DOCUMENT_VECTOR_MIN_CHUNKS,
      },
      python: {},
      agent: {
        loopConfig: {
          maxSelectedTools: DEFAULT_AGENT_MAX_SELECTED_TOOLS,
        },
      },
      workspace: {
        root: DEFAULT_WORKSPACE_DIR,
      },
      gitContext: {
        storeDir: DEFAULT_GIT_CONTEXT_STORE_DIR,
        databasePath: join(DEFAULT_GIT_CONTEXT_STORE_DIR, "context.sqlite"),
        dataRoot: join(DEFAULT_WORKSPACE_DIR, ".ayati-context"),
        workspaceRoot: DEFAULT_WORKSPACE_DIR,
        socketPath: join(DEFAULT_GIT_CONTEXT_STORE_DIR, "git-context.sock"),
        managed: true,
        startTimeoutMs: DEFAULT_GIT_CONTEXT_START_TIMEOUT_MS,
        stopTimeoutMs: DEFAULT_GIT_CONTEXT_STOP_TIMEOUT_MS,
        requestTimeoutMs: DEFAULT_GIT_CONTEXT_REQUEST_TIMEOUT_MS,
        timezone: DEFAULT_GIT_CONTEXT_TIMEZONE,
        agentId: DEFAULT_GIT_CONTEXT_AGENT_ID,
      },
    });
  });

  it("loads explicit HTTP, document, Python, agent, workspace, and git context overrides", () => {
    const config = loadAyatiRuntimeConfig({
      AYATI_HTTP_HOST: " 0.0.0.0 ",
      AYATI_HTTP_PORT: "9090",
      AYATI_HTTP_ALLOW_ORIGIN: " https://app.example ",
      AYATI_HTTP_API_TOKEN: " local-token ",
      AYATI_UPLOAD_MAX_BYTES: "4096",
      AYATI_DOCUMENT_VECTOR_ENABLED: "false",
      AYATI_DOCUMENT_EMBED_BATCH_SIZE: "64",
      AYATI_DOCUMENT_VECTOR_MIN_CHUNKS: "12",
      AYATI_PYTHON_INTERPRETER: " /usr/bin/python3 ",
      AYATI_AGENT_MAX_SELECTED_TOOLS: "5",
      AYATI_WORKSPACE_DIR: " /tmp/ayati-workspace ",
      AYATI_GIT_CONTEXT_STORE_DIR: " /tmp/ayati-context-engine ",
      AYATI_GIT_CONTEXT_DATABASE: " /tmp/ayati-db/context.sqlite ",
      AYATI_GIT_CONTEXT_DATA_ROOT: " /tmp/ayati-git-data ",
      AYATI_GIT_CONTEXT_SOCKET: " /tmp/ayati-context.sock ",
      AYATI_GIT_CONTEXT_MANAGED: "false",
      AYATI_GIT_CONTEXT_START_TIMEOUT_MS: "1200",
      AYATI_GIT_CONTEXT_STOP_TIMEOUT_MS: "1300",
      AYATI_GIT_CONTEXT_REQUEST_TIMEOUT_MS: "1400",
      AYATI_GIT_CONTEXT_TIMEZONE: " UTC ",
      AYATI_GIT_CONTEXT_AGENT_ID: " local-agent ",
    });

    expect(config).toEqual({
      http: {
        host: "0.0.0.0",
        port: 9090,
        allowOrigin: "https://app.example",
        apiToken: "local-token",
        maxUploadBytes: 4096,
      },
      documents: {
        vectorEnabled: false,
        embedBatchSize: 64,
        vectorMinChunks: 12,
      },
      python: {
        interpreterPath: "/usr/bin/python3",
      },
      agent: {
        loopConfig: {
          maxSelectedTools: 5,
        },
      },
      workspace: {
        root: "/tmp/ayati-workspace",
      },
      gitContext: {
        storeDir: "/tmp/ayati-context-engine",
        databasePath: "/tmp/ayati-db/context.sqlite",
        dataRoot: "/tmp/ayati-git-data",
        workspaceRoot: "/tmp/ayati-workspace",
        socketPath: "/tmp/ayati-context.sock",
        managed: false,
        startTimeoutMs: 1200,
        stopTimeoutMs: 1300,
        requestTimeoutMs: 1400,
        timezone: "UTC",
        agentId: "local-agent",
      },
    });
  });

  it("resolves relative workspace overrides from the project root", () => {
    expect(resolveWorkspaceDir("custom-workspace")).toMatch(/\/ayati-main\/custom-workspace$/);
  });

  it("resolves relative git context store overrides from the project root", () => {
    expect(resolveGitContextStoreDir("custom-context")).toMatch(/\/ayati-main\/custom-context$/);
  });

  it("falls back for invalid positive integer values", () => {
    const config = loadAyatiRuntimeConfig({
      AYATI_HTTP_PORT: "-1",
      AYATI_UPLOAD_MAX_BYTES: "not-a-number",
      AYATI_DOCUMENT_EMBED_BATCH_SIZE: "0",
      AYATI_DOCUMENT_VECTOR_MIN_CHUNKS: "",
    });

    expect(config.http.port).toBe(DEFAULT_HTTP_PORT);
    expect(config.http.maxUploadBytes).toBe(DEFAULT_UPLOAD_MAX_BYTES);
    expect(config.documents.embedBatchSize).toBe(DEFAULT_DOCUMENT_EMBED_BATCH_SIZE);
    expect(config.documents.vectorMinChunks).toBe(DEFAULT_DOCUMENT_VECTOR_MIN_CHUNKS);
    expect(config.agent.loopConfig.maxSelectedTools).toBe(DEFAULT_AGENT_MAX_SELECTED_TOOLS);
    expect(parsePositiveInt("42", 1)).toBe(42);
    expect(parsePositiveInt("0", 1)).toBe(1);
  });

  it("treats explicit false-like document vector values as disabled", () => {
    for (const value of ["0", "false", "FALSE", "no", "off"]) {
      expect(loadAyatiRuntimeConfig({ AYATI_DOCUMENT_VECTOR_ENABLED: value }).documents.vectorEnabled)
        .toBe(false);
    }
  });

  it("omits optional trimmed values when they are empty", () => {
    const config = loadAyatiRuntimeConfig({
      AYATI_HTTP_API_TOKEN: "   ",
      AYATI_PYTHON_INTERPRETER: "   ",
    });

    expect(config.http.apiToken).toBeUndefined();
    expect(config.python.interpreterPath).toBeUndefined();
  });
});
