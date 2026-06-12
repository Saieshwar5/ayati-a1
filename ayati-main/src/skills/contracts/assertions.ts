import type {
  ArtifactRef,
  JsonSchema,
  ToolContractVerification,
  ToolDefinition,
  ToolResultV2,
  VerifiedFact,
} from "../types.js";
import { runAssertions } from "../../verification/assertion-engine.js";
import { readJsonPathValues } from "../../verification/json-assertions.js";
import { uniqueArtifacts } from "../../verification/artifact-assertions.js";

interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaTypeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function validateSchemaNode(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  const type = schema["type"];
  if (typeof type === "string" && !schemaTypeMatches(value, type)) {
    errors.push(`${path} expected ${type}, got ${Array.isArray(value) ? "array" : typeof value}`);
    return;
  }
  if (Array.isArray(type) && !type.some((item) => typeof item === "string" && schemaTypeMatches(value, item))) {
    errors.push(`${path} expected one of ${type.join(", ")}, got ${Array.isArray(value) ? "array" : typeof value}`);
    return;
  }

  if (schema["type"] === "object" || isRecord(schema["properties"])) {
    if (!isRecord(value)) {
      errors.push(`${path} expected object`);
      return;
    }
    const required = Array.isArray(schema["required"]) ? schema["required"].filter((item): item is string => typeof item === "string") : [];
    for (const field of required) {
      if (value[field] === undefined) {
        errors.push(`${path}.${field} is required`);
      }
    }
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    for (const [field, fieldSchema] of Object.entries(properties)) {
      if (value[field] !== undefined && isRecord(fieldSchema)) {
        validateSchemaNode(value[field], fieldSchema, `${path}.${field}`, errors);
      }
    }
  }

  if ((schema["type"] === "array" || schema["items"]) && Array.isArray(value) && isRecord(schema["items"])) {
    value.forEach((item, index) => validateSchemaNode(item, schema["items"] as JsonSchema, `${path}[${index}]`, errors));
  }
}

export function validateOutputSchema(content: unknown, schema: JsonSchema | undefined): SchemaValidationResult {
  if (!schema) {
    return { valid: true, errors: [] };
  }
  const errors: string[] = [];
  validateSchemaNode(content, schema, "$", errors);
  return { valid: errors.length === 0, errors };
}

function contractRoot(input: unknown, result: ToolResultV2): Record<string, unknown> {
  return {
    input,
    result,
    structuredContent: result.structuredContent,
  };
}

function artifactFromValue(kind: ArtifactRef["kind"], value: unknown): ArtifactRef | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return kind === "file" || kind === "directory"
    ? { kind, path: value }
    : { kind, id: value };
}

function extractArtifacts(tool: ToolDefinition, input: unknown, result: ToolResultV2): ArtifactRef[] {
  const extractors = tool.resultContract?.artifacts ?? [];
  if (extractors.length === 0) {
    return [];
  }
  const root = contractRoot(input, result);
  return uniqueArtifacts(extractors.flatMap((extractor) => (
    readJsonPathValues(root, extractor.path)
      .map((value) => artifactFromValue(extractor.kind, value))
      .filter((artifact): artifact is ArtifactRef => artifact !== null)
  )));
}

function extractProgressFacts(tool: ToolDefinition, input: unknown, result: ToolResultV2): VerifiedFact[] {
  const extractors = tool.resultContract?.progressFacts ?? [];
  if (extractors.length === 0) {
    return [];
  }
  const root = contractRoot(input, result);
  return extractors.flatMap((extractor) => (
    readJsonPathValues(root, extractor.path).map((value) => ({
      kind: extractor.kind,
      message: extractor.message ?? `${extractor.kind}: ${String(value)}`,
      tool: tool.name,
      ...(typeof value === "string" ? { path: value } : { data: { value } }),
    }))
  ));
}

export async function verifyToolContract(
  tool: ToolDefinition,
  input: unknown,
  result: ToolResultV2,
): Promise<ToolContractVerification | undefined> {
  if (!tool.resultContract && !tool.outputSchema) {
    return undefined;
  }

  if (result.operationStatus !== "succeeded") {
    return {
      status: "skipped",
      summary: `Tool contract skipped because operation status is ${result.operationStatus}.`,
      assertions: [],
      facts: [],
      artifacts: result.artifacts ?? [],
    };
  }

  const schemaValidation = validateOutputSchema(result.structuredContent, tool.outputSchema);
  if (!schemaValidation.valid) {
    return {
      status: "failed",
      summary: `Tool output schema validation failed: ${schemaValidation.errors.join("; ")}`,
      assertions: [{
        id: "output_schema_valid",
        kind: "output_schema",
        status: "failed",
        severity: "required",
        message: `Tool output schema validation failed: ${schemaValidation.errors.join("; ")}`,
        expected: tool.outputSchema,
        actual: result.structuredContent,
        error: {
          code: "OUTPUT_SCHEMA_INVALID",
          category: "state_mismatch",
          retryable: true,
          suggestedNextActions: ["Fix the tool implementation so structuredContent matches outputSchema."],
        },
      }],
      facts: [],
      artifacts: result.artifacts ?? [],
    };
  }

  if (!tool.resultContract) {
    return {
      status: "passed",
      summary: `Tool output schema passed for ${tool.name}.`,
      assertions: [{
        id: "output_schema_valid",
        kind: "output_schema",
        status: "passed",
        severity: "required",
        message: `Tool output schema passed for ${tool.name}.`,
        expected: tool.outputSchema,
        actual: result.structuredContent,
      }],
      facts: [],
      artifacts: result.artifacts ?? [],
    };
  }

  const assertionRun = await runAssertions(tool.resultContract.successWhen, {
    toolName: tool.name,
    input,
    result,
  });
  const extractedArtifacts = extractArtifacts(tool, input, result);
  const extractedFacts = extractProgressFacts(tool, input, result);
  const artifacts = uniqueArtifacts([...(result.artifacts ?? []), ...assertionRun.artifacts, ...extractedArtifacts]);
  const facts = [...assertionRun.facts, ...extractedFacts];
  return {
    status: assertionRun.status,
    summary: assertionRun.status === "passed"
      ? `Tool contract passed for ${tool.name}.`
      : `Tool contract failed for ${tool.name}.`,
    assertions: assertionRun.assertions,
    facts,
    artifacts,
  };
}
