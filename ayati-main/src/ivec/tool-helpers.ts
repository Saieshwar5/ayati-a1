import type { ToolResult } from "../skills/types.js";

export function formatToolResult(toolName: string, result: ToolResult): string {
  return JSON.stringify(
    {
      tool: toolName,
      ok: result.ok,
      output: result.output ?? "",
      error: result.error ?? "",
      meta: result.meta ?? {},
    },
    null,
    2,
  );
}

export function formatValidationError(
  toolName: string,
  validationError: string,
  schema?: Record<string, unknown>,
): string {
  const lines: string[] = [
    `Tool '${toolName}' input validation failed: ${validationError}`,
  ];

  if (schema) {
    const properties = schema["properties"] as Record<string, unknown> | undefined;
    const required = schema["required"] as string[] | undefined;

    if (properties) {
      lines.push("");
      lines.push(`Required schema for '${toolName}':`);
      lines.push(JSON.stringify(properties, null, 2));
    }

    if (required && required.length > 0) {
      lines.push("");
      lines.push(`Required fields: ${required.join(", ")}`);
    }
  }

  return lines.join("\n");
}
