const READ_ONLY_COMMANDS = new Set([
  "[",
  "cat",
  "cd",
  "cmp",
  "cut",
  "diff",
  "du",
  "echo",
  "file",
  "find",
  "grep",
  "head",
  "jq",
  "ls",
  "printf",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "sed",
  "set",
  "sha256sum",
  "shasum",
  "sort",
  "stat",
  "tail",
  "test",
  "tr",
  "true",
  "uniq",
  "wc",
]);

const CONTROL_ONLY = /^(?:do|done|else|esac|fi|then)(?:\s|$)/;
const CONTROL_PREFIX = /^(?:(?:if|then|else|do|while|until)\s+|!\s*)/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:[^\s]+)(?:\s+|$)/;

/**
 * Recognize a deliberately small shell subset used for inspection and
 * deterministic verification. Unknown commands fail closed and need explicit
 * mutation targets at the task boundary.
 */
export function isClearlyReadOnlyShellCommand(command: string): boolean {
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  return segments.every(isReadOnlySegment);
}

function isReadOnlySegment(segment: string): boolean {
  let value = segment.trim();
  if (!value || value.startsWith("#")) return true;
  if (/^(?:for|case)\s+/.test(value) || CONTROL_ONLY.test(value)) return true;
  while (CONTROL_PREFIX.test(value)) value = value.replace(CONTROL_PREFIX, "").trimStart();

  const substitution = value.match(/^[A-Za-z_][A-Za-z0-9_]*=\$\(([\s\S]*)\)\s*$/);
  if (substitution) return isClearlyReadOnlyShellCommand(substitution[1] ?? "");
  while (ASSIGNMENT.test(value)) value = value.replace(ASSIGNMENT, "").trimStart();
  if (!value) return true;

  const executable = value.match(/^[^\s]+/)?.[0] ?? "";
  if (executable === "node") {
    return /^node\s+(?:--check|-c)(?:\s|$)/.test(value);
  }
  if (executable === "sed") {
    return !/(?:^|\s)-[a-zA-Z]*i(?:\b|['"=])/.test(value);
  }
  return READ_ONLY_COMMANDS.has(executable);
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  let substitutionDepth = 0;

  const flush = (): void => {
    const value = current.trim();
    if (value) segments.push(value);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && !singleQuoted) {
      current += char;
      escaped = true;
      continue;
    }
    if (char === "'" && !doubleQuoted) {
      singleQuoted = !singleQuoted;
      current += char;
      continue;
    }
    if (char === '"' && !singleQuoted) {
      doubleQuoted = !doubleQuoted;
      current += char;
      continue;
    }
    if (!singleQuoted && char === "$" && command[index + 1] === "(") {
      substitutionDepth += 1;
      current += "$(";
      index += 1;
      continue;
    }
    if (!singleQuoted && substitutionDepth > 0 && char === ")") {
      substitutionDepth -= 1;
      current += char;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && substitutionDepth === 0 && (char === "\n" || char === ";" || char === "|")) {
      flush();
      if (char === "|" && command[index + 1] === "|") index += 1;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && substitutionDepth === 0 && char === "&" && command[index + 1] === "&") {
      flush();
      index += 1;
      continue;
    }
    current += char;
  }
  flush();
  return segments;
}
