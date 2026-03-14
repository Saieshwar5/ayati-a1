import { createHash } from "node:crypto";
import type { LlmToolSchema } from "../../core/contracts/llm-protocol.js";
import { getProviderToolNamePolicy } from "./provider-profiles.js";

export interface ToolNameMaps {
  canonicalToProvider: Map<string, string>;
  providerToCanonical: Map<string, string>;
}

export function buildToolNameMapsForProvider(
  providerName: string,
  tools?: LlmToolSchema[],
): ToolNameMaps {
  const policy = getProviderToolNamePolicy(providerName);
  const canonicalToProvider = new Map<string, string>();
  const providerToCanonical = new Map<string, string>();

  for (const tool of tools ?? []) {
    let providerNameValue = toSafeToolName(tool.name, policy.pattern, policy.maxLength);
    let suffix = 1;

    while (providerToCanonical.has(providerNameValue)) {
      providerNameValue = appendToolNameSuffix(providerNameValue, suffix, policy.maxLength);
      suffix++;
    }

    canonicalToProvider.set(tool.name, providerNameValue);
    providerToCanonical.set(providerNameValue, tool.name);
  }

  return { canonicalToProvider, providerToCanonical };
}

export function toProviderToolName(name: string, maps: ToolNameMaps): string {
  return maps.canonicalToProvider.get(name) ?? name;
}

export function toCanonicalToolName(name: string, maps: ToolNameMaps): string {
  return maps.providerToCanonical.get(name) ?? name;
}

function toSafeToolName(name: string, pattern: RegExp, maxLength?: number): string {
  const effectiveMaxLength = maxLength && maxLength > 0 ? maxLength : Number.POSITIVE_INFINITY;
  if (pattern.test(name) && name.length <= effectiveMaxLength) {
    return name;
  }

  const slug = slugifyToolName(name);
  const hash = createHash("sha256").update(name).digest("base64url").slice(0, 12);
  const prefix = slug.startsWith("tool_") ? slug : `tool_${slug}`;
  const separator = "_";
  const maxPrefixLength = Math.max(1, effectiveMaxLength - hash.length - separator.length);
  const truncatedPrefix = prefix.slice(0, maxPrefixLength).replace(/_+$/g, "") || "tool";
  return `${truncatedPrefix}${separator}${hash}`;
}

function appendToolNameSuffix(name: string, suffix: number, maxLength?: number): string {
  const suffixText = `_${suffix}`;
  if (!maxLength || name.length + suffixText.length <= maxLength) {
    return `${name}${suffixText}`;
  }

  const truncated = name.slice(0, Math.max(1, maxLength - suffixText.length)).replace(/_+$/g, "") || "tool";
  return `${truncated}${suffixText}`;
}

function slugifyToolName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "tool";
}
