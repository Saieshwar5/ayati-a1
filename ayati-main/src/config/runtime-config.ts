import type { LoopConfig } from "../ivec/types.js";

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 8081;
export const DEFAULT_HTTP_ALLOW_ORIGIN = "*";
export const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_DOCUMENT_EMBED_BATCH_SIZE = 32;
export const DEFAULT_DOCUMENT_VECTOR_MIN_CHUNKS = 40;
export const DEFAULT_AGENT_MAX_SELECTED_TOOLS = 12;

export interface HttpRuntimeConfig {
  host: string;
  port: number;
  allowOrigin: string;
  apiToken?: string;
  maxUploadBytes: number;
}

export interface DocumentRuntimeConfig {
  vectorEnabled: boolean;
  embedBatchSize: number;
  vectorMinChunks: number;
}

export interface PythonRuntimeConfig {
  interpreterPath?: string;
}

export interface LearningRuntimeConfig {
  apiBaseUrl: string;
}

export interface AgentRuntimeConfig {
  loopConfig: Partial<LoopConfig>;
}

export interface AyatiRuntimeConfig {
  http: HttpRuntimeConfig;
  documents: DocumentRuntimeConfig;
  python: PythonRuntimeConfig;
  learning: LearningRuntimeConfig;
  agent: AgentRuntimeConfig;
}

export function loadAyatiRuntimeConfig(env: NodeJS.ProcessEnv = process.env): AyatiRuntimeConfig {
  const http = loadHttpRuntimeConfig(env);

  return {
    http,
    documents: loadDocumentRuntimeConfig(env),
    python: loadPythonRuntimeConfig(env),
    learning: loadLearningRuntimeConfig(env, http),
    agent: loadAgentRuntimeConfig(env),
  };
}

export function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function loadHttpRuntimeConfig(env: NodeJS.ProcessEnv): HttpRuntimeConfig {
  return {
    host: env["AYATI_HTTP_HOST"]?.trim() || env["AYATI_UPLOAD_HOST"]?.trim() || DEFAULT_HTTP_HOST,
    port: parsePositiveInt(env["AYATI_HTTP_PORT"] ?? env["AYATI_UPLOAD_PORT"], DEFAULT_HTTP_PORT),
    allowOrigin: env["AYATI_HTTP_ALLOW_ORIGIN"]?.trim()
      || env["AYATI_UPLOAD_ALLOW_ORIGIN"]?.trim()
      || DEFAULT_HTTP_ALLOW_ORIGIN,
    maxUploadBytes: parsePositiveInt(env["AYATI_UPLOAD_MAX_BYTES"], DEFAULT_UPLOAD_MAX_BYTES),
    ...(trimOptional(env["AYATI_HTTP_API_TOKEN"]) ? { apiToken: trimOptional(env["AYATI_HTTP_API_TOKEN"]) } : {}),
  };
}

function loadDocumentRuntimeConfig(env: NodeJS.ProcessEnv): DocumentRuntimeConfig {
  return {
    vectorEnabled: !isEnvFalse(env["AYATI_DOCUMENT_VECTOR_ENABLED"]),
    embedBatchSize: parsePositiveInt(env["AYATI_DOCUMENT_EMBED_BATCH_SIZE"], DEFAULT_DOCUMENT_EMBED_BATCH_SIZE),
    vectorMinChunks: parsePositiveInt(env["AYATI_DOCUMENT_VECTOR_MIN_CHUNKS"], DEFAULT_DOCUMENT_VECTOR_MIN_CHUNKS),
  };
}

function loadPythonRuntimeConfig(env: NodeJS.ProcessEnv): PythonRuntimeConfig {
  return {
    ...(trimOptional(env["AYATI_PYTHON_INTERPRETER"]) ? { interpreterPath: trimOptional(env["AYATI_PYTHON_INTERPRETER"]) } : {}),
  };
}

function loadLearningRuntimeConfig(env: NodeJS.ProcessEnv, http: HttpRuntimeConfig): LearningRuntimeConfig {
  return {
    apiBaseUrl: trimOptional(env["AYATI_LEARNING_API_BASE"])
      ?? `http://${hostForLocalClient(http.host)}:${http.port}`,
  };
}

function loadAgentRuntimeConfig(env: NodeJS.ProcessEnv): AgentRuntimeConfig {
  const maxSelectedTools = parsePositiveInt(
    env["AYATI_AGENT_MAX_SELECTED_TOOLS"],
    DEFAULT_AGENT_MAX_SELECTED_TOOLS,
  );

  return {
    loopConfig: {
      maxSelectedTools,
    },
  };
}

function isEnvFalse(rawValue: string | undefined): boolean {
  return /^(?:0|false|no|off)$/i.test(rawValue ?? "");
}

function hostForLocalClient(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
