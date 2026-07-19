import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoopConfig } from "../ivec/types.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 8081;
export const DEFAULT_HTTP_ALLOW_ORIGIN = "*";
export const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const DEFAULT_DOCUMENT_EMBED_BATCH_SIZE = 32;
export const DEFAULT_DOCUMENT_VECTOR_MIN_CHUNKS = 40;
export const DEFAULT_AGENT_MAX_SELECTED_TOOLS = 15;
export const DEFAULT_AYATI_ROOT_DIR = resolve(projectRoot, "ayati");
export const DEFAULT_WORKSPACE_DIR = join(DEFAULT_AYATI_ROOT_DIR, "workspace");
export const DEFAULT_GIT_CONTEXT_TIMEZONE = "Asia/Kolkata";
export const DEFAULT_GIT_CONTEXT_AGENT_ID = "local";
export const DEFAULT_GIT_CONTEXT_START_TIMEOUT_MS = 10_000;
export const DEFAULT_GIT_CONTEXT_STOP_TIMEOUT_MS = 10_000;
export const DEFAULT_GIT_CONTEXT_REQUEST_TIMEOUT_MS = 30_000;

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

export interface AgentRuntimeConfig {
  loopConfig: Partial<LoopConfig>;
}

export interface WorkspaceRuntimeConfig {
  root: string;
}

export interface GitContextRuntimeConfig {
  rootDirectory: string;
  databasePath: string;
  socketPath: string;
  managed: boolean;
  startTimeoutMs: number;
  stopTimeoutMs: number;
  requestTimeoutMs: number;
  timezone: string;
  agentId: string;
}

export interface AyatiRuntimeConfig {
  http: HttpRuntimeConfig;
  documents: DocumentRuntimeConfig;
  python: PythonRuntimeConfig;
  agent: AgentRuntimeConfig;
  workspace: WorkspaceRuntimeConfig;
  gitContext: GitContextRuntimeConfig;
}

export function loadAyatiRuntimeConfig(env: NodeJS.ProcessEnv = process.env): AyatiRuntimeConfig {
  const http = loadHttpRuntimeConfig(env);
  const rootDirectory = resolveAyatiRootDir(env["AYATI_ROOT_DIR"]);
  const workspace = loadWorkspaceRuntimeConfig(rootDirectory);

  return {
    http,
    documents: loadDocumentRuntimeConfig(env),
    python: loadPythonRuntimeConfig(env),
    agent: loadAgentRuntimeConfig(env),
    workspace,
    gitContext: loadGitContextRuntimeConfig(env, rootDirectory),
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
    host: env["AYATI_HTTP_HOST"]?.trim() || DEFAULT_HTTP_HOST,
    port: parsePositiveInt(env["AYATI_HTTP_PORT"], DEFAULT_HTTP_PORT),
    allowOrigin: env["AYATI_HTTP_ALLOW_ORIGIN"]?.trim() || DEFAULT_HTTP_ALLOW_ORIGIN,
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

function loadWorkspaceRuntimeConfig(rootDirectory: string): WorkspaceRuntimeConfig {
  return {
    root: join(rootDirectory, "workspace"),
  };
}

function loadGitContextRuntimeConfig(
  env: NodeJS.ProcessEnv,
  rootDirectory: string,
): GitContextRuntimeConfig {
  return {
    rootDirectory,
    databasePath: resolveConfiguredPath(
      env["AYATI_GIT_CONTEXT_DATABASE"],
      join(rootDirectory, ".ayati", "context.db"),
    ),
    socketPath: resolveConfiguredPath(
      env["AYATI_GIT_CONTEXT_SOCKET"],
      join(rootDirectory, ".ayati", "git-context.sock"),
    ),
    managed: !isEnvFalse(env["AYATI_GIT_CONTEXT_MANAGED"]),
    startTimeoutMs: parsePositiveInt(
      env["AYATI_GIT_CONTEXT_START_TIMEOUT_MS"],
      DEFAULT_GIT_CONTEXT_START_TIMEOUT_MS,
    ),
    stopTimeoutMs: parsePositiveInt(
      env["AYATI_GIT_CONTEXT_STOP_TIMEOUT_MS"],
      DEFAULT_GIT_CONTEXT_STOP_TIMEOUT_MS,
    ),
    requestTimeoutMs: parsePositiveInt(
      env["AYATI_GIT_CONTEXT_REQUEST_TIMEOUT_MS"],
      DEFAULT_GIT_CONTEXT_REQUEST_TIMEOUT_MS,
    ),
    timezone: trimOptional(env["AYATI_GIT_CONTEXT_TIMEZONE"]) ?? DEFAULT_GIT_CONTEXT_TIMEZONE,
    agentId: trimOptional(env["AYATI_GIT_CONTEXT_AGENT_ID"]) ?? DEFAULT_GIT_CONTEXT_AGENT_ID,
  };
}

function resolveConfiguredPath(rawValue: string | undefined, fallback: string): string {
  const normalized = normalizeSpecialPath(rawValue ?? "");
  if (!normalized) return fallback;
  return isAbsolute(normalized) ? resolve(normalized) : resolve(projectRoot, normalized);
}

export function resolveAyatiRootDir(rawValue: string | undefined): string {
  const normalized = normalizeSpecialPath(rawValue ?? "");
  if (normalized.length === 0) {
    return DEFAULT_AYATI_ROOT_DIR;
  }
  if (isAbsolute(normalized)) {
    return resolve(normalized);
  }
  return resolve(projectRoot, normalized);
}

function isEnvFalse(rawValue: string | undefined): boolean {
  return /^(?:0|false|no|off)$/i.test(rawValue ?? "");
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSpecialPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}
