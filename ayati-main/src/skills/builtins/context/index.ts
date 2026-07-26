import type { HotContextRuntime } from "../../../ivec/hot-context/runtime.js";
import type {
  SkillDefinition,
  ToolDefinition,
  ToolResult,
} from "../../types.js";
import {
  commonAnnotations,
  errorResult,
  okJsonResult,
  succeededContract,
} from "../contract-helpers.js";

export interface ContextSkillOptions {
  hotContextRuntime: HotContextRuntime;
}

export function createContextSkill(options: ContextSkillOptions): SkillDefinition {
  return {
    id: "context",
    version: "1.0.0",
    description: "Load bounded optional context into the current run.",
    tools: [createContextLoadTool(options.hotContextRuntime)],
  };
}

function createContextLoadTool(runtime: HotContextRuntime): ToolDefinition {
  const availableKeys = runtime.keys();
  return {
    name: "context_load",
    description: "Load one or more available Hot Context entries into the current run's context pack. Returns only a mount receipt.",
    inputSchema: {
      type: "object",
      properties: {
        keys: {
          type: "array",
          minItems: 1,
          maxItems: runtime.maxKeysPerLoad,
          uniqueItems: true,
          items: {
            type: "string",
            enum: availableKeys,
          },
        },
      },
      required: ["keys"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        loaded: { type: "array", items: { type: "string" } },
        alreadyLoaded: { type: "array", items: { type: "string" } },
        rejected: { type: "array", items: { type: "object" } },
        mountedTokens: { type: "integer" },
        maxMountedTokens: { type: "integer" },
      },
      required: [
        "loaded",
        "alreadyLoaded",
        "rejected",
        "mountedTokens",
        "maxMountedTokens",
      ],
      additionalProperties: false,
    },
    annotations: commonAnnotations({
      domain: "context",
      readOnly: true,
      idempotent: true,
      retrySafe: true,
    }),
    observationPolicy: {
      outputImportance: "none",
      rawStorage: "never",
    },
    resultContract: succeededContract(),
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseInput(input, runtime.maxKeysPerLoad);
      if (!parsed || !context?.clientId || !context.runId) {
        return loadError(
          "Hot Context loading requires keys plus the current client and run identity.",
        );
      }
      const receipt = runtime.load({
        clientId: context.clientId,
        runId: context.runId,
        keys: parsed.keys,
        stepNumber: context.stepNumber ?? 0,
      });
      if (
        receipt.loaded.length === 0
        && receipt.alreadyLoaded.length === 0
      ) {
        return errorResult({
          code: "HOT_CONTEXT_NOT_LOADED",
          message: "No requested Hot Context entry could be loaded.",
          category: "semantic",
          retryable: false,
          recoverable: true,
          suggestedNextActions: [
            "Use a key shown in context.hot.available or continue without optional context.",
          ],
          structuredContent: receipt,
        });
      }
      return okJsonResult({
        code: "HOT_CONTEXT_LOADED",
        message: "Mounted the requested Hot Context entries for this run.",
        structuredContent: receipt,
        meta: {
          stateUpdates: [{ type: "sync_hot_context_mounts" }],
        },
      });
    },
  };
}

function parseInput(
  value: unknown,
  maxKeys: number,
): { keys: string[] } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record["keys"])) return undefined;
  const keys = [...new Set(record["keys"]
    .filter((key): key is string => typeof key === "string")
    .map((key) => key.trim())
    .filter(Boolean))];
  if (keys.length === 0 || keys.length > maxKeys) return undefined;
  return { keys };
}

function loadError(message: string): ToolResult {
  return errorResult({
    code: "HOT_CONTEXT_LOAD_INVALID",
    message,
    category: "validation",
    retryable: false,
    recoverable: true,
    suggestedNextActions: [
      "Call context_load with one or more exact keys shown in context.hot.available.",
    ],
  });
}
