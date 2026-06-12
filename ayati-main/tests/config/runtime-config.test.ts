import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCUMENT_EMBED_BATCH_SIZE,
  DEFAULT_DOCUMENT_VECTOR_MIN_CHUNKS,
  DEFAULT_AGENT_HARNESS_VERSION,
  DEFAULT_AGENT_V2_MAX_SELECTED_TOOLS,
  DEFAULT_HTTP_ALLOW_ORIGIN,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_UPLOAD_MAX_BYTES,
  loadAyatiRuntimeConfig,
  parsePositiveInt,
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
      learning: {
        apiBaseUrl: `http://${DEFAULT_HTTP_HOST}:${DEFAULT_HTTP_PORT}`,
      },
      agent: {
        loopConfig: {
          harnessVersion: DEFAULT_AGENT_HARNESS_VERSION,
          v2MaxSelectedTools: DEFAULT_AGENT_V2_MAX_SELECTED_TOOLS,
        },
      },
    });
  });

  it("loads explicit HTTP, document, Python, learning, and agent overrides", () => {
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
      AYATI_LEARNING_API_BASE: " http://learning.local:8081 ",
      AYATI_AGENT_HARNESS_VERSION: " v2 ",
      AYATI_AGENT_V2_MAX_SELECTED_TOOLS: "5",
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
      learning: {
        apiBaseUrl: "http://learning.local:8081",
      },
      agent: {
        loopConfig: {
          harnessVersion: "v2",
          v2MaxSelectedTools: 5,
        },
      },
    });
  });

  it("preserves legacy upload host, port, and CORS fallbacks", () => {
    const config = loadAyatiRuntimeConfig({
      AYATI_UPLOAD_HOST: " 192.168.1.25 ",
      AYATI_UPLOAD_PORT: "9091",
      AYATI_UPLOAD_ALLOW_ORIGIN: " https://legacy.example ",
    });

    expect(config.http.host).toBe("192.168.1.25");
    expect(config.http.port).toBe(9091);
    expect(config.http.allowOrigin).toBe("https://legacy.example");
    expect(config.learning.apiBaseUrl).toBe("http://192.168.1.25:9091");
  });

  it("uses local client host for wildcard HTTP hosts in the default learning API URL", () => {
    expect(loadAyatiRuntimeConfig({ AYATI_HTTP_HOST: "0.0.0.0" }).learning.apiBaseUrl)
      .toBe(`http://127.0.0.1:${DEFAULT_HTTP_PORT}`);
    expect(loadAyatiRuntimeConfig({ AYATI_HTTP_HOST: "::" }).learning.apiBaseUrl)
      .toBe(`http://127.0.0.1:${DEFAULT_HTTP_PORT}`);
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
    expect(config.agent.loopConfig.v2MaxSelectedTools).toBe(DEFAULT_AGENT_V2_MAX_SELECTED_TOOLS);
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
