import type { SupportedLlmProvider } from "../../config/llm-runtime-config.js";
import type { LlmProviderCapabilities, LlmResponseFormat } from "../../core/contracts/llm-protocol.js";

interface StructuredOutputProfile {
  jsonObject: boolean;
  jsonSchema: boolean;
  validateJsonSchema?: (schema: Record<string, unknown>, strict: boolean) => boolean;
}

interface ToolNamePolicy {
  pattern: RegExp;
  maxLength?: number;
}

export interface ProviderProfile {
  capabilities: LlmProviderCapabilities;
  toolNames: ToolNamePolicy;
}

const DEFAULT_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

const OPENAI_TOOL_NAMES: ToolNamePolicy = {
  pattern: DEFAULT_TOOL_NAME_PATTERN,
  maxLength: 64,
};

const FIREWORKS_TOOL_NAMES: ToolNamePolicy = {
  pattern: DEFAULT_TOOL_NAME_PATTERN,
  maxLength: 64,
};

const OPENROUTER_TOOL_NAMES: ToolNamePolicy = {
  pattern: DEFAULT_TOOL_NAME_PATTERN,
  maxLength: 64,
};

const ANTHROPIC_TOOL_NAMES: ToolNamePolicy = {
  pattern: DEFAULT_TOOL_NAME_PATTERN,
  maxLength: 64,
};

const OPENAI_STRUCTURED_OUTPUT: StructuredOutputProfile = {
  jsonObject: true,
  jsonSchema: true,
  validateJsonSchema(schema, strict) {
    if (schema.type !== "object") return false;
    for (const key of ["oneOf", "anyOf", "allOf", "enum", "not"]) {
      if (key in schema) return false;
    }
    return validateSchemaNode(schema, {
      requireStrictObjects: strict,
      allowAnyOf: true,
      allowAllOf: false,
      allowOneOf: false,
      allowNot: false,
    });
  },
};

const FIREWORKS_STRUCTURED_OUTPUT: StructuredOutputProfile = {
  jsonObject: true,
  jsonSchema: true,
  validateJsonSchema(schema) {
    return validateSchemaNode(schema, {
      requireStrictObjects: false,
      allowAnyOf: true,
      allowAllOf: true,
      allowOneOf: false,
      allowNot: false,
    });
  },
};

const OPENROUTER_STRUCTURED_OUTPUT: StructuredOutputProfile = {
  jsonObject: false,
  jsonSchema: false,
};

const ANTHROPIC_STRUCTURED_OUTPUT: StructuredOutputProfile = {
  jsonObject: false,
  jsonSchema: false,
};

export const PROVIDER_PROFILES: Record<SupportedLlmProvider, ProviderProfile> = {
  openai: {
    capabilities: {
      nativeToolCalling: true,
      structuredOutput: {
        jsonObject: OPENAI_STRUCTURED_OUTPUT.jsonObject,
        jsonSchema: OPENAI_STRUCTURED_OUTPUT.jsonSchema,
      },
    },
    toolNames: OPENAI_TOOL_NAMES,
  },
  anthropic: {
    capabilities: {
      nativeToolCalling: true,
      structuredOutput: {
        jsonObject: ANTHROPIC_STRUCTURED_OUTPUT.jsonObject,
        jsonSchema: ANTHROPIC_STRUCTURED_OUTPUT.jsonSchema,
      },
    },
    toolNames: ANTHROPIC_TOOL_NAMES,
  },
  openrouter: {
    capabilities: {
      nativeToolCalling: true,
      structuredOutput: {
        jsonObject: OPENROUTER_STRUCTURED_OUTPUT.jsonObject,
        jsonSchema: OPENROUTER_STRUCTURED_OUTPUT.jsonSchema,
      },
    },
    toolNames: OPENROUTER_TOOL_NAMES,
  },
  fireworks: {
    capabilities: {
      nativeToolCalling: true,
      structuredOutput: {
        jsonObject: FIREWORKS_STRUCTURED_OUTPUT.jsonObject,
        jsonSchema: FIREWORKS_STRUCTURED_OUTPUT.jsonSchema,
      },
    },
    toolNames: FIREWORKS_TOOL_NAMES,
  },
};

export function getProviderCapabilities(provider: SupportedLlmProvider): LlmProviderCapabilities {
  return cloneCapabilities(PROVIDER_PROFILES[provider].capabilities);
}

export function getProviderToolNamePolicy(providerName: string): ToolNamePolicy {
  const profile = getKnownProviderProfile(providerName);
  return profile?.toolNames ?? { pattern: DEFAULT_TOOL_NAME_PATTERN };
}

export function compileResponseFormatForProvider(
  providerName: string,
  capabilities: LlmProviderCapabilities,
  preferred: LlmResponseFormat | undefined,
): LlmResponseFormat | undefined {
  if (!preferred) return undefined;

  const structuredOutput = capabilities.structuredOutput;
  if (!structuredOutput) return undefined;

  if (preferred.type === "json_object") {
    return structuredOutput.jsonObject ? preferred : undefined;
  }

  if (preferred.type !== "json_schema") {
    return undefined;
  }

  const validator = getStructuredOutputProfile(providerName)?.validateJsonSchema;
  const schemaAllowed = structuredOutput.jsonSchema
    && (!validator || validator(preferred.schema, preferred.strict === true));

  if (schemaAllowed) {
    return preferred;
  }

  if (structuredOutput.jsonObject) {
    return { type: "json_object" };
  }

  return undefined;
}

function getStructuredOutputProfile(providerName: string): StructuredOutputProfile | undefined {
  switch (providerName) {
    case "openai":
      return OPENAI_STRUCTURED_OUTPUT;
    case "fireworks":
      return FIREWORKS_STRUCTURED_OUTPUT;
    case "openrouter":
      return OPENROUTER_STRUCTURED_OUTPUT;
    case "anthropic":
      return ANTHROPIC_STRUCTURED_OUTPUT;
    default:
      return undefined;
  }
}

function getKnownProviderProfile(providerName: string): ProviderProfile | undefined {
  if (providerName in PROVIDER_PROFILES) {
    return PROVIDER_PROFILES[providerName as SupportedLlmProvider];
  }
  return undefined;
}

function cloneCapabilities(capabilities: LlmProviderCapabilities): LlmProviderCapabilities {
  return {
    nativeToolCalling: capabilities.nativeToolCalling,
    ...(capabilities.structuredOutput
      ? {
          structuredOutput: {
            jsonObject: capabilities.structuredOutput.jsonObject,
            jsonSchema: capabilities.structuredOutput.jsonSchema,
          },
        }
      : {}),
  };
}

function validateSchemaNode(
  value: unknown,
  options: {
    requireStrictObjects: boolean;
    allowAnyOf: boolean;
    allowAllOf: boolean;
    allowOneOf: boolean;
    allowNot: boolean;
  },
): boolean {
  if (!isPlainObject(value)) return true;

  if ("oneOf" in value && !options.allowOneOf) return false;
  if ("allOf" in value && !options.allowAllOf) return false;
  if ("not" in value && !options.allowNot) return false;
  if ("anyOf" in value && !options.allowAnyOf) return false;

  if (isObjectSchema(value)) {
    if (options.requireStrictObjects && value["additionalProperties"] !== false) {
      return false;
    }

    const properties = getObjectPropertyMap(value["properties"]);
    if (options.requireStrictObjects && !requiredMatchesProperties(value["required"], properties)) {
      return false;
    }

    for (const propertySchema of Object.values(properties)) {
      if (!validateSchemaNode(propertySchema, options)) {
        return false;
      }
    }
  }

  const items = value["items"];
  if (items !== undefined) {
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!validateSchemaNode(item, options)) {
          return false;
        }
      }
    } else if (!validateSchemaNode(items, options)) {
      return false;
    }
  }

  const anyOf = value["anyOf"];
  if (Array.isArray(anyOf)) {
    for (const item of anyOf) {
      if (!validateSchemaNode(item, options)) {
        return false;
      }
    }
  }

  const allOf = value["allOf"];
  if (Array.isArray(allOf)) {
    for (const item of allOf) {
      if (!validateSchemaNode(item, options)) {
        return false;
      }
    }
  }

  const oneOf = value["oneOf"];
  if (Array.isArray(oneOf)) {
    for (const item of oneOf) {
      if (!validateSchemaNode(item, options)) {
        return false;
      }
    }
  }

  const defs = value["$defs"];
  if (isPlainObject(defs)) {
    for (const schema of Object.values(defs)) {
      if (!validateSchemaNode(schema, options)) {
        return false;
      }
    }
  }

  const definitions = value["definitions"];
  if (isPlainObject(definitions)) {
    for (const schema of Object.values(definitions)) {
      if (!validateSchemaNode(schema, options)) {
        return false;
      }
    }
  }

  if (isPlainObject(value["additionalProperties"])) {
    return validateSchemaNode(value["additionalProperties"], options);
  }

  return true;
}

function isObjectSchema(value: Record<string, unknown>): boolean {
  return value["type"] === "object" || isPlainObject(value["properties"]);
}

function getObjectPropertyMap(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function requiredMatchesProperties(requiredValue: unknown, properties: Record<string, unknown>): boolean {
  const propertyKeys = Object.keys(properties).sort();
  const required = Array.isArray(requiredValue)
    ? requiredValue.filter((entry): entry is string => typeof entry === "string").sort()
    : [];

  if (required.length !== propertyKeys.length) {
    return false;
  }

  return propertyKeys.every((key, index) => key === required[index]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
