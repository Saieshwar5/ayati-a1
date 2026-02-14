import { watchFile, unwatchFile } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFile } from "../context/loaders/io.js";
import { devLog, devWarn } from "../shared/index.js";

// ── Types ──────────────────────────────────────────────────────────

export type ToolAccessMode = "off" | "allowlist" | "full";

export interface GlobalToolPolicy {
  enabled: boolean;
  mode: ToolAccessMode;
  allowedTools: string[];
}

export interface ShellToolPolicy {
  enabled: boolean;
  mode: ToolAccessMode;
  allowedPrefixes: string[];
  timeoutMs: number;
  maxOutputChars: number;
  allowAnyCwd: boolean;
}

export interface FilesystemGuardrailsPolicy {
  enabled: boolean;
  allowedReadRoots: string[];
  allowedWriteRoots: string[];
  protectedPaths: string[];
  protectedGlobs: string[];
  requireConfirmationFor: string[];
  maxListEntries: number;
  maxListDepth: number;
  maxSearchResults: number;
  maxSearchDepth: number;
}

export interface ShellGuardrailsPolicy {
  enabled: boolean;
  allowAnyCwd: boolean;
  profile: "read_only" | "developer" | "power_user";
  readOnlyPrefixes: string[];
  developerPrefixes: string[];
  powerUserPrefixes: string[];
  allowedPrefixes: string[];
  denyPrefixes: string[];
  denyPatterns: string[];
  denyOperators: string[];
  destructivePrefixes: string[];
  destructivePatterns: string[];
  requireConfirmationFor: string[];
  allowedScriptExtensions: string[];
  maxScriptBytes: number;
  maxConcurrentSessions: number;
  sessionIdleTimeoutMs: number;
  maxSessionOutputChars: number;
}

export interface ConfirmationGuardrailsPolicy {
  enabled: boolean;
  tokenPrefix: string;
  ttlMs: number;
}

export interface AuditGuardrailsPolicy {
  enabled: boolean;
  logDecisions: boolean;
}

export interface GuardrailsPolicy {
  filesystem: FilesystemGuardrailsPolicy;
  shell: ShellGuardrailsPolicy;
  confirmation: ConfirmationGuardrailsPolicy;
  audit: AuditGuardrailsPolicy;
}

export interface ToolAccessGuardrailsConfig {
  filesystem?: Partial<FilesystemGuardrailsPolicy>;
  shell?: Partial<ShellGuardrailsPolicy>;
  confirmation?: Partial<ConfirmationGuardrailsPolicy>;
  audit?: Partial<AuditGuardrailsPolicy>;
}

export interface ToolAccessConfig {
  global: GlobalToolPolicy;
  tools: Record<string, unknown>;
  guardrails?: ToolAccessGuardrailsConfig;
}

// ── Defaults ───────────────────────────────────────────────────────

const DEFAULT_GLOBAL: GlobalToolPolicy = {
  enabled: true,
  mode: "full",
  allowedTools: [],
};

const DEFAULT_SHELL: ShellToolPolicy = {
  enabled: true,
  mode: "allowlist",
  allowedPrefixes: ["find", "fd", "rg", "ls", "cat", "pwd", "echo", "stat", "head", "tail"],
  timeoutMs: 15_000,
  maxOutputChars: 20_000,
  allowAnyCwd: false,
};

const SHELL_TIMEOUT_CAP = 120_000;
const SHELL_OUTPUT_CAP = 200_000;
const FS_LIST_ENTRIES_CAP = 10_000;
const FS_DEPTH_CAP = 32;
const FS_SEARCH_RESULTS_CAP = 10_000;
const CONFIRM_TTL_CAP = 60 * 60 * 1000;
const SCRIPT_BYTES_CAP = 10 * 1024 * 1024;
const SESSION_COUNT_CAP = 32;
const SESSION_IDLE_CAP = 60 * 60 * 1000;

const DEFAULT_FILESYSTEM_GUARDRAILS: FilesystemGuardrailsPolicy = {
  enabled: true,
  allowedReadRoots: ["/"],
  allowedWriteRoots: [process.cwd(), "/tmp"],
  protectedPaths: [
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/boot",
    "/lib",
    "/lib64",
    "/var/lib",
    "/root",
    "/dev",
    "/proc",
    "/sys",
  ],
  protectedGlobs: [],
  requireConfirmationFor: ["delete", "move_overwrite", "shell_destructive"],
  maxListEntries: 1000,
  maxListDepth: 8,
  maxSearchResults: 500,
  maxSearchDepth: 10,
};

const DEFAULT_SHELL_GUARDRAILS: ShellGuardrailsPolicy = {
  enabled: true,
  allowAnyCwd: false,
  profile: "developer",
  readOnlyPrefixes: [
    "find",
    "fd",
    "rg",
    "ls",
    "cat",
    "pwd",
    "echo",
    "stat",
    "head",
    "tail",
    "wc",
    "du",
    "ps",
    "env",
    "printenv",
    "which",
    "whoami",
  ],
  developerPrefixes: [
    "find",
    "fd",
    "rg",
    "ls",
    "cat",
    "pwd",
    "echo",
    "stat",
    "head",
    "tail",
    "wc",
    "du",
    "ps",
    "env",
    "printenv",
    "which",
    "whoami",
    "git",
    "docker",
    "curl",
    "bash",
    "sh",
    "make",
    "npm",
    "pnpm",
    "yarn",
    "node",
    "python",
    "python3",
    "go",
    "cargo",
    "rustc",
    "mv",
    "cp",
    "chmod",
    "chown",
  ],
  powerUserPrefixes: [
    "find",
    "fd",
    "rg",
    "ls",
    "cat",
    "pwd",
    "echo",
    "stat",
    "head",
    "tail",
    "wc",
    "du",
    "ps",
    "env",
    "printenv",
    "which",
    "whoami",
    "git",
    "docker",
    "curl",
    "bash",
    "sh",
    "make",
    "npm",
    "pnpm",
    "yarn",
    "node",
    "python",
    "python3",
    "go",
    "cargo",
    "rustc",
    "mv",
    "cp",
    "chmod",
    "chown",
    "kubectl",
    "helm",
    "terraform",
  ],
  allowedPrefixes: [],
  denyPrefixes: ["rm", "dd", "mkfs", "shutdown", "reboot", "poweroff", "init", "killall"],
  denyPatterns: [
    "\\brm\\s+[^\\n]*\\-rf\\b",
    "\\b:\\(\\)\\s*\\{\\s*:\\|:&\\s*\\};:\\b",
    "\\bcurl\\b[^\\n]*\\|\\s*(sh|bash)\\b",
    "\\bwget\\b[^\\n]*\\|\\s*(sh|bash)\\b",
  ],
  denyOperators: ["&&", "||", ";"],
  destructivePrefixes: ["mv", "cp", "chmod", "chown", "git", "docker"],
  destructivePatterns: [
    "\\bgit\\s+(push|reset|clean|rebase|revert)\\b",
    "\\bdocker\\s+(rm|rmi|system\\s+prune|container\\s+prune|image\\s+prune|volume\\s+prune)\\b",
    "\\b(chmod|chown)\\b",
  ],
  requireConfirmationFor: ["destructive", "script"],
  allowedScriptExtensions: [".sh", ".bash"],
  maxScriptBytes: 1024 * 1024,
  maxConcurrentSessions: 4,
  sessionIdleTimeoutMs: 10 * 60 * 1000,
  maxSessionOutputChars: 100_000,
};

const DEFAULT_CONFIRMATION_GUARDRAILS: ConfirmationGuardrailsPolicy = {
  enabled: true,
  tokenPrefix: "CONFIRM:",
  ttlMs: 5 * 60 * 1000,
};

const DEFAULT_AUDIT_GUARDRAILS: AuditGuardrailsPolicy = {
  enabled: true,
  logDecisions: true,
};

// ── Config file path ───────────────────────────────────────────────

const thisDir = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(thisDir, "..", "..", "context", "tool-access.json");

// ── Singleton state ────────────────────────────────────────────────

let currentConfig: ToolAccessConfig = { global: { ...DEFAULT_GLOBAL }, tools: {} };

// ── Env-var parsing helpers ────────────────────────────────────────

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function parseMode(raw: string | undefined, fallback: ToolAccessMode = "full"): ToolAccessMode {
  if (raw === "off" || raw === "allowlist" || raw === "full") return raw;
  return fallback;
}

function parseList(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseStringArray(input: unknown, fallback: string[]): string[] {
  if (!Array.isArray(input)) return [...fallback];
  return input
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function parseBoundedPositiveInt(input: unknown, fallback: number, cap: number): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) return fallback;
  return Math.min(Math.trunc(input), cap);
}

function parseGuardrails(raw: unknown): GuardrailsPolicy {
  const g = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const fs = (g["filesystem"] && typeof g["filesystem"] === "object")
    ? g["filesystem"] as Record<string, unknown>
    : {};
  const shell = (g["shell"] && typeof g["shell"] === "object")
    ? g["shell"] as Record<string, unknown>
    : {};
  const confirmation = (g["confirmation"] && typeof g["confirmation"] === "object")
    ? g["confirmation"] as Record<string, unknown>
    : {};
  const audit = (g["audit"] && typeof g["audit"] === "object")
    ? g["audit"] as Record<string, unknown>
    : {};

  return {
    filesystem: {
      enabled: typeof fs["enabled"] === "boolean" ? fs["enabled"] : DEFAULT_FILESYSTEM_GUARDRAILS.enabled,
      allowedReadRoots: parseStringArray(fs["allowedReadRoots"], DEFAULT_FILESYSTEM_GUARDRAILS.allowedReadRoots),
      allowedWriteRoots: parseStringArray(fs["allowedWriteRoots"], DEFAULT_FILESYSTEM_GUARDRAILS.allowedWriteRoots),
      protectedPaths: parseStringArray(fs["protectedPaths"], DEFAULT_FILESYSTEM_GUARDRAILS.protectedPaths),
      protectedGlobs: parseStringArray(fs["protectedGlobs"], DEFAULT_FILESYSTEM_GUARDRAILS.protectedGlobs),
      requireConfirmationFor: parseStringArray(
        fs["requireConfirmationFor"],
        DEFAULT_FILESYSTEM_GUARDRAILS.requireConfirmationFor,
      ),
      maxListEntries: parseBoundedPositiveInt(
        fs["maxListEntries"],
        DEFAULT_FILESYSTEM_GUARDRAILS.maxListEntries,
        FS_LIST_ENTRIES_CAP,
      ),
      maxListDepth: parseBoundedPositiveInt(
        fs["maxListDepth"],
        DEFAULT_FILESYSTEM_GUARDRAILS.maxListDepth,
        FS_DEPTH_CAP,
      ),
      maxSearchResults: parseBoundedPositiveInt(
        fs["maxSearchResults"],
        DEFAULT_FILESYSTEM_GUARDRAILS.maxSearchResults,
        FS_SEARCH_RESULTS_CAP,
      ),
      maxSearchDepth: parseBoundedPositiveInt(
        fs["maxSearchDepth"],
        DEFAULT_FILESYSTEM_GUARDRAILS.maxSearchDepth,
        FS_DEPTH_CAP,
      ),
    },
    shell: {
      enabled: typeof shell["enabled"] === "boolean" ? shell["enabled"] : DEFAULT_SHELL_GUARDRAILS.enabled,
      allowAnyCwd: typeof shell["allowAnyCwd"] === "boolean"
        ? shell["allowAnyCwd"]
        : DEFAULT_SHELL_GUARDRAILS.allowAnyCwd,
      profile: shell["profile"] === "read_only" || shell["profile"] === "developer" || shell["profile"] === "power_user"
        ? shell["profile"]
        : DEFAULT_SHELL_GUARDRAILS.profile,
      readOnlyPrefixes: parseStringArray(shell["readOnlyPrefixes"], DEFAULT_SHELL_GUARDRAILS.readOnlyPrefixes),
      developerPrefixes: parseStringArray(shell["developerPrefixes"], DEFAULT_SHELL_GUARDRAILS.developerPrefixes),
      powerUserPrefixes: parseStringArray(shell["powerUserPrefixes"], DEFAULT_SHELL_GUARDRAILS.powerUserPrefixes),
      allowedPrefixes: parseStringArray(shell["allowedPrefixes"], DEFAULT_SHELL_GUARDRAILS.allowedPrefixes),
      denyPrefixes: parseStringArray(shell["denyPrefixes"], DEFAULT_SHELL_GUARDRAILS.denyPrefixes),
      denyPatterns: parseStringArray(shell["denyPatterns"], DEFAULT_SHELL_GUARDRAILS.denyPatterns),
      denyOperators: parseStringArray(shell["denyOperators"], DEFAULT_SHELL_GUARDRAILS.denyOperators),
      destructivePrefixes: parseStringArray(shell["destructivePrefixes"], DEFAULT_SHELL_GUARDRAILS.destructivePrefixes),
      destructivePatterns: parseStringArray(shell["destructivePatterns"], DEFAULT_SHELL_GUARDRAILS.destructivePatterns),
      requireConfirmationFor: parseStringArray(
        shell["requireConfirmationFor"],
        DEFAULT_SHELL_GUARDRAILS.requireConfirmationFor,
      ),
      allowedScriptExtensions: parseStringArray(
        shell["allowedScriptExtensions"],
        DEFAULT_SHELL_GUARDRAILS.allowedScriptExtensions,
      ),
      maxScriptBytes: parseBoundedPositiveInt(
        shell["maxScriptBytes"],
        DEFAULT_SHELL_GUARDRAILS.maxScriptBytes,
        SCRIPT_BYTES_CAP,
      ),
      maxConcurrentSessions: parseBoundedPositiveInt(
        shell["maxConcurrentSessions"],
        DEFAULT_SHELL_GUARDRAILS.maxConcurrentSessions,
        SESSION_COUNT_CAP,
      ),
      sessionIdleTimeoutMs: parseBoundedPositiveInt(
        shell["sessionIdleTimeoutMs"],
        DEFAULT_SHELL_GUARDRAILS.sessionIdleTimeoutMs,
        SESSION_IDLE_CAP,
      ),
      maxSessionOutputChars: parseBoundedPositiveInt(
        shell["maxSessionOutputChars"],
        DEFAULT_SHELL_GUARDRAILS.maxSessionOutputChars,
        SHELL_OUTPUT_CAP,
      ),
    },
    confirmation: {
      enabled: typeof confirmation["enabled"] === "boolean"
        ? confirmation["enabled"]
        : DEFAULT_CONFIRMATION_GUARDRAILS.enabled,
      tokenPrefix: typeof confirmation["tokenPrefix"] === "string" && confirmation["tokenPrefix"].trim().length > 0
        ? confirmation["tokenPrefix"].trim()
        : DEFAULT_CONFIRMATION_GUARDRAILS.tokenPrefix,
      ttlMs: parseBoundedPositiveInt(
        confirmation["ttlMs"],
        DEFAULT_CONFIRMATION_GUARDRAILS.ttlMs,
        CONFIRM_TTL_CAP,
      ),
    },
    audit: {
      enabled: typeof audit["enabled"] === "boolean" ? audit["enabled"] : DEFAULT_AUDIT_GUARDRAILS.enabled,
      logDecisions: typeof audit["logDecisions"] === "boolean"
        ? audit["logDecisions"]
        : DEFAULT_AUDIT_GUARDRAILS.logDecisions,
    },
  };
}

// ── Env-var fallback ───────────────────────────────────────────────

function buildConfigFromEnv(): ToolAccessConfig {
  return {
    global: {
      enabled: parseBool(process.env["TOOLS_ENABLED"], true),
      mode: parseMode(process.env["TOOLS_MODE"], DEFAULT_GLOBAL.mode),
      allowedTools: parseList(process.env["TOOLS_ALLOWED"]),
    },
    tools: {
      shell: {
        enabled: parseBool(process.env["SHELL_TOOL_ENABLED"], true),
        mode: parseMode(process.env["SHELL_TOOL_MODE"], DEFAULT_SHELL.mode),
        allowedPrefixes: parseList(process.env["SHELL_TOOL_ALLOWED_PREFIXES"]),
        timeoutMs: parseNumber(process.env["SHELL_TOOL_TIMEOUT_MS"], 15_000),
        maxOutputChars: parseNumber(process.env["SHELL_TOOL_MAX_OUTPUT_CHARS"], 20_000),
        allowAnyCwd: parseBool(process.env["SHELL_TOOL_ALLOW_ANY_CWD"], DEFAULT_SHELL.allowAnyCwd),
      },
    },
    guardrails: {
      filesystem: { ...DEFAULT_FILESYSTEM_GUARDRAILS },
      shell: { ...DEFAULT_SHELL_GUARDRAILS },
      confirmation: { ...DEFAULT_CONFIRMATION_GUARDRAILS },
      audit: { ...DEFAULT_AUDIT_GUARDRAILS },
    },
  };
}

// ── Type guard ─────────────────────────────────────────────────────

function isToolAccessConfig(value: unknown): value is ToolAccessConfig {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  if (!obj["global"] || typeof obj["global"] !== "object") return false;
  const g = obj["global"] as Record<string, unknown>;
  if (typeof g["enabled"] !== "boolean") return false;
  if (g["mode"] !== "off" && g["mode"] !== "allowlist" && g["mode"] !== "full") return false;
  if (!Array.isArray(g["allowedTools"])) return false;

  if (!obj["tools"] || typeof obj["tools"] !== "object") return false;

  if (obj["guardrails"] !== undefined && typeof obj["guardrails"] !== "object") return false;

  return true;
}

// ── Public getters ─────────────────────────────────────────────────

export function getGlobalPolicy(): GlobalToolPolicy {
  return currentConfig.global;
}

export function getShellPolicy(): ShellToolPolicy {
  const raw = currentConfig.tools["shell"];
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SHELL };

  const s = raw as Record<string, unknown>;
  return {
    enabled: typeof s["enabled"] === "boolean" ? s["enabled"] : DEFAULT_SHELL.enabled,
    mode: (s["mode"] === "off" || s["mode"] === "allowlist" || s["mode"] === "full")
      ? s["mode"]
      : DEFAULT_SHELL.mode,
    allowedPrefixes: Array.isArray(s["allowedPrefixes"]) ? s["allowedPrefixes"] as string[] : DEFAULT_SHELL.allowedPrefixes,
    timeoutMs: Math.min(
      typeof s["timeoutMs"] === "number" && s["timeoutMs"] > 0 ? s["timeoutMs"] : DEFAULT_SHELL.timeoutMs,
      SHELL_TIMEOUT_CAP,
    ),
    maxOutputChars: Math.min(
      typeof s["maxOutputChars"] === "number" && s["maxOutputChars"] > 0 ? s["maxOutputChars"] : DEFAULT_SHELL.maxOutputChars,
      SHELL_OUTPUT_CAP,
    ),
    allowAnyCwd: typeof s["allowAnyCwd"] === "boolean" ? s["allowAnyCwd"] : DEFAULT_SHELL.allowAnyCwd,
  };
}

export function getGuardrailsPolicy(): GuardrailsPolicy {
  return parseGuardrails(currentConfig.guardrails);
}

export function getFilesystemGuardrailsPolicy(): FilesystemGuardrailsPolicy {
  return getGuardrailsPolicy().filesystem;
}

export function getShellGuardrailsPolicy(): ShellGuardrailsPolicy {
  return getGuardrailsPolicy().shell;
}

export function getConfirmationGuardrailsPolicy(): ConfirmationGuardrailsPolicy {
  return getGuardrailsPolicy().confirmation;
}

export function getAuditGuardrailsPolicy(): AuditGuardrailsPolicy {
  return getGuardrailsPolicy().audit;
}

export function isToolEnabled(toolName: string): boolean {
  const raw = currentConfig.tools[toolName];
  if (!raw || typeof raw !== "object") return true;
  const t = raw as Record<string, unknown>;
  return t["enabled"] !== false;
}

// ── Loader ─────────────────────────────────────────────────────────

export async function loadToolAccessConfig(): Promise<void> {
  const raw = await readJsonFile(CONFIG_PATH, "tool-access.json");

  if (raw === undefined) {
    devWarn("tool-access.json not found, falling back to env vars.");
    currentConfig = buildConfigFromEnv();
    return;
  }

  if (!isToolAccessConfig(raw)) {
    devWarn("tool-access.json has invalid shape, falling back to env vars.");
    currentConfig = buildConfigFromEnv();
    return;
  }

  currentConfig = raw;
  devLog("Loaded tool access config from tool-access.json");
}

// ── File watcher ───────────────────────────────────────────────────

export function startConfigWatcher(): void {
  watchFile(CONFIG_PATH, { interval: 2000 }, () => {
    void loadToolAccessConfig();
  });
}

export function stopConfigWatcher(): void {
  unwatchFile(CONFIG_PATH);
}

// ── Testing helpers ────────────────────────────────────────────────

export function _setConfigForTesting(config: ToolAccessConfig): void {
  currentConfig = config;
}

export function _resetConfigToDefault(): void {
  currentConfig = {
    global: { ...DEFAULT_GLOBAL },
    tools: {},
    guardrails: {
      filesystem: { ...DEFAULT_FILESYSTEM_GUARDRAILS },
      shell: { ...DEFAULT_SHELL_GUARDRAILS },
      confirmation: { ...DEFAULT_CONFIRMATION_GUARDRAILS },
      audit: { ...DEFAULT_AUDIT_GUARDRAILS },
    },
  };
}
