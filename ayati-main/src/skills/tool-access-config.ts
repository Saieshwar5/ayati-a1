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

export interface ToolAccessConfig {
  global: GlobalToolPolicy;
  tools: Record<string, unknown>;
}

// ── Defaults ───────────────────────────────────────────────────────

const DEFAULT_GLOBAL: GlobalToolPolicy = {
  enabled: true,
  mode: "full",
  allowedTools: [],
};

const DEFAULT_SHELL: ShellToolPolicy = {
  enabled: true,
  mode: "full",
  allowedPrefixes: [],
  timeoutMs: 15_000,
  maxOutputChars: 20_000,
  allowAnyCwd: true,
};

const SHELL_TIMEOUT_CAP = 120_000;
const SHELL_OUTPUT_CAP = 200_000;

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

function parseMode(raw: string | undefined): ToolAccessMode {
  if (raw === "off" || raw === "allowlist" || raw === "full") return raw;
  return "full";
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

// ── Env-var fallback ───────────────────────────────────────────────

function buildConfigFromEnv(): ToolAccessConfig {
  return {
    global: {
      enabled: parseBool(process.env["TOOLS_ENABLED"], true),
      mode: parseMode(process.env["TOOLS_MODE"]),
      allowedTools: parseList(process.env["TOOLS_ALLOWED"]),
    },
    tools: {
      shell: {
        enabled: parseBool(process.env["SHELL_TOOL_ENABLED"], true),
        mode: parseMode(process.env["SHELL_TOOL_MODE"]),
        allowedPrefixes: parseList(process.env["SHELL_TOOL_ALLOWED_PREFIXES"]),
        timeoutMs: parseNumber(process.env["SHELL_TOOL_TIMEOUT_MS"], 15_000),
        maxOutputChars: parseNumber(process.env["SHELL_TOOL_MAX_OUTPUT_CHARS"], 20_000),
        allowAnyCwd: parseBool(process.env["SHELL_TOOL_ALLOW_ANY_CWD"], true),
      },
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
  currentConfig = { global: { ...DEFAULT_GLOBAL }, tools: {} };
}
