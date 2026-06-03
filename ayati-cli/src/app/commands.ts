export const DOC_COMMAND_HELP = "Use @path in the input to add files or folders. Delete the @path text to remove one before sending.";

export type ParsedCliCommand =
  | { type: "clearDocs" }
  | { type: "invalid"; message: string }
  | { type: "unknown" };

export function parseCliCommand(input: string): ParsedCliCommand {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return { type: "unknown" };
  }

  const commandName = match[1]?.toLowerCase() ?? "";

  switch (commandName) {
    case "clear":
      return { type: "clearDocs" };
    default:
      return { type: "unknown" };
  }
}
