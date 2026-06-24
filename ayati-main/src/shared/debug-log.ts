/**
 * Color-coded debug logger for development.
 *
 * All calls use a [DEBUG] prefix printed in bright magenta
 * so they stand out in the terminal and are easy to grep & remove:
 *
 *   grep -rn "devLog" src/
 *
 * Remove every devLog call before production builds.
 */

const RESET = "\x1b[0m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

const PREFIX = `${MAGENTA}[DEBUG]${RESET}`;
const TRACE_PREFIX = `${MAGENTA}[TRACE]${RESET}`;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function devLog(...args: unknown[]): void {
  console.log(PREFIX, `${CYAN}INFO${RESET}`, ...args);
}

export function devWarn(...args: unknown[]): void {
  console.log(PREFIX, `${YELLOW}WARN${RESET}`, ...args);
}

export function devError(...args: unknown[]): void {
  console.log(PREFIX, `${RED}ERROR${RESET}`, ...args);
}

export function agentTrace(stage: string, ...args: unknown[]): void {
  if (!isAgentTraceEnabled()) {
    return;
  }
  console.log(TRACE_PREFIX, `${CYAN}${stage}${RESET}`, ...args);
}

export function isAgentTraceEnabled(): boolean {
  return parseEnvFlag(process.env["AYATI_AGENT_TRACE"]);
}

export function isAgentTracePromptEnabled(): boolean {
  return parseEnvFlag(process.env["AYATI_AGENT_TRACE_PROMPTS"]);
}

export function tracePreview(value: unknown, maxChars = 4_000): string {
  const text = typeof value === "string" ? value : stringifyTraceValue(value);
  if (text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars).trimEnd()}...[truncated ${omitted} chars]`;
}

function parseEnvFlag(value: string | undefined): boolean {
  return value !== undefined && TRUE_VALUES.has(value.trim().toLowerCase());
}

function stringifyTraceValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
