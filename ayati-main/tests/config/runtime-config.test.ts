import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  DEFAULT_AGENT_MAX_SELECTED_TOOLS,
  DEFAULT_AYATI_ROOT_DIR,
  DEFAULT_DOCUMENT_EMBED_BATCH_SIZE,
  DEFAULT_DOCUMENT_VECTOR_MIN_CHUNKS,
  DEFAULT_GIT_CONTEXT_AGENT_ID,
  DEFAULT_GIT_CONTEXT_REQUEST_TIMEOUT_MS,
  DEFAULT_GIT_CONTEXT_START_TIMEOUT_MS,
  DEFAULT_GIT_CONTEXT_STOP_TIMEOUT_MS,
  DEFAULT_GIT_CONTEXT_TIMEZONE,
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
      documents: {
        vectorEnabled: true,
        embedBatchSize: DEFAULT_DOCUMENT_EMBED_BATCH_SIZE,
        vectorMinChunks: DEFAULT_DOCUMENT_VECTOR_MIN_CHUNKS,
      },
      python: {},
      agent: { loopConfig: { maxSelectedTools: DEFAULT_AGENT_MAX_SELECTED_TOOLS } },
      workspace: { root: DEFAULT_WORKSPACE_DIR },
      gitContext: {
        rootDirectory: DEFAULT_AYATI_ROOT_DIR,
        databasePath: join(DEFAULT_AYATI_ROOT_DIR, ".ayati", "context.db"),
        socketPath: join(DEFAULT_AYATI_ROOT_DIR, ".ayati", "git-context.sock"),
        managed: true,
        startTimeoutMs: DEFAULT_GIT_CONTEXT_START_TIMEOUT_MS,
        stopTimeoutMs: DEFAULT_GIT_CONTEXT_STOP_TIMEOUT_MS,
        requestTimeoutMs: DEFAULT_GIT_CONTEXT_REQUEST_TIMEOUT_MS,
        timezone: DEFAULT_GIT_CONTEXT_TIMEZONE,
        agentId: DEFAULT_GIT_CONTEXT_AGENT_ID,
      },
    });
  });

  it("loads explicit runtime values around one Ayati root", () => {
    const config = loadAyatiRuntimeConfig({
      AYATI_ROOT_DIR: " /tmp/ayati-runtime ",
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
      AYATI_GIT_CONTEXT_DATABASE: " /tmp/ayati-db/context.db ",
      AYATI_GIT_CONTEXT_SOCKET: " /tmp/ayati-context.sock ",
      AYATI_GIT_CONTEXT_MANAGED: "false",
      AYATI_GIT_CONTEXT_START_TIMEOUT_MS: "1200",
      AYATI_GIT_CONTEXT_STOP_TIMEOUT_MS: "1300",
      AYATI_GIT_CONTEXT_REQUEST_TIMEOUT_MS: "1400",
      AYATI_GIT_CONTEXT_TIMEZONE: " UTC ",
      AYATI_GIT_CONTEXT_AGENT_ID: " local-agent ",
    });

    expect(config.workspace.root).toBe("/tmp/ayati-runtime/workspace");
    expect(config.gitContext).toEqual({
      rootDirectory: "/tmp/ayati-runtime",
      databasePath: "/tmp/ayati-db/context.db",
      socketPath: "/tmp/ayati-context.sock",
      managed: false,
      startTimeoutMs: 1200,
      stopTimeoutMs: 1300,
      requestTimeoutMs: 1400,
      timezone: "UTC",
      agentId: "local-agent",
    });
    expect(config.http).toMatchObject({
      host: "0.0.0.0",
      port: 9090,
      allowOrigin: "https://app.example",
      apiToken: "local-token",
      maxUploadBytes: 4096,
    });
    expect(config.documents).toEqual({
      vectorEnabled: false,
      embedBatchSize: 64,
      vectorMinChunks: 12,
    });
    expect(config.python.interpreterPath).toBe("/usr/bin/python3");
    expect(config.agent.loopConfig.maxSelectedTools).toBe(5);
  });

  it("resolves a relative Ayati root from the package project root", () => {
    expect(resolveAyatiRootDir("custom-ayati")).toMatch(/\/ayati-main\/custom-ayati$/);
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
