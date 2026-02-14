import { exec, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { extname, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";
import { getShellPolicy } from "../../tool-access-config.js";
import {
  enforceShellGuard,
  enforceShellScriptPath,
  getShellCapabilities,
  enforceShellScriptConfirmation,
} from "../../guardrails/index.js";

const execAsync = promisify(exec);

interface ShellExecInput {
  cmd: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  confirmationToken?: string;
}

interface ShellRunScriptInput {
  scriptPath: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  confirmationToken?: string;
}

interface ShellSessionStartInput {
  cmd: string;
  cwd?: string;
  waitMs?: number;
  maxOutputChars?: number;
  confirmationToken?: string;
}

interface ShellSessionWriteInput {
  sessionId: string;
  input?: string;
  closeStdin?: boolean;
  signal?: "SIGINT" | "SIGTERM" | "SIGKILL";
  waitMs?: number;
}

interface ShellSessionCloseInput {
  sessionId: string;
  force?: boolean;
  waitMs?: number;
}

interface ShellSessionState {
  id: string;
  process: ChildProcessWithoutNullStreams;
  pendingOutput: string;
  fullOutput: string;
  maxOutputChars: number;
  createdAt: number;
  lastActiveAt: number;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  closePromise: Promise<void>;
}

const shellSessions = new Map<string, ShellSessionState>();
let nextSessionCounter = 1;

function commandPrefix(cmd: string): string {
  const trimmed = cmd.trim();
  if (trimmed.length === 0) return "";
  const [first] = trimmed.split(/\s+/);
  return first ?? "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function appendCapped(current: string, incoming: string, cap: number): string {
  if (incoming.length === 0) return current;
  const combined = current + incoming;
  if (combined.length <= cap) return combined;
  return combined.slice(combined.length - cap);
}

function toOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter((v) => v.length > 0).join("\n").trim();
}

function capToPolicy(inputCap: number | undefined, policyCap: number): number {
  if (inputCap === undefined) return policyCap;
  if (!Number.isFinite(inputCap) || inputCap <= 0) return policyCap;
  return Math.min(Math.trunc(inputCap), policyCap);
}

function waitToPolicy(inputWaitMs: number | undefined, fallback: number): number {
  if (inputWaitMs === undefined) return fallback;
  if (!Number.isFinite(inputWaitMs) || inputWaitMs < 0) return fallback;
  return Math.min(Math.trunc(inputWaitMs), 3000);
}

function activeSessionCount(): number {
  let count = 0;
  for (const session of shellSessions.values()) {
    if (!session.exited) count += 1;
  }
  return count;
}

function nextSessionId(): string {
  const id = nextSessionCounter;
  nextSessionCounter += 1;
  return `shell_${Date.now().toString(36)}_${id}`;
}

function consumePendingOutput(session: ShellSessionState): string {
  const out = session.pendingOutput;
  session.pendingOutput = "";
  return out.trim();
}

function ensureSessionNotIdle(session: ShellSessionState): ToolResult | null {
  const caps = getShellCapabilities();
  if (session.exited) return null;
  const idleMs = Date.now() - session.lastActiveAt;
  if (idleMs <= caps.sessionIdleTimeoutMs) return null;
  session.process.kill("SIGTERM");
  session.exited = true;
  return { ok: false, error: "Session expired due to inactivity. Start a new session." };
}

function validateStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function validateShellExecInput(input: unknown): ShellExecInput | ToolResult {
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
  if (v.confirmationToken !== undefined && typeof v.confirmationToken !== "string") {
    return { ok: false, error: "Invalid input: confirmationToken must be a string when provided." };
  }
  return {
    cmd: v.cmd,
    cwd: v.cwd,
    timeoutMs: v.timeoutMs,
    maxOutputChars: v.maxOutputChars,
    confirmationToken: v.confirmationToken,
  };
}

function validateRunScriptInput(input: unknown): ShellRunScriptInput | ToolResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Invalid input: expected object." };
  }
  const v = input as Partial<ShellRunScriptInput>;
  if (typeof v.scriptPath !== "string" || v.scriptPath.trim().length === 0) {
    return { ok: false, error: "Invalid input: scriptPath must be a non-empty string." };
  }
  if (v.args !== undefined && !validateStringArray(v.args)) {
    return { ok: false, error: "Invalid input: args must be an array of strings when provided." };
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
  if (v.confirmationToken !== undefined && typeof v.confirmationToken !== "string") {
    return { ok: false, error: "Invalid input: confirmationToken must be a string when provided." };
  }
  return {
    scriptPath: v.scriptPath,
    args: v.args,
    cwd: v.cwd,
    timeoutMs: v.timeoutMs,
    maxOutputChars: v.maxOutputChars,
    confirmationToken: v.confirmationToken,
  };
}

function validateSessionStartInput(input: unknown): ShellSessionStartInput | ToolResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Invalid input: expected object." };
  }
  const v = input as Partial<ShellSessionStartInput>;
  if (typeof v.cmd !== "string" || v.cmd.trim().length === 0) {
    return { ok: false, error: "Invalid input: cmd must be a non-empty string." };
  }
  if (v.cwd !== undefined && typeof v.cwd !== "string") {
    return { ok: false, error: "Invalid input: cwd must be a string when provided." };
  }
  if (v.waitMs !== undefined && (!Number.isFinite(v.waitMs) || v.waitMs < 0)) {
    return { ok: false, error: "Invalid input: waitMs must be a non-negative number." };
  }
  if (v.maxOutputChars !== undefined && (!Number.isFinite(v.maxOutputChars) || v.maxOutputChars <= 0)) {
    return { ok: false, error: "Invalid input: maxOutputChars must be a positive number." };
  }
  if (v.confirmationToken !== undefined && typeof v.confirmationToken !== "string") {
    return { ok: false, error: "Invalid input: confirmationToken must be a string when provided." };
  }
  return {
    cmd: v.cmd,
    cwd: v.cwd,
    waitMs: v.waitMs,
    maxOutputChars: v.maxOutputChars,
    confirmationToken: v.confirmationToken,
  };
}

function validateSessionWriteInput(input: unknown): ShellSessionWriteInput | ToolResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Invalid input: expected object." };
  }
  const v = input as Partial<ShellSessionWriteInput>;
  if (typeof v.sessionId !== "string" || v.sessionId.trim().length === 0) {
    return { ok: false, error: "Invalid input: sessionId must be a non-empty string." };
  }
  if (v.input !== undefined && typeof v.input !== "string") {
    return { ok: false, error: "Invalid input: input must be a string when provided." };
  }
  if (v.closeStdin !== undefined && typeof v.closeStdin !== "boolean") {
    return { ok: false, error: "Invalid input: closeStdin must be a boolean when provided." };
  }
  if (v.signal !== undefined && v.signal !== "SIGINT" && v.signal !== "SIGTERM" && v.signal !== "SIGKILL") {
    return { ok: false, error: "Invalid input: unsupported signal." };
  }
  if (v.waitMs !== undefined && (!Number.isFinite(v.waitMs) || v.waitMs < 0)) {
    return { ok: false, error: "Invalid input: waitMs must be a non-negative number." };
  }
  return {
    sessionId: v.sessionId,
    input: v.input,
    closeStdin: v.closeStdin,
    signal: v.signal,
    waitMs: v.waitMs,
  };
}

function validateSessionCloseInput(input: unknown): ShellSessionCloseInput | ToolResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Invalid input: expected object." };
  }
  const v = input as Partial<ShellSessionCloseInput>;
  if (typeof v.sessionId !== "string" || v.sessionId.trim().length === 0) {
    return { ok: false, error: "Invalid input: sessionId must be a non-empty string." };
  }
  if (v.force !== undefined && typeof v.force !== "boolean") {
    return { ok: false, error: "Invalid input: force must be a boolean when provided." };
  }
  if (v.waitMs !== undefined && (!Number.isFinite(v.waitMs) || v.waitMs < 0)) {
    return { ok: false, error: "Invalid input: waitMs must be a non-negative number." };
  }
  return {
    sessionId: v.sessionId,
    force: v.force,
    waitMs: v.waitMs,
  };
}

async function runExecCommand(
  cmd: string,
  cwd: string | undefined,
  timeoutMs: number,
  maxOutputChars: number,
): Promise<ToolResult> {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      timeout: timeoutMs,
      shell: "/bin/bash",
      maxBuffer: Math.max(1_000_000, maxOutputChars * 4),
    });
    const combined = toOutput(stdout, stderr);
    const truncated = combined.length > maxOutputChars;
    const output = truncated ? `${combined.slice(0, maxOutputChars)}\n...[truncated]` : combined;
    return {
      ok: true,
      output,
      meta: { durationMs: Date.now() - start, truncated },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown shell execution error";
    return {
      ok: false,
      error: message,
      meta: { durationMs: Date.now() - start },
    };
  }
}

async function runProcessCommand(
  command: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  maxOutputChars: number,
): Promise<ToolResult> {
  const start = Date.now();
  return await new Promise<ToolResult>((resolveResult) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;

    const finish = (result: ToolResult): void => {
      if (finished) return;
      finished = true;
      resolveResult(result);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendCapped(stdout, chunk.toString(), maxOutputChars);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendCapped(stderr, chunk.toString(), maxOutputChars);
    });

    child.on("error", (err: Error) => {
      clearTimeout(timeout);
      finish({
        ok: false,
        error: err.message,
        meta: { durationMs: Date.now() - start },
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const output = toOutput(stdout, stderr);
      if (timedOut) {
        finish({
          ok: false,
          error: "Command timed out and was terminated.",
          output,
          meta: { durationMs: Date.now() - start, signal },
        });
        return;
      }
      if (code === 0) {
        finish({
          ok: true,
          output,
          meta: { durationMs: Date.now() - start, exitCode: code },
        });
        return;
      }
      finish({
        ok: false,
        error: `Process exited with code ${code ?? "unknown"}.`,
        output,
        meta: { durationMs: Date.now() - start, exitCode: code, signal },
      });
    });
  });
}

async function preflightShellCommand(
  cmd: string,
  cwd: string | undefined,
  confirmationToken: string | undefined,
): Promise<{ ok: true; resolvedCwd?: string } | { ok: false; result: ToolResult }> {
  const policy = getShellPolicy();
  if (!policy.enabled) {
    return { ok: false, result: { ok: false, error: "shell is disabled (enabled=false)." } };
  }
  if (policy.mode === "off") {
    return { ok: false, result: { ok: false, error: "shell is disabled (mode=off)." } };
  }

  const prefix = commandPrefix(cmd);
  if (policy.mode === "allowlist" && !policy.allowedPrefixes.includes(prefix)) {
    return {
      ok: false,
      result: { ok: false, error: `Command prefix not allowed in allowlist mode: ${prefix || "<empty>"}` },
    };
  }

  if (!policy.allowAnyCwd && cwd && !resolvePath(cwd).startsWith(process.cwd())) {
    return {
      ok: false,
      result: { ok: false, error: "cwd is outside the workspace and allowAnyCwd is false." },
    };
  }

  const guard = await enforceShellGuard({
    cmd,
    cwd,
    confirmationToken,
  });
  if (!guard.ok) return { ok: false, result: guard.result };
  return { ok: true, resolvedCwd: guard.resolvedCwd };
}

export const shellExecTool: ToolDefinition = {
  name: "shell",
  description: "Execute a shell command with runtime-configurable access controls.",
  inputSchema: {
    type: "object",
    required: ["cmd"],
    properties: {
      cmd: { type: "string" },
      cwd: { type: "string" },
      timeoutMs: { type: "number" },
      maxOutputChars: { type: "number" },
      confirmationToken: { type: "string" },
    },
  },
  selectionHints: {
    tags: ["shell", "terminal", "command", "search", "find", "system"],
    aliases: ["shell_exec", "run_command", "terminal_command"],
    examples: ["find file in system", "run rg to search files", "list process output"],
    domain: "execution",
    priority: 15,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateShellExecInput(input);
    if ("ok" in parsed) {
      return parsed;
    }
    const policy = getShellPolicy();
    const preflight = await preflightShellCommand(parsed.cmd, parsed.cwd, parsed.confirmationToken);
    if (!preflight.ok) return preflight.result;

    const timeoutMs = capToPolicy(parsed.timeoutMs, policy.timeoutMs);
    const maxOutputChars = capToPolicy(parsed.maxOutputChars, policy.maxOutputChars);
    const result = await runExecCommand(parsed.cmd, preflight.resolvedCwd ?? parsed.cwd, timeoutMs, maxOutputChars);

    if (!result.meta) result.meta = {};
    result.meta["mode"] = policy.mode;
    result.meta["commandPrefix"] = commandPrefix(parsed.cmd);
    return result;
  },
};

export const shellRunScriptTool: ToolDefinition = {
  name: "shell_run_script",
  description: "Run a bash script from allowed roots with guardrails and confirmation support.",
  inputSchema: {
    type: "object",
    required: ["scriptPath"],
    properties: {
      scriptPath: { type: "string" },
      args: { type: "array", items: { type: "string" } },
      cwd: { type: "string" },
      timeoutMs: { type: "number" },
      maxOutputChars: { type: "number" },
      confirmationToken: { type: "string" },
    },
  },
  selectionHints: {
    tags: ["shell", "script", "bash", "automation"],
    aliases: ["run_script", "execute_script"],
    examples: ["run deploy.sh", "execute setup script"],
    domain: "execution",
    priority: 30,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateRunScriptInput(input);
    if ("ok" in parsed) return parsed;

    const policy = getShellPolicy();
    const capabilities = getShellCapabilities();
    const scriptPathInput = parsed.cwd ? resolvePath(parsed.cwd, parsed.scriptPath) : parsed.scriptPath;
    const scriptGuard = await enforceShellScriptPath(scriptPathInput);
    if (!scriptGuard.ok) return scriptGuard.result;

    const extension = extname(scriptGuard.resolvedPath).toLowerCase();
    if (!capabilities.allowedScriptExtensions.includes(extension)) {
      return {
        ok: false,
        error: `Script extension is not allowed: ${extension || "<none>"}`,
      };
    }

    const fileStats = await stat(scriptGuard.resolvedPath);
    if (!fileStats.isFile()) {
      return { ok: false, error: "scriptPath must point to a regular file." };
    }
    if (fileStats.size > capabilities.maxScriptBytes) {
      return { ok: false, error: `Script exceeds max size (${capabilities.maxScriptBytes} bytes).` };
    }

    const guardCmd = `bash ${scriptGuard.resolvedPath}`;
    const preflight = await preflightShellCommand(guardCmd, parsed.cwd, parsed.confirmationToken);
    if (!preflight.ok) return preflight.result;

    const scriptConfirm = enforceShellScriptConfirmation({
      scriptPath: scriptGuard.resolvedPath,
      args: parsed.args ?? [],
      cwd: preflight.resolvedCwd ?? parsed.cwd,
      confirmationToken: parsed.confirmationToken,
    });
    if (!scriptConfirm.ok) return scriptConfirm.result;

    const timeoutMs = capToPolicy(parsed.timeoutMs, policy.timeoutMs);
    const maxOutputChars = capToPolicy(parsed.maxOutputChars, policy.maxOutputChars);
    return await runProcessCommand(
      "bash",
      [scriptGuard.resolvedPath, ...(parsed.args ?? [])],
      preflight.resolvedCwd ?? parsed.cwd,
      timeoutMs,
      maxOutputChars,
    );
  },
};

export const shellSessionStartTool: ToolDefinition = {
  name: "shell_session_start",
  description: "Start an interactive shell session and return a sessionId.",
  inputSchema: {
    type: "object",
    required: ["cmd"],
    properties: {
      cmd: { type: "string" },
      cwd: { type: "string" },
      waitMs: { type: "number" },
      maxOutputChars: { type: "number" },
      confirmationToken: { type: "string" },
    },
  },
  selectionHints: {
    tags: ["shell", "interactive", "session"],
    aliases: ["terminal_session_start", "shell_start"],
    examples: ["start tail -f session", "start interactive command"],
    domain: "execution",
    priority: 28,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateSessionStartInput(input);
    if ("ok" in parsed) return parsed;

    const capabilities = getShellCapabilities();
    if (activeSessionCount() >= capabilities.maxConcurrentSessions) {
      return {
        ok: false,
        error: `Concurrent shell session limit reached (${capabilities.maxConcurrentSessions}).`,
      };
    }

    const preflight = await preflightShellCommand(parsed.cmd, parsed.cwd, parsed.confirmationToken);
    if (!preflight.ok) return preflight.result;

    const outputCap = capToPolicy(parsed.maxOutputChars, capabilities.maxSessionOutputChars);
    const process = spawn("/bin/bash", ["-lc", parsed.cmd], {
      cwd: preflight.resolvedCwd ?? parsed.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const sessionId = nextSessionId();
    let resolveClose: (() => void) | undefined;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const session: ShellSessionState = {
      id: sessionId,
      process,
      pendingOutput: "",
      fullOutput: "",
      maxOutputChars: outputCap,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      exited: false,
      exitCode: null,
      signal: null,
      closePromise,
    };

    const appendOutput = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      session.pendingOutput = appendCapped(session.pendingOutput, text, session.maxOutputChars);
      session.fullOutput = appendCapped(session.fullOutput, text, session.maxOutputChars);
      session.lastActiveAt = Date.now();
    };

    process.stdout.on("data", appendOutput);
    process.stderr.on("data", appendOutput);
    process.on("close", (code, signal) => {
      session.exited = true;
      session.exitCode = code;
      session.signal = signal;
      resolveClose?.();
    });
    process.on("error", (err: Error) => {
      session.exited = true;
      session.pendingOutput = appendCapped(session.pendingOutput, err.message, session.maxOutputChars);
      session.fullOutput = appendCapped(session.fullOutput, err.message, session.maxOutputChars);
      resolveClose?.();
    });

    shellSessions.set(sessionId, session);
    await sleep(waitToPolicy(parsed.waitMs, 150));
    const output = consumePendingOutput(session);
    return {
      ok: true,
      output,
      meta: {
        sessionId,
        running: !session.exited,
        createdAt: session.createdAt,
      },
    };
  },
};

export const shellSessionWriteTool: ToolDefinition = {
  name: "shell_session_write",
  description: "Write to an existing shell session stdin, optionally send signal, and read incremental output.",
  inputSchema: {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" },
      input: { type: "string" },
      closeStdin: { type: "boolean" },
      signal: { type: "string" },
      waitMs: { type: "number" },
    },
  },
  selectionHints: {
    tags: ["shell", "interactive", "session"],
    aliases: ["terminal_session_write", "shell_poll"],
    examples: ["poll interactive output", "send input to running command"],
    domain: "execution",
    priority: 27,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateSessionWriteInput(input);
    if ("ok" in parsed) return parsed;

    const session = shellSessions.get(parsed.sessionId);
    if (!session) return { ok: false, error: `Unknown shell session: ${parsed.sessionId}` };

    const idleError = ensureSessionNotIdle(session);
    if (idleError) return idleError;

    if (parsed.signal && !session.exited) {
      session.process.kill(parsed.signal);
    }
    if (parsed.input && !session.exited && !session.process.stdin.destroyed) {
      session.process.stdin.write(parsed.input);
    }
    if (parsed.closeStdin && !session.exited && !session.process.stdin.destroyed) {
      session.process.stdin.end();
    }

    session.lastActiveAt = Date.now();
    await sleep(waitToPolicy(parsed.waitMs, 120));
    const output = consumePendingOutput(session);

    return {
      ok: true,
      output,
      meta: {
        sessionId: session.id,
        running: !session.exited,
        exitCode: session.exitCode,
        signal: session.signal,
      },
    };
  },
};

export const shellSessionCloseTool: ToolDefinition = {
  name: "shell_session_close",
  description: "Close a shell session and return final output/status.",
  inputSchema: {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" },
      force: { type: "boolean" },
      waitMs: { type: "number" },
    },
  },
  selectionHints: {
    tags: ["shell", "interactive", "session"],
    aliases: ["terminal_session_close", "shell_stop"],
    examples: ["close shell session", "stop interactive command"],
    domain: "execution",
    priority: 27,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateSessionCloseInput(input);
    if ("ok" in parsed) return parsed;

    const session = shellSessions.get(parsed.sessionId);
    if (!session) return { ok: false, error: `Unknown shell session: ${parsed.sessionId}` };

    if (!session.exited) {
      session.process.kill(parsed.force ? "SIGKILL" : "SIGTERM");
      const waitMs = waitToPolicy(parsed.waitMs, 500);
      await Promise.race([session.closePromise, sleep(waitMs)]);
      if (!session.exited) {
        session.process.kill("SIGKILL");
        await Promise.race([session.closePromise, sleep(250)]);
      }
    }

    const output = consumePendingOutput(session);
    shellSessions.delete(session.id);

    return {
      ok: true,
      output,
      meta: {
        sessionId: session.id,
        exitCode: session.exitCode,
        signal: session.signal,
        running: false,
      },
    };
  },
};

export const shellCapabilitiesTool: ToolDefinition = {
  name: "shell_list_capabilities",
  description: "List active shell capabilities, profile, limits, and guardrail decisions.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  selectionHints: {
    tags: ["shell", "capabilities", "policy", "guardrails"],
    aliases: ["shell_capabilities", "shell_policy"],
    examples: ["what shell commands are allowed", "show shell guardrails"],
    domain: "execution",
    priority: 10,
  },
  async execute(): Promise<ToolResult> {
    const policy = getShellPolicy();
    const caps = getShellCapabilities();
    const lines = [
      `mode=${policy.mode}`,
      `profile=${caps.profile}`,
      `effective_allowed_prefixes=${caps.effectiveAllowedPrefixes.join(",")}`,
      `deny_prefixes=${caps.denyPrefixes.join(",")}`,
      `deny_operators=${caps.denyOperators.join(",")}`,
      `allowed_script_extensions=${caps.allowedScriptExtensions.join(",")}`,
      `max_script_bytes=${caps.maxScriptBytes}`,
      `max_concurrent_sessions=${caps.maxConcurrentSessions}`,
      `session_idle_timeout_ms=${caps.sessionIdleTimeoutMs}`,
      `active_sessions=${activeSessionCount()}`,
    ];
    return {
      ok: true,
      output: lines.join("\n"),
      meta: {
        mode: policy.mode,
        profile: caps.profile,
        allowedPrefixes: caps.effectiveAllowedPrefixes,
        denyPrefixes: caps.denyPrefixes,
      },
    };
  },
};

const SHELL_PROMPT_BLOCK = [
  "Shell Skill is available.",
  "Use shell for terminal execution, developer workflows, and orchestrating system tools.",
  "Use shell_run_script to execute project scripts safely.",
  "Use shell_session_start/shell_session_write/shell_session_close for interactive commands.",
  "Use shell_list_capabilities to inspect current guardrails and allowed commands.",
  "Prefer concise, safe commands and summarize results clearly.",
  "If command output is large, return a concise summary.",
].join("\n");

const shellSkill: SkillDefinition = {
  id: "shell",
  version: "1.1.0",
  description: "Run shell commands, scripts, and interactive terminal sessions with guardrails.",
  promptBlock: SHELL_PROMPT_BLOCK,
  tools: [
    shellExecTool,
    shellRunScriptTool,
    shellSessionStartTool,
    shellSessionWriteTool,
    shellSessionCloseTool,
    shellCapabilitiesTool,
  ],
};

export default shellSkill;
