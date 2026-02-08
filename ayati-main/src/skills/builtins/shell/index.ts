import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";

const execAsync = promisify(exec);

type ShellMode = "off" | "allowlist" | "full";

interface ShellExecInput {
  cmd: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

function parseMode(raw: string | undefined): ShellMode {
  if (raw === "off" || raw === "allowlist" || raw === "full") {
    return raw;
  }
  return "full";
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parsePrefixes(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function commandPrefix(cmd: string): string {
  const trimmed = cmd.trim();
  if (trimmed.length === 0) return "";
  const [first] = trimmed.split(/\s+/);
  return first ?? "";
}

function validateInput(input: unknown): ShellExecInput | ToolResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Invalid input: expected object." };
  }

  const v = input as Partial<ShellExecInput>;
  if (typeof v.cmd !== "string" || v.cmd.trim().length === 0) {
    return { ok: false, error: "Invalid input: cmd must be a non-empty string." };
  }

  if (v.cwd !== undefined && typeof v.cwd !== "string") {
    return { ok: false, error: "Invalid input: cwd must be a string when provided." };
  }

  if (v.timeoutMs !== undefined && (!Number.isFinite(v.timeoutMs) || v.timeoutMs <= 0)) {
    return { ok: false, error: "Invalid input: timeoutMs must be a positive number." };
  }

  if (v.maxOutputChars !== undefined && (!Number.isFinite(v.maxOutputChars) || v.maxOutputChars <= 0)) {
    return { ok: false, error: "Invalid input: maxOutputChars must be a positive number." };
  }

  return {
    cmd: v.cmd,
    cwd: v.cwd,
    timeoutMs: v.timeoutMs,
    maxOutputChars: v.maxOutputChars,
  };
}

export const shellExecTool: ToolDefinition = {
  name: "shell.exec",
  description: "Execute a shell command with runtime-configurable access controls.",
  inputSchema: {
    type: "object",
    required: ["cmd"],
    properties: {
      cmd: { type: "string" },
      cwd: { type: "string" },
      timeoutMs: { type: "number" },
      maxOutputChars: { type: "number" },
    },
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateInput(input);
    if ("ok" in parsed) {
      return parsed;
    }

    const enabled = parseBool(process.env["SHELL_TOOL_ENABLED"], true);
    if (!enabled) {
      return { ok: false, error: "shell.exec is disabled by SHELL_TOOL_ENABLED." };
    }

    const mode = parseMode(process.env["SHELL_TOOL_MODE"]);
    if (mode === "off") {
      return { ok: false, error: "shell.exec is disabled by SHELL_TOOL_MODE=off." };
    }

    const prefix = commandPrefix(parsed.cmd);
    const allowedPrefixes = parsePrefixes(process.env["SHELL_TOOL_ALLOWED_PREFIXES"]);
    if (mode === "allowlist" && !allowedPrefixes.includes(prefix)) {
      return {
        ok: false,
        error: `Command prefix not allowed in allowlist mode: ${prefix || "<empty>"}`,
      };
    }

    const timeoutMs = Math.min(parseNumber(process.env["SHELL_TOOL_TIMEOUT_MS"], 15_000), 120_000);
    const maxOutputChars = Math.min(
      parseNumber(process.env["SHELL_TOOL_MAX_OUTPUT_CHARS"], 20_000),
      200_000,
    );

    const allowAnyCwd = parseBool(process.env["SHELL_TOOL_ALLOW_ANY_CWD"], true);
    const cwd = parsed.cwd;
    if (!allowAnyCwd && cwd && !cwd.startsWith(process.cwd())) {
      return {
        ok: false,
        error: "cwd is outside the workspace and SHELL_TOOL_ALLOW_ANY_CWD is false.",
      };
    }

    const start = Date.now();

    try {
      const { stdout, stderr } = await execAsync(parsed.cmd, {
        cwd,
        timeout: parsed.timeoutMs ?? timeoutMs,
        shell: "/bin/bash",
        maxBuffer: Math.max(1_000_000, maxOutputChars * 4),
      });

      const combined = [stdout, stderr].filter((s) => s.length > 0).join("\n").trim();
      const truncated = combined.length > (parsed.maxOutputChars ?? maxOutputChars);
      const cap = parsed.maxOutputChars ?? maxOutputChars;
      const output = truncated
        ? `${combined.slice(0, cap)}\n...[truncated]`
        : combined;

      return {
        ok: true,
        output,
        meta: {
          durationMs: Date.now() - start,
          truncated,
          mode,
          commandPrefix: prefix,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown shell execution error";
      return {
        ok: false,
        error: message,
        meta: {
          durationMs: Date.now() - start,
          mode,
          commandPrefix: prefix,
        },
      };
    }
  },
};

const SHELL_PROMPT_BLOCK = [
  "Shell Skill is available.",
  "Use shell.exec when terminal execution is needed.",
  "Prefer concise, safe commands and summarize results clearly.",
  "If command output is large, return a concise summary.",
].join("\n");

const shellSkill: SkillDefinition = {
  id: "shell",
  version: "1.0.0",
  description: "Run shell commands via shell.exec.",
  promptBlock: SHELL_PROMPT_BLOCK,
  tools: [shellExecTool],
};

export default shellSkill;
