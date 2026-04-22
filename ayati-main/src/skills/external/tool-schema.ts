import type { ExternalToolUsage } from "./types.js";

const DISALLOWED_SCHEMA_KEYS = new Set([
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "$ref",
  "$defs",
  "definitions",
]);

const ALLOWED_PRIMITIVE_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectUsageFragments(usage: ExternalToolUsage | undefined): string[] {
  if (!usage) {
    return [];
  }

  const fragments: string[] = [];
  const whenToUse = usage.whenToUse?.trim();
  if (whenToUse) {
    fragments.push(`Use when: ${whenToUse}`);
  }

  const notFor = usage.notFor?.trim();
  if (notFor) {
    fragments.push(`Do not use: ${notFor}`);
  }

  const preconditions = (usage.preconditions ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (preconditions.length > 0) {
    fragments.push(`Preconditions: ${preconditions.join("; ")}`);
  }

  const returns = usage.returns?.trim();
  if (returns) {
    fragments.push(`Returns: ${returns}`);
  }

  return fragments;
}

export function buildExternalToolDescription(
  baseDescription: string,
  usage: ExternalToolUsage | undefined,
): string {
  const description = baseDescription.trim();
  const fragments = collectUsageFragments(usage);
  if (fragments.length === 0) {
    return description;
  }
  return [description, ...fragments].filter((part) => part.length > 0).join(" ");
}

export function validatePortableToolInputSchema(
  schema: unknown,
): { ok: true } | { ok: false; error: string } {
  if (!isPlainObject(schema)) {
    return { ok: false, error: "inputSchema must be an object." };
  }

  if (schema["type"] !== "object") {
    return { ok: false, error: "inputSchema root must use type \"object\"." };
  }

  const result = validateSchemaNode(schema, "inputSchema");
  return result.ok ? result : result;
}

function validateSchemaNode(
  value: unknown,
  path: string,
): { ok: true } | { ok: false; error: string } {
  if (!isPlainObject(value)) {
    return { ok: false, error: `${path} must be a schema object.` };
  }

  for (const key of DISALLOWED_SCHEMA_KEYS) {
    if (key in value) {
      return { ok: false, error: `${path} uses unsupported schema keyword "${key}".` };
    }
  }

  const type = value["type"];
  const hasEnum = Array.isArray(value["enum"]);
  if (typeof type !== "string") {
    return { ok: false, error: `${path} must declare an explicit type.` };
  }
  if (!ALLOWED_PRIMITIVE_TYPES.has(type) && !hasEnum) {
    return { ok: false, error: `${path} uses unsupported type "${type}".` };
  }

  if (type === "object") {
    const propertiesValue = value["properties"];
    if (propertiesValue !== undefined && !isPlainObject(propertiesValue)) {
      return { ok: false, error: `${path}.properties must be an object.` };
    }

    const properties = (propertiesValue ?? {}) as Record<string, unknown>;
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      const validation = validateSchemaNode(propertySchema, `${path}.properties.${propertyName}`);
      if (!validation.ok) {
        return validation;
      }
    }

    const additionalProperties = value["additionalProperties"];
    if (isPlainObject(additionalProperties)) {
      const validation = validateSchemaNode(additionalProperties, `${path}.additionalProperties`);
      if (!validation.ok) {
        return validation;
      }
    } else if (additionalProperties !== undefined && typeof additionalProperties !== "boolean") {
      return {
        ok: false,
        error: `${path}.additionalProperties must be a boolean or schema object.`,
      };
    }

    const required = value["required"];
    if (required !== undefined) {
      if (!Array.isArray(required) || required.some((entry) => typeof entry !== "string")) {
        return { ok: false, error: `${path}.required must be an array of strings.` };
      }
    }

    return { ok: true };
  }

  if (type === "array") {
    if (!("items" in value)) {
      return { ok: false, error: `${path} must declare items for array schemas.` };
    }
    return validateSchemaNode(value["items"], `${path}.items`);
  }

  if (hasEnum && !Array.isArray(value["enum"])) {
    return { ok: false, error: `${path}.enum must be an array.` };
  }

  return { ok: true };
}
