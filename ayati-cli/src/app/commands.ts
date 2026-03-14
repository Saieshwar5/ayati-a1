export const ATTACH_USAGE = "Usage: /attach <local-file-path> [-- message]";

export type ParsedCliCommand =
  | { type: "files" }
  | { type: "clearfiles" }
  | { type: "attach"; rawPath: string; content?: string }
  | { type: "invalid"; message: string }
  | { type: "unknown" };

export function parseCliCommand(input: string): ParsedCliCommand {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return { type: "unknown" };
  }

  const commandName = match[1]?.toLowerCase() ?? "";
  const rawArgs = match[2]?.trim() ?? "";

  switch (commandName) {
    case "files":
      return { type: "files" };
    case "clearfiles":
      return { type: "clearfiles" };
    case "attach":
      return parseAttachArgs(rawArgs);
    default:
      return { type: "unknown" };
  }
}

function parseAttachArgs(rawArgs: string): ParsedCliCommand {
  if (rawArgs.length === 0) {
    return { type: "invalid", message: ATTACH_USAGE };
  }

  const inlineMatch = rawArgs.match(/^(.*?)\s+--\s*(.*)$/);
  if (!inlineMatch) {
    const rawPath = stripWrappingQuotes(rawArgs);
    return rawPath.length > 0
      ? { type: "attach", rawPath }
      : { type: "invalid", message: ATTACH_USAGE };
  }

  const rawPath = stripWrappingQuotes(inlineMatch[1] ?? "");
  const content = (inlineMatch[2] ?? "").trim();

  if (rawPath.length === 0 || content.length === 0) {
    return { type: "invalid", message: ATTACH_USAGE };
  }

  return {
    type: "attach",
    rawPath,
    content,
  };
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "\"" || first === "'") && first === last) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}
