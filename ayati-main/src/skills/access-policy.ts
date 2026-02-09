import { getGlobalPolicy, isToolEnabled } from "./tool-access-config.js";
import type { GlobalToolPolicy } from "./tool-access-config.js";

export type ToolAccessPolicy = GlobalToolPolicy;

export function canUseTool(
  toolName: string,
  policy: GlobalToolPolicy = getGlobalPolicy(),
): { allowed: boolean; reason?: string } {
  if (!policy.enabled) {
    return { allowed: false, reason: "Tools are disabled (enabled=false)." };
  }

  if (policy.mode === "off") {
    return { allowed: false, reason: "Tools are disabled (mode=off)." };
  }

  if (policy.mode === "allowlist" && !policy.allowedTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool is not in allowlist: ${toolName}`,
    };
  }

  if (!isToolEnabled(toolName)) {
    return { allowed: false, reason: `Tool disabled in config: ${toolName}` };
  }

  return { allowed: true };
}
