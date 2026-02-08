export type ToolAccessMode = "off" | "allowlist" | "full";

export interface ToolAccessPolicy {
  enabled: boolean;
  mode: ToolAccessMode;
  allowedTools: string[];
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function parseMode(raw: string | undefined): ToolAccessMode {
  if (raw === "off" || raw === "allowlist" || raw === "full") {
    return raw;
  }
  return "full";
}

function parseList(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function getToolAccessPolicy(): ToolAccessPolicy {
  return {
    enabled: parseBool(process.env["TOOLS_ENABLED"], true),
    mode: parseMode(process.env["TOOLS_MODE"]),
    allowedTools: parseList(process.env["TOOLS_ALLOWED"]),
  };
}

export function canUseTool(toolName: string, policy = getToolAccessPolicy()): {
  allowed: boolean;
  reason?: string;
} {
  if (!policy.enabled) {
    return { allowed: false, reason: "Tools are disabled by TOOLS_ENABLED." };
  }

  if (policy.mode === "off") {
    return { allowed: false, reason: "Tools are disabled by TOOLS_MODE=off." };
  }

  if (policy.mode === "allowlist" && !policy.allowedTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool is not in TOOLS_ALLOWED allowlist: ${toolName}`,
    };
  }

  return { allowed: true };
}
