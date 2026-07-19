import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename } from "node:path";
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
import { requireAbsolutePath, resolveWorkspaceCwd } from "../../workspace-paths.js";
import { commonAnnotations, errorResult, failureV2, genericObjectOutputSchema, okResult, succeededContract, successV2 } from "../contract-helpers.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_MAX_SESSION_OUTPUT_CHARS = 100_000;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 600_000; // 10 min

interface ProcessRunInput {
  executable: string;
  args?: string[];
  cwd?: string;
  targets?: ProcessMutationTargetInput[];
  timeoutMs?: number;
  maxOutputChars?: number;
}

interface ProcessStartInput {
  executable: string;
  args?: string[];
  cwd?: string;
  targets?: ProcessMutationTargetInput[];
  waitMs?: number;
  maxOutputChars?: number;
}

interface ProcessPollInput {
  sessionId: string;
  waitMs?: number;
}

interface ProcessSendInputInput {
  sessionId: string;
  input: string;
  closeStdin?: boolean;
  targets?: ProcessMutationTargetInput[];
}

interface ProcessMutationTargetInput {
  path: string;
  kind?: "file" | "directory";
}

interface ProcessStopInput {
  sessionId: string;
  force?: boolean;
  waitMs?: number;
}

interface ProcessSessionState {
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

interface ProcessCommandResultInput {
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

type ProcessRiskLevel = "safe" | "workspace_mutation" | "destructive" | "external_system";

interface ProcessPolicyViolation {
  level: Exclude<ProcessRiskLevel, "safe">;
  code: string;
  reason: string;
  pattern: string;
}

const processSessions = new Map<string, ProcessSessionState>();
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

function processCommandResult(input: ProcessCommandResultInput): ToolResult {
  const rawOutput = input.output;
  const observation = buildProcessObservation(input);
  const compactOutput = renderContextObservation({
    tool: "process_run",
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

function buildProcessObservation(input: ProcessCommandResultInput): ToolContextObservation {
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
    summary: buildProcessSummary(input, commandKind, lines),
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
    highlights: buildProcessHighlights(input, commandKind, lines),
    blocks,
    hasMore: input.truncated || rawOutput.length > 12_000,
    suggestedReads: [
      { kind: "search", reason: "Search command output for another error, file path, or test name.", input: {} },
      { kind: "rerun_narrower", reason: "Rerun a narrower command for the latest relevant lines.", input: { lineCount: 120 } },
      { kind: "rerun_narrower", reason: "Rerun a narrower command around the reported issue.", input: {} },
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

function buildProcessHighlights(input: ProcessCommandResultInput, commandKind: string, lines: string[]): string[] {
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

function buildProcessSummary(input: ProcessCommandResultInput, commandKind: string, lines: string[]): string {
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
  const observation = buildProcessObservation({
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
    tool: "process_session",
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
  return `process_${Date.now().toString(36)}_${id}`;
}

function consumePendingOutput(session: ProcessSessionState): string {
  const out = session.pendingOutput;
  session.pendingOutput = "";
  return out.trim();
}

function ensureSessionNotIdle(session: ProcessSessionState): ToolResult | null {
  if (session.exited) return null;
  const idleMs = Date.now() - session.lastActiveAt;
  if (idleMs <= DEFAULT_SESSION_IDLE_TIMEOUT_MS) return null;
  session.process.kill("SIGTERM");
  session.exited = true;
  return errorResult({
    code: "PROCESS_SESSION_EXPIRED",
    message: "Session expired due to inactivity. Start a new session.",
    category: "timeout",
    target: session.id,
    retryable: true,
    recoverable: true,
    suggestedNextActions: ["Start a new process and rerun the needed executable."],
  });
}

function validateStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function validateAbsoluteShellPath(value: string, field: string): string | ToolResult {
  const result = requireAbsolutePath(value, field);
  if (result.ok) return result.absolutePath;
  return errorResult({
    code: result.code,
    message: result.message,
    category: "validation",
    target: result.requestedPath,
    retryable: true,
    recoverable: true,
    suggestedNextActions: [`Retry with the canonical absolute ${field}.`],
  });
}

function validateProcessTargets(value: unknown): ProcessMutationTargetInput[] | undefined | ToolResult {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    return { ok: false, error: "Invalid input: targets must be an array when provided." };
  }
  const targets: ProcessMutationTargetInput[] = [];
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `Invalid input: targets[${index}] must be an object.` };
    }
    const target = entry as Record<string, unknown>;
    if (typeof target["path"] !== "string" || target["path"].trim().length === 0) {
      return { ok: false, error: `Invalid input: targets[${index}].path must be a non-empty string.` };
    }
    if (target["kind"] !== undefined && target["kind"] !== "file" && target["kind"] !== "directory") {
      return { ok: false, error: `Invalid input: targets[${index}].kind must be file or directory.` };
    }
    const path = validateAbsoluteShellPath(target["path"], `targets[${index}].path`);
    if (typeof path !== "string") return path;
    targets.push({ path, ...(target["kind"] ? { kind: target["kind"] } : {}) });
  }
  return targets;
}

function validateProcessRunInput(input: unknown): ProcessRunInput | ToolResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Invalid input: expected object." };
  }
  const v = input as Partial<ProcessRunInput>;
  if (typeof v.executable !== "string" || v.executable.trim().length === 0) {
    return { ok: false, error: "Invalid input: executable must be a non-empty string." };
  }
  if (v.args !== undefined && !validateStringArray(v.args)) {
    return { ok: false, error: "Invalid input: args must be an array of strings when provided." };
  }
  if (v.cwd !== undefined && typeof v.cwd !== "string") {
    return { ok: false, error: "Invalid input: cwd must be a string when provided." };
  }
  const cwd = v.cwd === undefined ? undefined : validateAbsoluteShellPath(v.cwd, "cwd");
  if (cwd !== undefined && typeof cwd !== "string") return cwd;
  const targets = validateProcessTargets(v.targets);
  if (targets && "ok" in targets) return targets;
  if (v.timeoutMs !== undefined && (!Number.isFinite(v.timeoutMs) || v.timeoutMs <= 0)) {
    return { ok: false, error: "Invalid input: timeoutMs must be a positive number." };
  }
  if (v.maxOutputChars !== undefined && (!Number.isFinite(v.maxOutputChars) || v.maxOutputChars <= 0)) {
    return { ok: false, error: "Invalid input: maxOutputChars must be a positive number." };
  }
  return {
    executable: v.executable.trim(),
    args: v.args,
    cwd,
    targets,
    timeoutMs: v.timeoutMs,
    maxOutputChars: v.maxOutputChars,
  };
}

function validateProcessStartInput(input: unknown): ProcessStartInput | ToolResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Invalid input: expected object." };
  }
  const v = input as Partial<ProcessStartInput>;
  if (typeof v.executable !== "string" || v.executable.trim().length === 0) {
    return { ok: false, error: "Invalid input: executable must be a non-empty string." };
  }
  if (v.args !== undefined && !validateStringArray(v.args)) {
    return { ok: false, error: "Invalid input: args must be an array of strings when provided." };
  }
  if (v.cwd !== undefined && typeof v.cwd !== "string") {
    return { ok: false, error: "Invalid input: cwd must be a string when provided." };
  }
  const cwd = v.cwd === undefined ? undefined : validateAbsoluteShellPath(v.cwd, "cwd");
  if (cwd !== undefined && typeof cwd !== "string") return cwd;
  const targets = validateProcessTargets(v.targets);
  if (targets && "ok" in targets) return targets;
  if (v.waitMs !== undefined && (!Number.isFinite(v.waitMs) || v.waitMs < 0)) {
    return { ok: false, error: "Invalid input: waitMs must be a non-negative number." };
  }
  if (v.maxOutputChars !== undefined && (!Number.isFinite(v.maxOutputChars) || v.maxOutputChars <= 0)) {
    return { ok: false, error: "Invalid input: maxOutputChars must be a positive number." };
  }
  return {
    executable: v.executable.trim(),
    args: v.args,
    cwd,
    targets,
    waitMs: v.waitMs,
    maxOutputChars: v.maxOutputChars,
  };
}

function validateProcessPollInput(input: unknown): ProcessPollInput | ToolResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Invalid input: expected object." };
  }
  const v = input as Partial<ProcessPollInput>;
  if (typeof v.sessionId !== "string" || v.sessionId.trim().length === 0) {
    return { ok: false, error: "Invalid input: sessionId must be a non-empty string." };
  }
  if (v.waitMs !== undefined && (!Number.isFinite(v.waitMs) || v.waitMs < 0)) {
    return { ok: false, error: "Invalid input: waitMs must be a non-negative number." };
  }
  return {
    sessionId: v.sessionId.trim(),
    waitMs: v.waitMs,
  };
}

function validateProcessSendInput(input: unknown): ProcessSendInputInput | ToolResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Invalid input: expected object." };
  }
  const v = input as Partial<ProcessSendInputInput>;
  if (typeof v.sessionId !== "string" || v.sessionId.trim().length === 0) {
    return { ok: false, error: "Invalid input: sessionId must be a non-empty string." };
  }
  if (typeof v.input !== "string" || v.input.length === 0) {
    return { ok: false, error: "Invalid input: input must be a non-empty string." };
  }
  if (v.closeStdin !== undefined && typeof v.closeStdin !== "boolean") {
    return { ok: false, error: "Invalid input: closeStdin must be a boolean when provided." };
  }
  const targets = validateProcessTargets(v.targets);
  if (targets && "ok" in targets) return targets;
  return {
    sessionId: v.sessionId.trim(),
    input: v.input,
    closeStdin: v.closeStdin,
    targets,
  };
}

function validateProcessStopInput(input: unknown): ProcessStopInput | ToolResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Invalid input: expected object." };
  }
  const v = input as Partial<ProcessStopInput>;
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
      finish(processCommandResult({
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
        finish(processCommandResult({
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
        finish(processCommandResult({
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
      finish(processCommandResult({
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
  command: string,
  cwd: string | undefined,
  source: "command" | "session",
  rootPath?: string,
): { ok: true; resolvedCwd?: string } | { ok: false; result: ToolResult } {
  const resolvedCwd = resolveWorkspaceCwd(cwd, rootPath);
  const violation = classifyProcessPolicy(command, source);
  if (violation) {
    return { ok: false, result: processPolicyBlockedResult(command, resolvedCwd, source, violation) };
  }
  return { ok: true, resolvedCwd };
}

const DOMAIN_OWNED_EXECUTABLES = new Map<string, string>([
  ["cat", "read_files"],
  ["head", "read_files"],
  ["tail", "read_files"],
  ["grep", "search_in_files"],
  ["rg", "search_in_files"],
  ["find", "find_files"],
  ["ls", "list_directory"],
  ["stat", "inspect_paths"],
  ["file", "inspect_paths"],
  ["sed", "patch_files"],
  ["cp", "write_files"],
  ["mv", "move"],
  ["rm", "delete"],
  ["touch", "write_files"],
  ["mkdir", "create_directory"],
  ["sqlite3", "database tools"],
  ["curl", "file_fetch_url or a dedicated external-action tool"],
  ["wget", "file_fetch_url or a dedicated external-action tool"],
  ["git", "Git Context runtime"],
  ["python", "python_execute"],
  ["python3", "python_execute"],
]);

function preflightProcess(
  executable: string,
  args: string[],
  cwd: string | undefined,
  source: "command" | "session",
  rootPath?: string,
): { ok: true; resolvedCwd?: string; command: string } | { ok: false; result: ToolResult } {
  const command = formatProcessCommand(executable, args);
  const name = basename(executable).toLowerCase();
  const owner = DOMAIN_OWNED_EXECUTABLES.get(name);
  if (owner) {
    return {
      ok: false,
      result: processPolicyBlockedResult(command, resolveWorkspaceCwd(cwd, rootPath), source, {
        level: "workspace_mutation",
        code: "PROCESS_DEDICATED_TOOL_REQUIRED",
        pattern: name,
        reason: `Executable '${name}' duplicates capability owned by ${owner}.`,
      }),
    };
  }
  if (["bash", "sh", "zsh", "fish"].includes(name)) {
    return {
      ok: false,
      result: processPolicyBlockedResult(command, resolveWorkspaceCwd(cwd, rootPath), source, {
        level: "workspace_mutation",
        code: "PROCESS_SHELL_INTERPRETER_BLOCKED",
        pattern: name,
        reason: "Shell interpreters can bypass focused tool contracts; run a project command or executable directly.",
      }),
    };
  }
  if ((name === "node" || name === "bun" || name === "deno") && args.some((arg) => arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print")) {
    return {
      ok: false,
      result: processPolicyBlockedResult(command, resolveWorkspaceCwd(cwd, rootPath), source, {
        level: "workspace_mutation",
        code: "PROCESS_INLINE_CODE_BLOCKED",
        pattern: `${name} inline code`,
        reason: "Inline interpreter code can bypass focused filesystem, database, and Python tool contracts.",
      }),
    };
  }
  const preflight = preflightShellCommand(command, cwd, source, rootPath);
  return preflight.ok ? { ...preflight, command } : preflight;
}

function formatProcessCommand(executable: string, args: string[]): string {
  return [executable, ...args].map((part) => JSON.stringify(part)).join(" ");
}

function classifyProcessPolicy(command: string, source: "command" | "session"): ProcessPolicyViolation | undefined {
  const normalized = command.trim();
  const lower = normalized.toLowerCase();

  const destructiveChecks: Array<[RegExp, string, string]> = [
    [/\bsudo\b/, "sudo", "sudo/system privilege commands are blocked from process tools."],
    [/\brm\s+-[^\n;&|]*r[^\n;&|]*f\b|\brm\s+-[^\n;&|]*f[^\n;&|]*r\b/, "rm -rf", "recursive force deletion is destructive."],
    [/\bgit\s+reset\s+--hard\b/, "git reset --hard", "hard git resets can destroy uncommitted work."],
    [/\bgit\s+clean\b/, "git clean", "git clean can delete untracked user files."],
    [/\bgit\s+checkout\s+--\s+(?:\.|\/|\*)/, "git checkout --", "bulk checkout can discard user changes."],
    [/\b(?:docker\s+system\s+prune|docker\s+(?:rm|rmi)\b|docker\s+(?:volume|network)\s+rm\b)/, "docker destructive command", "docker delete/prune commands are destructive external-system operations."],
    [/\bkubectl\s+delete\b/, "kubectl delete", "kubectl delete mutates external infrastructure."],
    [/\b(?:dropdb|createdb)\b/, "database admin command", "database admin commands mutate external state."],
    [/\bpsql\b[\s\S]*\bdrop\b/i, "psql DROP", "DROP statements are destructive database operations."],
    [/\bchmod\s+-R\s+(?:777|[^\n;&|]*\+w)\b/, "chmod -R", "recursive permission changes are risky and broad."],
    [/\bchown\s+-R\b/, "chown -R", "recursive ownership changes are risky and broad."],
    [/\bdd\b[\s\S]*\bof=/, "dd of=", "dd writes raw bytes to a target path/device."],
    [/\bmkfs(?:\.[a-z0-9_-]+)?\b/, "mkfs", "filesystem creation commands are destructive."],
    [/\b(?:systemctl|service)\b/, "service manager", "service manager commands mutate system state."],
    [/\bkill\s+-9\b|\bkill\s+-KILL\b/i, "kill -9", "force-kill commands are destructive process control."],
  ];
  for (const [pattern, label, reason] of destructiveChecks) {
    if (pattern.test(lower)) {
      return {
        level: "destructive",
        code: "PROCESS_DESTRUCTIVE_COMMAND_BLOCKED",
        pattern: label,
        reason,
      };
    }
  }

  if (/\b(?:curl|wget)\b[\s\S]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python|python3|node)\b/i.test(normalized)) {
    return {
      level: "external_system",
      code: "PROCESS_EXTERNAL_INSTALL_BLOCKED",
      pattern: "curl/wget pipe to interpreter",
      reason: "piping downloaded content into an interpreter is unsafe and mutates external/system state.",
    };
  }

  if (source === "session" && /^(?:bash|sh|zsh|fish|python|python3|node|ruby)(?:\s|$)/i.test(normalized)) {
    return {
      level: "workspace_mutation",
      code: "PROCESS_INTERACTIVE_MUTATION_SURFACE_BLOCKED",
      pattern: "interactive interpreter/process session",
      reason: "interactive shells and interpreters can bypass filesystem tool contracts through later stdin writes.",
    };
  }

  const mutationChecks: Array<[RegExp, string, string]> = [
    [/\bsed\b[\s\S]*(?:^|\s)-i(?:\b|['"=])/, "sed -i", "in-place sed edits bypass patch_files/write_files contracts."],
    [/\bperl\b[\s\S]*(?:^|\s)-p?i(?:\b|['"=])/, "perl -pi", "in-place perl edits bypass patch_files/write_files contracts."],
    [/(^|[\s;|&])(?:[12])?>>\s*(?!&\d\b|\/dev\/null\b)\S+|(^|[\s;|&])(?:[12])?>\s*(?!&\d\b|\/dev\/null\b)\S+/, "shell redirection", "file redirection writes bypass filesystem tool contracts."],
    [/\btee\s+(?:-[a-zA-Z]+\s+)*[^\s|&;]+/, "tee file", "tee writes files outside filesystem tool contracts."],
    [/\b(?:mv|cp|rm|touch|truncate|mkdir|chmod|chown)\b/, "filesystem mutation command", "filesystem mutations should use move/delete/create_directory or guarded file tools."],
    [/\b(?:python|python3|node|ruby)\b[\s\S]*(?:writefilesync|writefile|write_text|open\s*\([^)]*['"]w|fs\.write)/i, "scripted file write", "scripted file writes bypass filesystem tool contracts."],
  ];
  for (const [pattern, label, reason] of mutationChecks) {
    if (pattern.test(normalized)) {
      return {
        level: "workspace_mutation",
        code: "PROCESS_FILE_MUTATION_BLOCKED",
        pattern: label,
        reason,
      };
    }
  }

  return undefined;
}

function processPolicyBlockedResult(
  command: string,
  cwd: string | undefined,
  source: "command" | "session",
  violation: ProcessPolicyViolation,
): ToolResult {
  const message = `${violation.code}: ${violation.reason}`;
  const structuredContent = {
    command,
    ...(cwd ? { cwd } : {}),
    source,
    riskLevel: violation.level,
    blockedPattern: violation.pattern,
    reason: violation.reason,
    exitCode: null,
    signal: null,
    stdoutPreview: "",
    stderrPreview: "",
    outputPreview: message,
    timedOut: false,
    durationMs: 0,
    truncated: false,
    rawOutputChars: 0,
  };
  return {
    ok: false,
    error: message,
    output: message,
    rawOutput: "",
    meta: {
      durationMs: 0,
      exitCode: null,
      signal: null,
      timedOut: false,
      truncated: false,
      rawOutputChars: 0,
      riskLevel: violation.level,
      blockedPattern: violation.pattern,
    },
    v2: failureV2({
      code: violation.code,
      message,
      category: "permission",
      retryable: false,
      recoverable: true,
      target: violation.pattern,
      suggestedNextActions: [
        "Use filesystem tools instead: read_files, write_files with baseSha256, patch_files, move, delete, or create_directory.",
        "Use process_run only for project execution that no focused domain tool owns.",
      ],
      structuredContent,
      diagnostics: {
        durationMs: 0,
        source,
        riskLevel: violation.level,
        blockedPattern: violation.pattern,
      },
    }),
  };
}

const processCommandOutputSchema = {
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

const processMutationTargetsSchema = {
  type: "array",
  description: "Bounded host paths the command may create or modify. Required by resource authorization for mutation-capable commands.",
  items: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Canonical absolute file or directory path." },
      kind: { type: "string", enum: ["file", "directory"] },
    },
    additionalProperties: false,
  },
};

const processCommandAnnotations = commonAnnotations({
  domain: "process",
  readOnly: false,
  mutatesWorkspace: true,
  mutatesExternalWorld: true,
  idempotent: false,
  retrySafe: false,
  longRunning: false,
});

const processCommandContract = succeededContract({
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

const processSessionAnnotations = commonAnnotations({
  domain: "process",
  readOnly: false,
  mutatesWorkspace: true,
  mutatesExternalWorld: true,
  idempotent: false,
  retrySafe: false,
  longRunning: true,
});

const processPollAnnotations = commonAnnotations({
  domain: "process",
  readOnly: false,
  idempotent: false,
  retrySafe: false,
  longRunning: true,
});

const processStopAnnotations = commonAnnotations({
  domain: "process",
  readOnly: false,
  mutatesExternalWorld: true,
  idempotent: false,
  retrySafe: false,
  longRunning: true,
});

export const processRunTool: ToolDefinition = {
  name: "process_run",
  description: "Run one non-interactive project executable with structured arguments when no focused domain tool owns the operation.",
  inputSchema: {
    type: "object",
    required: ["executable"],
    properties: {
      executable: { type: "string", description: "Executable name or canonical absolute executable path. Shell command strings are not accepted." },
      args: { type: "array", items: { type: "string" }, description: "Arguments passed directly to the executable without shell parsing." },
      cwd: { type: "string", description: "Canonical absolute working directory. Omit to use the default Ayati workspace." },
      targets: processMutationTargetsSchema,
      timeoutMs: { type: "number" },
      maxOutputChars: { type: "number" },
    },
  },
  outputSchema: processCommandOutputSchema,
  annotations: processCommandAnnotations,
  resultContract: processCommandContract,
  selectionHints: {
    tags: ["process", "command", "build", "test", "lint", "package-script"],
    aliases: ["run_project_command", "run_executable"],
    examples: ["run pnpm test", "run pnpm build", "run an existing project executable"],
    domain: "execution",
    priority: 15,
  },
  async execute(input, context): Promise<ToolResult> {
    const parsed = validateProcessRunInput(input);
    if ("ok" in parsed) return parsed;

    const preflight = preflightProcess(
      parsed.executable,
      parsed.args ?? [],
      parsed.cwd,
      "command",
      context?.resourceScope?.rootPath,
    );
    if (!preflight.ok) return preflight.result;
    const timeoutMs = capWithDefault(parsed.timeoutMs, DEFAULT_TIMEOUT_MS);
    const maxOutputChars = capWithDefault(parsed.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS);
    return await runProcessCommand(parsed.executable, parsed.args ?? [], preflight.resolvedCwd, timeoutMs, maxOutputChars);
  },
};

export const processStartTool: ToolDefinition = {
  name: "process_start",
  description: "Start one long-running project executable and return a sessionId.",
  inputSchema: {
    type: "object",
    required: ["executable"],
    properties: {
      executable: { type: "string", description: "Executable name or canonical absolute executable path. Shell command strings are not accepted." },
      args: { type: "array", items: { type: "string" }, description: "Arguments passed directly to the executable without shell parsing." },
      cwd: { type: "string", description: "Canonical absolute working directory. Omit to use the default Ayati workspace." },
      targets: processMutationTargetsSchema,
      waitMs: { type: "number" },
      maxOutputChars: { type: "number" },
    },
  },
  outputSchema: genericObjectOutputSchema,
  annotations: processSessionAnnotations,
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
    tags: ["process", "long-running", "server", "session"],
    aliases: ["start_process", "start_server"],
    examples: ["start the development server", "start an existing long-running project executable"],
    domain: "execution",
    priority: 28,
  },
  async execute(input, context): Promise<ToolResult> {
    const parsed = validateProcessStartInput(input);
    if ("ok" in parsed) return parsed;

    const preflight = preflightProcess(
      parsed.executable,
      parsed.args ?? [],
      parsed.cwd,
      "session",
      context?.resourceScope?.rootPath,
    );
    if (!preflight.ok) return preflight.result;
    const outputCap = capWithDefault(parsed.maxOutputChars, DEFAULT_MAX_SESSION_OUTPUT_CHARS);
    const process = spawn(parsed.executable, parsed.args ?? [], {
      cwd: preflight.resolvedCwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const sessionId = nextSessionId();
    let resolveClose: (() => void) | undefined;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const session: ProcessSessionState = {
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

    processSessions.set(sessionId, session);
    await sleep(waitToPolicy(parsed.waitMs, 150));
    const output = consumePendingOutput(session);
    const compact = compactSessionOutput({
      code: "PROCESS_SESSION_STARTED",
      message: `Started process session: ${sessionId}`,
      command: preflight.command,
      output,
      exitCode: session.exitCode,
      signal: session.signal,
      running: !session.exited,
    });
    const structuredContent = {
      sessionId,
      command: preflight.command,
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
          code: "PROCESS_SESSION_STARTED",
          message: `Started process session: ${sessionId}`,
          structuredContent,
          diagnostics: meta,
        }),
      }),
      rawOutput: compact.rawOutput,
    };
  },
};

export const processSendInputTool: ToolDefinition = {
  name: "process_send_input",
  description: "Send stdin to one running process without polling or stopping it.",
  inputSchema: {
    type: "object",
    required: ["sessionId", "input"],
    properties: {
      sessionId: { type: "string" },
      input: { type: "string" },
      closeStdin: { type: "boolean" },
      targets: processMutationTargetsSchema,
    },
  },
  outputSchema: genericObjectOutputSchema,
  annotations: processSessionAnnotations,
  resultContract: succeededContract({
    assertions: [{
      id: "session_id_present",
      kind: "json_path_exists",
      path: "$.result.structuredContent.sessionId",
    }],
  }),
  selectionHints: {
    tags: ["process", "stdin", "input", "session"],
    aliases: ["send_process_input"],
    examples: ["send input to a running project process"],
    domain: "execution",
    priority: 27,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateProcessSendInput(input);
    if ("ok" in parsed) return parsed;

    const session = processSessions.get(parsed.sessionId);
    if (!session) {
      return errorResult({
        code: "PROCESS_SESSION_NOT_FOUND",
        message: `Unknown process session: ${parsed.sessionId}`,
        category: "missing_path",
        target: parsed.sessionId,
        retryable: true,
        recoverable: true,
        suggestedNextActions: ["Start a new process session or use a valid active sessionId."],
      });
    }

    const idleError = ensureSessionNotIdle(session);
    if (idleError) return idleError;

    if (!session.exited && !session.process.stdin.destroyed) {
      session.process.stdin.write(parsed.input);
    }
    if (parsed.closeStdin && !session.exited && !session.process.stdin.destroyed) {
      session.process.stdin.end();
    }

    session.lastActiveAt = Date.now();
    const structuredContent = {
      sessionId: session.id,
      running: !session.exited,
      inputSent: true,
      closeStdin: parsed.closeStdin === true,
    };
    const meta = {
      sessionId: session.id,
      running: !session.exited,
    };
    return okResult({
      output: `Input sent to process session ${session.id}.`,
      meta,
      v2: successV2({
        code: "PROCESS_INPUT_SENT",
        message: `Sent input to process session: ${session.id}`,
        structuredContent,
        diagnostics: meta,
      }),
    });
  },
};

export const processPollTool: ToolDefinition = {
  name: "process_poll",
  description: "Read incremental output and status from one running process without sending input or stopping it.",
  inputSchema: {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" },
      waitMs: { type: "number" },
    },
  },
  outputSchema: genericObjectOutputSchema,
  annotations: processPollAnnotations,
  resultContract: succeededContract({
    assertions: [{
      id: "session_id_present",
      kind: "json_path_exists",
      path: "$.result.structuredContent.sessionId",
    }],
  }),
  selectionHints: {
    tags: ["process", "poll", "output", "session"],
    aliases: ["poll_process"],
    examples: ["check development server output"],
    domain: "execution",
    priority: 27,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateProcessPollInput(input);
    if ("ok" in parsed) return parsed;
    const session = processSessions.get(parsed.sessionId);
    if (!session) {
      return errorResult({
        code: "PROCESS_SESSION_NOT_FOUND",
        message: `Unknown process session: ${parsed.sessionId}`,
        category: "missing_path",
        target: parsed.sessionId,
        retryable: true,
        recoverable: true,
        suggestedNextActions: ["Start a new process or use a valid active sessionId."],
      });
    }
    const idleError = ensureSessionNotIdle(session);
    if (idleError) return idleError;
    session.lastActiveAt = Date.now();
    await sleep(waitToPolicy(parsed.waitMs, 120));
    const output = consumePendingOutput(session);
    const compact = compactSessionOutput({
      code: "PROCESS_POLLED",
      message: `Polled process session: ${session.id}`,
      command: `process_poll ${session.id}`,
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
          code: "PROCESS_POLLED",
          message: `Polled process session: ${session.id}`,
          structuredContent,
          diagnostics: meta,
        }),
      }),
      rawOutput: compact.rawOutput,
    };
  },
};

export const processStopTool: ToolDefinition = {
  name: "process_stop",
  description: "Stop one running process and return its final output and status.",
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
  annotations: processStopAnnotations,
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
    tags: ["process", "stop", "server", "session"],
    aliases: ["stop_process"],
    examples: ["stop the development server"],
    domain: "execution",
    priority: 27,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateProcessStopInput(input);
    if ("ok" in parsed) return parsed;

    const session = processSessions.get(parsed.sessionId);
    if (!session) {
      return errorResult({
        code: "PROCESS_SESSION_NOT_FOUND",
        message: `Unknown process session: ${parsed.sessionId}`,
        category: "missing_path",
        target: parsed.sessionId,
        retryable: true,
        recoverable: true,
        suggestedNextActions: ["Start a new process or use a valid active sessionId."],
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
    processSessions.delete(session.id);
    const compact = compactSessionOutput({
      code: "PROCESS_SESSION_CLOSED",
      message: `Closed process session: ${session.id}`,
      command: `process_stop ${session.id}`,
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
          code: "PROCESS_SESSION_CLOSED",
          message: `Closed process session: ${session.id}`,
          structuredContent,
          diagnostics: meta,
        }),
      }),
      rawOutput: compact.rawOutput,
    };
  },
};

const PROCESS_PROMPT_BLOCK = [
  "Focused process tools are built in for project commands that no domain tool owns.",
  "Use process_run for one non-interactive executable, or process_start/process_poll/process_send_input/process_stop for one long-running process lifecycle.",
  "Pass executable and args separately. Shell command strings, shell interpreters, inline interpreter code, and direct filesystem/search/database/Git commands are rejected.",
  "Use read_files, search_in_files, find_files, list_directory, inspect_paths, filesystem mutation tools, database tools, Python tools, file_fetch_url, and Git Context for their owned capabilities.",
  "Default process cwd to the selected bound resource. Any supplied cwd and mutation targets must be canonical absolute paths.",
  "For a project command that may create generated files, declare every bounded absolute mutation target in targets.",
].join("\n");

const processSkill: SkillDefinition = {
  id: "process",
  version: "1.0.0",
  description: "Run focused project executables and manage long-running process lifecycles.",
  promptBlock: PROCESS_PROMPT_BLOCK,
  tools: [
    processRunTool,
    processStartTool,
    processPollTool,
    processSendInputTool,
    processStopTool,
  ],
};

export default processSkill;
