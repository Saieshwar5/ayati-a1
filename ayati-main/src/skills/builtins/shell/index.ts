import { exec, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";
import {
  headTailBlocks,
  importantLineBlocks,
  makeBlock,
  renderContextObservation,
  splitLines,
  truncatePreserveLines,
  type ToolContextBlock,
  type ToolContextObservation,
} from "../../observations/context-observation.js";
import { resolveWorkspaceCwd } from "../../workspace-paths.js";
import { commonAnnotations, errorResult, failureV2, genericObjectOutputSchema, okResult, succeededContract, successV2 } from "../contract-helpers.js";

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_MAX_SESSION_OUTPUT_CHARS = 100_000;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 600_000; // 10 min

interface ShellExecInput {
  cmd: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

interface ShellRunScriptInput {
  scriptPath: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

interface ShellSessionStartInput {
  cmd: string;
  cwd?: string;
  waitMs?: number;
  maxOutputChars?: number;
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

interface ErrnoExceptionLike {
  code?: string;
}

interface ShellOutputSnapshot {
  stdout: string;
  stderr: string;
  output: string;
  truncated: boolean;
}

interface ShellCommandResultInput {
  ok: boolean;
  code: string;
  message: string;
  command: string;
  cwd?: string;
  stdout: string;
  stderr: string;
  output: string;
  truncated: boolean;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

const shellSessions = new Map<string, ShellSessionState>();
let nextSessionCounter = 1;

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

function buildOutputSnapshot(stdout: string, stderr: string, maxOutputChars: number): ShellOutputSnapshot {
  const combined = toOutput(stdout, stderr);
  const truncated = combined.length > maxOutputChars;
  return {
    stdout,
    stderr,
    output: truncated ? `${combined.slice(0, maxOutputChars)}\n...[truncated]` : combined,
    truncated,
  };
}

function getExecFailureOutput(err: unknown, maxOutputChars: number): ShellOutputSnapshot {
  const execError = err as { stdout?: string | Buffer; stderr?: string | Buffer };
  const stdout = typeof execError?.stdout === "string"
    ? execError.stdout
    : Buffer.isBuffer(execError?.stdout)
      ? execError.stdout.toString()
      : "";
  const stderr = typeof execError?.stderr === "string"
    ? execError.stderr
    : Buffer.isBuffer(execError?.stderr)
      ? execError.stderr.toString()
      : "";
  return buildOutputSnapshot(stdout, stderr, maxOutputChars);
}

function execErrorExitCode(err: unknown): number | null {
  const code = (err as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}

function execErrorSignal(err: unknown): string | null {
  const signal = (err as { signal?: unknown }).signal;
  return typeof signal === "string" ? signal : null;
}

function execErrorTimedOut(err: unknown, message: string): boolean {
  const killed = (err as { killed?: unknown }).killed;
  return killed === true || message.toLowerCase().includes("timed out") || message.toLowerCase().includes("timeout");
}

function shellCommandResult(input: ShellCommandResultInput): ToolResult {
  const rawOutput = input.output;
  const observation = buildShellObservation(input);
  const compactOutput = renderContextObservation({
    tool: "shell",
    status: input.ok ? "success" : "failed",
    message: input.message,
    observation,
  });
  const meta = {
    durationMs: input.durationMs,
    exitCode: input.exitCode,
    signal: input.signal,
    timedOut: input.timedOut,
    truncated: input.truncated,
    rawOutputChars: rawOutput.length,
  };
  const structuredContent = {
    command: input.command,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    exitCode: input.exitCode,
    signal: input.signal,
    stdoutPreview: truncatePreserveLines(input.stdout, 4_000),
    stderrPreview: truncatePreserveLines(input.stderr, 4_000),
    outputPreview: compactOutput,
    observation,
    timedOut: input.timedOut,
    durationMs: input.durationMs,
    truncated: input.truncated,
    rawOutputChars: rawOutput.length,
  };

  if (input.ok) {
    return {
      ...okResult({
        output: compactOutput,
        meta,
        v2: successV2({
          code: input.code,
          message: input.message,
          structuredContent,
          diagnostics: meta,
        }),
      }),
      rawOutput,
    };
  }

  return {
    ok: false,
    error: input.message,
    output: compactOutput,
    rawOutput,
    meta,
    v2: failureV2({
      code: input.code,
      message: input.message,
      category: input.timedOut ? "timeout" : "semantic",
      retryable: input.timedOut,
      recoverable: true,
      suggestedNextActions: input.timedOut
        ? ["Retry with a longer timeout or a narrower command."]
        : ["Inspect stdout/stderr and rerun with corrected command or environment."],
      structuredContent,
      diagnostics: meta,
    }),
  };
}

function buildShellObservation(input: ShellCommandResultInput): ToolContextObservation {
  const rawOutput = input.output;
  const lines = splitLines(rawOutput);
  const commandKind = classifyCommand(input.command);
  const specializedBlocks = buildSpecializedShellBlocks(commandKind, lines);
  const importantBlocks = importantLineBlocks({
    lines,
    pattern: /error|warn|fail|failed|failure|exception|traceback|typeerror|referenceerror|assertion|stderr|ERR!|ELIFECYCLE|TS\d{3,5}/i,
    maxMatches: 8,
    contextLines: 2,
    maxBlockChars: 1_600,
  });
  const fallbackBlocks = headTailBlocks({
    lines,
    headLines: input.ok ? 20 : 12,
    tailLines: input.ok ? 40 : 60,
    maxBlockChars: 2_400,
  });
  const blocks = dedupeBlocks([
    ...specializedBlocks,
    ...importantBlocks,
    ...fallbackBlocks,
  ]).slice(0, 8);
  return {
    mode: rawOutput.length > 12_000 || input.truncated ? "large_ref" : "focused",
    summary: buildShellSummary(input, commandKind, lines),
    stats: {
      command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      commandKind,
      exitCode: input.exitCode,
      signal: input.signal,
      durationMs: input.durationMs,
      timedOut: input.timedOut,
      truncated: input.truncated,
      rawOutputChars: rawOutput.length,
      lineCount: lines.length,
      stdoutChars: input.stdout.length,
      stderrChars: input.stderr.length,
    },
    highlights: buildShellHighlights(input, commandKind, lines),
    blocks,
    hasMore: input.truncated || rawOutput.length > 12_000,
    suggestedReads: [
      { kind: "search", reason: "Search raw command output for another error, file path, or test name.", input: {} },
      { kind: "tail", reason: "Read the latest command output lines.", input: { lineCount: 120 } },
      { kind: "read_lines", reason: "Read exact output lines around a reported issue.", input: {} },
    ],
  };
}

function classifyCommand(command: string): string {
  const text = command.toLowerCase();
  if (/\b(vitest|jest|mocha|playwright|test)\b/.test(text)) return "test";
  if (/\b(tsc|typescript|eslint|biome|lint)\b/.test(text)) return "diagnostics";
  if (/\b(pnpm|npm|yarn|bun)\b/.test(text)) return "package-script";
  if (/\b(rg|grep|find)\b/.test(text)) return "search";
  if (/\b(git)\b/.test(text)) return "git";
  return "generic";
}

function buildSpecializedShellBlocks(commandKind: string, lines: string[]): ToolContextBlock[] {
  if (commandKind === "test") {
    return importantLineBlocks({
      lines,
      pattern: /FAIL|failed|AssertionError|expected|received|Test Files|Tests|Duration|Error:/i,
      maxMatches: 8,
      contextLines: 3,
      maxBlockChars: 1_800,
      title: "Test output",
    });
  }
  if (commandKind === "diagnostics") {
    return importantLineBlocks({
      lines,
      pattern: /error TS\d{3,5}|:\d+:\d+\s+-\s+error|warning|eslint|biome|lint/i,
      maxMatches: 10,
      contextLines: 2,
      maxBlockChars: 1_600,
      title: "Diagnostic",
    });
  }
  if (commandKind === "package-script") {
    return importantLineBlocks({
      lines,
      pattern: /ERR!|ELIFECYCLE|failed|error|missing|not found|Cannot find module/i,
      maxMatches: 8,
      contextLines: 2,
      maxBlockChars: 1_600,
      title: "Package manager output",
    });
  }
  if (commandKind === "search") {
    const matches = lines
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => /\S+:\d+(:\d+)?:/.test(line) || line.trim().length > 0)
      .slice(0, 40)
      .map(({ line, number }) => `${number}: ${line}`);
    return matches.length > 0
      ? [makeBlock({ title: "Search results", lines: matches, maxChars: 3_000 })]
      : [];
  }
  return [];
}

function buildShellHighlights(input: ShellCommandResultInput, commandKind: string, lines: string[]): string[] {
  const highlights: string[] = [];
  highlights.push(`exitCode=${input.exitCode ?? "unknown"}`);
  if (input.timedOut) highlights.push("command timed out");
  if (input.signal) highlights.push(`signal=${input.signal}`);
  if (input.truncated) highlights.push("output was truncated by the tool cap");

  const summaryPatterns = commandKind === "test"
    ? [/Test Files.+/i, /Tests.+/i, /Duration.+/i, /FAIL.+/i]
    : commandKind === "diagnostics"
      ? [/Found \d+ errors?/i, /error TS\d{3,5}.+/i]
      : [/error.+/i, /failed.+/i, /warning.+/i];

  for (const pattern of summaryPatterns) {
    const match = lines.find((line) => pattern.test(line));
    if (match) highlights.push(match.trim());
  }
  return [...new Set(highlights)].slice(0, 12);
}

function buildShellSummary(input: ShellCommandResultInput, commandKind: string, lines: string[]): string {
  const status = input.ok ? "succeeded" : input.timedOut ? "timed out" : "failed";
  const base = `Command ${status} with exitCode=${input.exitCode ?? "unknown"} in ${input.durationMs}ms.`;
  const stderrLineCount = input.stderr.length > 0 ? splitLines(input.stderr).length : 0;
  const detail = [
    `kind=${commandKind}`,
    `${lines.length} output line${lines.length === 1 ? "" : "s"}`,
    stderrLineCount > 0 ? `${stderrLineCount} stderr line${stderrLineCount === 1 ? "" : "s"}` : "",
    input.truncated ? "captured output was truncated" : "",
  ].filter((item) => item.length > 0).join(", ");
  return `${base} ${detail}.`;
}

function dedupeBlocks(blocks: ToolContextBlock[]): ToolContextBlock[] {
  const seen = new Set<string>();
  const out: ToolContextBlock[] = [];
  for (const block of blocks) {
    const key = `${block.title}:${block.startLine ?? ""}:${block.content}`;
    if (seen.has(key) || block.content.trim().length === 0) {
      continue;
    }
    seen.add(key);
    out.push(block);
  }
  return out;
}

function compactSessionOutput(input: {
  code: string;
  message: string;
  command: string;
  output: string;
  exitCode: number | null;
  signal: string | null;
  running: boolean;
}): { outputPreview: string; observation: ToolContextObservation; rawOutput: string } {
  const observation = buildShellObservation({
    ok: true,
    code: input.code,
    message: input.message,
    command: input.command,
    stdout: input.output,
    stderr: "",
    output: input.output,
    truncated: false,
    durationMs: 0,
    exitCode: input.exitCode,
    signal: input.signal,
    timedOut: false,
  });
  const outputPreview = renderContextObservation({
    tool: "shell_session",
    status: "success",
    message: input.running ? `${input.message}; session is still running.` : input.message,
    observation,
  });
  return { outputPreview, observation, rawOutput: input.output };
}

function capWithDefault(inputCap: number | undefined, defaultCap: number): number {
  if (inputCap === undefined) return defaultCap;
  if (!Number.isFinite(inputCap) || inputCap <= 0) return defaultCap;
  return Math.min(Math.trunc(inputCap), defaultCap);
}

function waitToPolicy(inputWaitMs: number | undefined, fallback: number): number {
  if (inputWaitMs === undefined) return fallback;
  if (!Number.isFinite(inputWaitMs) || inputWaitMs < 0) return fallback;
  return Math.min(Math.trunc(inputWaitMs), 3000);
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
  if (session.exited) return null;
  const idleMs = Date.now() - session.lastActiveAt;
  if (idleMs <= DEFAULT_SESSION_IDLE_TIMEOUT_MS) return null;
  session.process.kill("SIGTERM");
  session.exited = true;
  return errorResult({
    code: "SHELL_SESSION_EXPIRED",
    message: "Session expired due to inactivity. Start a new session.",
    category: "timeout",
    target: session.id,
    retryable: true,
    recoverable: true,
    suggestedNextActions: ["Start a new shell session and rerun the needed command."],
  });
}

function validateStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in (err as ErrnoExceptionLike);
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
  return {
    cmd: v.cmd,
    cwd: v.cwd,
    timeoutMs: v.timeoutMs,
    maxOutputChars: v.maxOutputChars,
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
  return {
    scriptPath: v.scriptPath,
    args: v.args,
    cwd: v.cwd,
    timeoutMs: v.timeoutMs,
    maxOutputChars: v.maxOutputChars,
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
  return {
    cmd: v.cmd,
    cwd: v.cwd,
    waitMs: v.waitMs,
    maxOutputChars: v.maxOutputChars,
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
    const durationMs = Date.now() - start;
    const snapshot = buildOutputSnapshot(stdout, stderr, maxOutputChars);
    return shellCommandResult({
      ok: true,
      code: "COMMAND_SUCCEEDED",
      message: "Command exited with code 0.",
      command: cmd,
      cwd,
      stdout: snapshot.stdout,
      stderr: snapshot.stderr,
      output: snapshot.output,
      truncated: snapshot.truncated,
      durationMs,
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown shell execution error";
    const failureOutput = getExecFailureOutput(err, maxOutputChars);
    const timedOut = execErrorTimedOut(err, message);
    return shellCommandResult({
      ok: false,
      code: timedOut ? "COMMAND_TIMED_OUT" : "COMMAND_FAILED",
      message,
      command: cmd,
      cwd,
      stdout: failureOutput.stdout,
      stderr: failureOutput.stderr,
      output: failureOutput.output,
      truncated: failureOutput.truncated,
      durationMs: Date.now() - start,
      exitCode: execErrorExitCode(err),
      signal: execErrorSignal(err),
      timedOut,
    });
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
      finish(shellCommandResult({
        ok: false,
        code: "PROCESS_START_FAILED",
        message: err.message,
        command: [command, ...args].join(" "),
        cwd,
        stdout,
        stderr,
        output: toOutput(stdout, stderr),
        truncated: false,
        durationMs: Date.now() - start,
        exitCode: null,
        signal: null,
        timedOut: false,
      }));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const output = toOutput(stdout, stderr);
      const durationMs = Date.now() - start;
      const commandLine = [command, ...args].join(" ");
      if (timedOut) {
        finish(shellCommandResult({
          ok: false,
          code: "COMMAND_TIMED_OUT",
          message: "Command timed out and was terminated.",
          command: commandLine,
          cwd,
          stdout,
          stderr,
          output,
          truncated: false,
          durationMs,
          exitCode: code,
          signal,
          timedOut: true,
        }));
        return;
      }
      if (code === 0) {
        finish(shellCommandResult({
          ok: true,
          code: "COMMAND_SUCCEEDED",
          message: "Command exited with code 0.",
          command: commandLine,
          cwd,
          stdout,
          stderr,
          output,
          truncated: false,
          durationMs,
          exitCode: code,
          signal,
          timedOut: false,
        }));
        return;
      }
      finish(shellCommandResult({
        ok: false,
        code: "COMMAND_FAILED",
        message: `Process exited with code ${code ?? "unknown"}.`,
        command: commandLine,
        cwd,
        stdout,
        stderr,
        output,
        truncated: false,
        durationMs,
        exitCode: code,
        signal,
        timedOut: false,
      }));
    });
  });
}

function preflightShellCommand(
  cwd: string | undefined,
): { ok: true; resolvedCwd?: string } {
  const resolvedCwd = resolveWorkspaceCwd(cwd);
  return { ok: true, resolvedCwd };
}

const shellCommandOutputSchema = {
  type: "object",
  required: ["command", "exitCode", "stdoutPreview", "stderrPreview", "outputPreview", "observation", "timedOut", "durationMs", "truncated"],
  properties: {
    command: { type: "string" },
    cwd: { type: "string" },
    exitCode: { type: ["integer", "null"] },
    signal: { type: ["string", "null"] },
    stdoutPreview: { type: "string" },
    stderrPreview: { type: "string" },
    outputPreview: { type: "string" },
    observation: { type: "object" },
    timedOut: { type: "boolean" },
    durationMs: { type: "integer" },
    truncated: { type: "boolean" },
    rawOutputChars: { type: "integer" },
  },
};

const shellCommandAnnotations = commonAnnotations({
  domain: "shell",
  readOnly: false,
  mutatesWorkspace: true,
  mutatesExternalWorld: true,
  idempotent: false,
  retrySafe: false,
  longRunning: false,
});

const shellCommandContract = succeededContract({
  assertions: [
    {
      id: "exit_code_zero",
      kind: "json_path_equals",
      path: "$.result.structuredContent.exitCode",
      value: 0,
    },
    {
      id: "not_timed_out",
      kind: "json_path_equals",
      path: "$.result.structuredContent.timedOut",
      value: false,
    },
  ],
});

const shellSessionAnnotations = commonAnnotations({
  domain: "shell",
  readOnly: false,
  mutatesWorkspace: true,
  mutatesExternalWorld: true,
  idempotent: false,
  retrySafe: false,
  longRunning: true,
});

export const shellExecTool: ToolDefinition = {
  name: "shell",
  description: "Execute a shell command.",
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
  outputSchema: shellCommandOutputSchema,
  annotations: shellCommandAnnotations,
  resultContract: shellCommandContract,
  selectionHints: {
    tags: ["shell", "terminal", "command", "search", "find", "system"],
    aliases: ["shell_exec", "run_command", "terminal_command"],
    examples: ["find file in system", "run rg to search files", "list process output"],
    domain: "execution",
    priority: 15,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateShellExecInput(input);
    if ("ok" in parsed) return parsed;

    const preflight = preflightShellCommand(parsed.cwd);
    const timeoutMs = capWithDefault(parsed.timeoutMs, DEFAULT_TIMEOUT_MS);
    const maxOutputChars = capWithDefault(parsed.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS);
    return await runExecCommand(parsed.cmd, preflight.resolvedCwd, timeoutMs, maxOutputChars);
  },
};

export const shellRunScriptTool: ToolDefinition = {
  name: "shell_run_script",
  description: "Run a bash script file.",
  inputSchema: {
    type: "object",
    required: ["scriptPath"],
    properties: {
      scriptPath: { type: "string" },
      args: { type: "array", items: { type: "string" } },
      cwd: { type: "string" },
      timeoutMs: { type: "number" },
      maxOutputChars: { type: "number" },
    },
  },
  outputSchema: shellCommandOutputSchema,
  annotations: shellCommandAnnotations,
  resultContract: shellCommandContract,
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

    const preflight = preflightShellCommand(parsed.cwd);
    const resolvedCwd = preflight.resolvedCwd ?? resolveWorkspaceCwd();
    const scriptPath = resolvePath(resolvedCwd, parsed.scriptPath);
    let fileStats;
    try {
      fileStats = await stat(scriptPath);
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        return errorResult({
          code: "SCRIPT_NOT_FOUND",
          message: `Script not found: ${scriptPath}`,
          category: "missing_path",
          target: scriptPath,
          retryable: true,
          recoverable: true,
          suggestedNextActions: ["Check the script path or create the script before retrying."],
        });
      }

      const message = err instanceof Error ? err.message : "Unable to inspect script path.";
      return errorResult({
        code: "SCRIPT_INSPECT_FAILED",
        message: `Unable to inspect script path: ${message}`,
        category: "unknown",
        target: scriptPath,
        retryable: false,
        recoverable: true,
        suggestedNextActions: ["Inspect the script path and permissions before retrying."],
      });
    }
    if (!fileStats.isFile()) {
      return errorResult({
        code: "SCRIPT_PATH_NOT_FILE",
        message: "scriptPath must point to a regular file.",
        category: "validation",
        target: scriptPath,
        retryable: true,
        recoverable: true,
        suggestedNextActions: ["Retry with a path to a regular script file."],
      });
    }
    const timeoutMs = capWithDefault(parsed.timeoutMs, DEFAULT_TIMEOUT_MS);
    const maxOutputChars = capWithDefault(parsed.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS);
    return await runProcessCommand(
      "bash",
      [scriptPath, ...(parsed.args ?? [])],
      resolvedCwd,
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
    },
  },
  outputSchema: genericObjectOutputSchema,
  annotations: shellSessionAnnotations,
  resultContract: succeededContract({
    assertions: [
      {
        id: "session_id_present",
        kind: "json_path_exists",
        path: "$.result.structuredContent.sessionId",
      },
      {
        id: "session_running_state_present",
        kind: "json_path_exists",
        path: "$.result.structuredContent.running",
      },
    ],
  }),
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

    const preflight = preflightShellCommand(parsed.cwd);
    const outputCap = capWithDefault(parsed.maxOutputChars, DEFAULT_MAX_SESSION_OUTPUT_CHARS);
    const process = spawn("/bin/bash", ["-lc", parsed.cmd], {
      cwd: preflight.resolvedCwd,
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
    const compact = compactSessionOutput({
      code: "SHELL_SESSION_STARTED",
      message: `Started shell session: ${sessionId}`,
      command: parsed.cmd,
      output,
      exitCode: session.exitCode,
      signal: session.signal,
      running: !session.exited,
    });
    const structuredContent = {
      sessionId,
      command: parsed.cmd,
      ...(preflight.resolvedCwd ? { cwd: preflight.resolvedCwd } : {}),
      outputPreview: compact.outputPreview,
      observation: compact.observation,
      running: !session.exited,
      createdAt: session.createdAt,
      exitCode: session.exitCode,
      signal: session.signal,
      rawOutputChars: output.length,
    };
    const meta = {
      sessionId,
      running: !session.exited,
      createdAt: session.createdAt,
    };
    return {
      ...okResult({
        output: compact.outputPreview,
        meta,
        v2: successV2({
          code: "SHELL_SESSION_STARTED",
          message: `Started shell session: ${sessionId}`,
          structuredContent,
          diagnostics: meta,
        }),
      }),
      rawOutput: compact.rawOutput,
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
  outputSchema: genericObjectOutputSchema,
  annotations: shellSessionAnnotations,
  resultContract: succeededContract({
    assertions: [{
      id: "session_id_present",
      kind: "json_path_exists",
      path: "$.result.structuredContent.sessionId",
    }],
  }),
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
    if (!session) {
      return errorResult({
        code: "SHELL_SESSION_NOT_FOUND",
        message: `Unknown shell session: ${parsed.sessionId}`,
        category: "missing_path",
        target: parsed.sessionId,
        retryable: true,
        recoverable: true,
        suggestedNextActions: ["Start a new shell session or use a valid active sessionId."],
      });
    }

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
    const compact = compactSessionOutput({
      code: "SHELL_SESSION_WRITTEN",
      message: `Updated shell session: ${session.id}`,
      command: `shell_session_write ${session.id}`,
      output,
      exitCode: session.exitCode,
      signal: session.signal,
      running: !session.exited,
    });

    const structuredContent = {
      sessionId: session.id,
      outputPreview: compact.outputPreview,
      observation: compact.observation,
      running: !session.exited,
      exitCode: session.exitCode,
      signal: session.signal,
      inputSent: parsed.input !== undefined,
      closeStdin: parsed.closeStdin === true,
      signalSent: parsed.signal ?? null,
      rawOutputChars: output.length,
    };
    const meta = {
      sessionId: session.id,
      running: !session.exited,
      exitCode: session.exitCode,
      signal: session.signal,
    };
    return {
      ...okResult({
        output: compact.outputPreview,
        meta,
        v2: successV2({
          code: "SHELL_SESSION_WRITTEN",
          message: `Updated shell session: ${session.id}`,
          structuredContent,
          diagnostics: meta,
        }),
      }),
      rawOutput: compact.rawOutput,
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
  outputSchema: genericObjectOutputSchema,
  annotations: shellSessionAnnotations,
  resultContract: succeededContract({
    assertions: [
      {
        id: "session_id_present",
        kind: "json_path_exists",
        path: "$.result.structuredContent.sessionId",
      },
      {
        id: "session_closed",
        kind: "json_path_equals",
        path: "$.result.structuredContent.running",
        value: false,
      },
    ],
  }),
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
    if (!session) {
      return errorResult({
        code: "SHELL_SESSION_NOT_FOUND",
        message: `Unknown shell session: ${parsed.sessionId}`,
        category: "missing_path",
        target: parsed.sessionId,
        retryable: true,
        recoverable: true,
        suggestedNextActions: ["Start a new shell session or use a valid active sessionId."],
      });
    }

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
    const compact = compactSessionOutput({
      code: "SHELL_SESSION_CLOSED",
      message: `Closed shell session: ${session.id}`,
      command: `shell_session_close ${session.id}`,
      output,
      exitCode: session.exitCode,
      signal: session.signal,
      running: false,
    });

    const structuredContent = {
      sessionId: session.id,
      outputPreview: compact.outputPreview,
      observation: compact.observation,
      exitCode: session.exitCode,
      signal: session.signal,
      running: false,
      force: parsed.force === true,
      rawOutputChars: output.length,
    };
    const meta = {
      sessionId: session.id,
      exitCode: session.exitCode,
      signal: session.signal,
      running: false,
    };
    return {
      ...okResult({
        output: compact.outputPreview,
        meta,
        v2: successV2({
          code: "SHELL_SESSION_CLOSED",
          message: `Closed shell session: ${session.id}`,
          structuredContent,
          diagnostics: meta,
        }),
      }),
      rawOutput: compact.rawOutput,
    };
  },
};

const SHELL_PROMPT_BLOCK = [
  "Shell tools are built in.",
  "Use them directly for terminal execution, developer workflows, and orchestrating system tools.",
  "Default shell work to the configured workspace root unless the user or task clearly points to another directory.",
  "Do not prefix cwd values with workspace/ or work_space/; relative cwd values are already workspace-relative.",
  "Use shell_run_script to execute project scripts.",
  "Use shell_session_start/shell_session_write/shell_session_close for interactive commands.",
  "Prefer concise commands and summarize results clearly.",
  "If command output is large, return a concise summary.",
].join("\n");

const shellSkill: SkillDefinition = {
  id: "shell",
  version: "2.0.0",
  description: "Run shell commands, scripts, and interactive terminal sessions.",
  promptBlock: SHELL_PROMPT_BLOCK,
  tools: [
    shellExecTool,
    shellRunScriptTool,
    shellSessionStartTool,
    shellSessionWriteTool,
    shellSessionCloseTool,
  ],
};

export default shellSkill;
