const READ_TOOLS = new Set(["read_files", "read_files__single", "inspect_paths"]);
const SEARCH_TOOLS = new Set(["search_in_files", "find_files", "list_directory"]);
const SHELL_TOOLS = new Set([
  "shell",
  "shell_run_script",
  "shell_session_start",
  "shell_session_write",
  "shell_session_close",
]);
const WRITE_TOOLS = new Set(["write_files", "patch_files", "move", "delete", "create_directory"]);

export function buildToolProjectionMetadata(tool: string, structuredContent: unknown): Record<string, unknown> | undefined {
  if (!isRecord(structuredContent)) {
    return undefined;
  }
  if (READ_TOOLS.has(tool)) {
    return sanitizeRecord(structuredContent, {
      dropKeys: new Set(["content", "observation"]),
      maxArrayItems: 20,
      maxStringChars: 500,
    });
  }
  if (SEARCH_TOOLS.has(tool)) {
    return sanitizeRecord(structuredContent, {
      dropKeys: new Set(["observation"]),
      maxArrayItems: 40,
      maxStringChars: 500,
    });
  }
  if (SHELL_TOOLS.has(tool)) {
    return pickFields(structuredContent, [
      "command",
      "cwd",
      "exitCode",
      "signal",
      "stdoutPreview",
      "stderrPreview",
      "outputPreview",
      "timedOut",
      "durationMs",
      "truncated",
      "rawOutputChars",
      "blockedPattern",
      "reason",
    ], 4_000);
  }
  if (WRITE_TOOLS.has(tool)) {
    return sanitizeRecord(structuredContent, {
      dropKeys: new Set(["content", "observation", "output"]),
      maxArrayItems: 40,
      maxStringChars: 500,
    });
  }
  if (tool.startsWith("git_context_")) {
    return sanitizeRecord(structuredContent, {
      dropKeys: new Set(["content", "observation", "rawOutput"]),
      maxArrayItems: 30,
      maxStringChars: 700,
    });
  }
  return undefined;
}

interface SanitizeOptions {
  dropKeys: Set<string>;
  maxArrayItems: number;
  maxStringChars: number;
}

function sanitizeRecord(input: Record<string, unknown>, options: SanitizeOptions): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (options.dropKeys.has(key)) continue;
    output[key] = sanitizeValue(value, options);
  }
  return output;
}

function sanitizeValue(value: unknown, options: SanitizeOptions): unknown {
  if (typeof value === "string") {
    return truncate(value, options.maxStringChars);
  }
  if (Array.isArray(value)) {
    return value.slice(0, options.maxArrayItems).map((item) => sanitizeValue(item, options));
  }
  if (isRecord(value)) {
    return sanitizeRecord(value, options);
  }
  return value;
}

function pickFields(input: Record<string, unknown>, fields: string[], maxStringChars: number): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    if (!(field in input)) continue;
    const value = input[field];
    output[field] = typeof value === "string" ? truncate(value, maxStringChars) : value;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
