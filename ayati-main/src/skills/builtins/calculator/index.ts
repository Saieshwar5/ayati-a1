import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";
import { commonAnnotations, errorResult, okResult, succeededContract, successV2 } from "../contract-helpers.js";
import { calculate } from "./evaluator.js";
import {
  CALCULATOR_LIMITS,
  CALCULATOR_PRECISION_DIGITS,
  CALCULATOR_ROUNDING_MODE,
} from "./limits.js";
import { CalcError } from "./types.js";

interface CalcInput {
  expression: string;
}

function validateInput(input: unknown): CalcInput | ToolResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Invalid input: expected object." };
  }

  const v = input as Partial<CalcInput>;
  if (typeof v.expression !== "string" || v.expression.trim().length === 0) {
    return { ok: false, error: "Invalid input: expression must be a non-empty string." };
  }

  return { expression: v.expression.trim() };
}

export const calculatorTool: ToolDefinition = {
  name: "calculator",
  description: "Evaluate a bounded real-valued expression with 50-significant-digit decimal arithmetic.",
  inputSchema: {
    type: "object",
    required: ["expression"],
    properties: {
      expression: {
        type: "string",
        maxLength: CALCULATOR_LIMITS.expressionCharacters,
        description: "Real-valued expression. Prefer explicit *; trigonometric arguments use radians.",
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["expression", "result", "finite", "precisionDigits", "roundingMode"],
    properties: {
      expression: { type: "string" },
      result: { type: "string" },
      finite: { type: "boolean" },
      precisionDigits: { type: "integer" },
      roundingMode: { type: "string" },
    },
  },
  annotations: commonAnnotations({
    domain: "calculator",
    readOnly: true,
    idempotent: true,
    retrySafe: true,
  }),
  resultContract: succeededContract({
    assertions: [{
      id: "calculation_result_present",
      kind: "json_path_exists",
      path: "$.result.structuredContent.result",
    }, {
      id: "calculation_result_finite",
      kind: "json_path_equals",
      path: "$.result.structuredContent.finite",
      value: true,
    }],
    progressFacts: [
      {
        kind: "calculation_evaluated",
        path: "$.result.structuredContent.expression",
        message: "Calculator expression evaluated to a finite real value.",
      },
      {
        kind: "calculation_result",
        path: "$.result.structuredContent.result",
        message: "Finite calculator result produced.",
      },
    ],
  }),
  async execute(input): Promise<ToolResult> {
    const parsed = validateInput(input);
    if ("ok" in parsed) {
      return parsed;
    }

    const start = Date.now();

    try {
      const result = calculate(parsed.expression);
      const durationMs = Date.now() - start;
      const structuredContent = {
        expression: parsed.expression,
        result,
        finite: true,
        precisionDigits: CALCULATOR_PRECISION_DIGITS,
        roundingMode: CALCULATOR_ROUNDING_MODE,
      };
      const meta = {
        expression: parsed.expression,
        durationMs,
        precisionDigits: CALCULATOR_PRECISION_DIGITS,
        roundingMode: CALCULATOR_ROUNDING_MODE,
      };
      return okResult({
        output: result,
        meta,
        v2: successV2({
          code: "CALCULATION_EVALUATED",
          message: "Calculation evaluated.",
          structuredContent,
          diagnostics: meta,
        }),
      });
    } catch (err) {
      if (err instanceof CalcError) {
        const meta = {
            expression: parsed.expression,
            durationMs: Date.now() - start,
            errorCode: err.code,
            errorPos: err.pos,
        };
        return errorResult({
          code: err.code,
          message: `${err.code}: ${err.message}`,
          category: "validation",
          target: parsed.expression,
          actual: err.pos,
          retryable: true,
          recoverable: true,
          suggestedNextActions: ["Correct the calculator expression and retry."],
          structuredContent: { expression: parsed.expression },
          meta,
        });
      }
      const message = err instanceof Error ? err.message : "Unknown calculator error";
      return errorResult({
        code: "CALCULATION_FAILED",
        message,
        category: "semantic",
        target: parsed.expression,
        retryable: true,
        recoverable: true,
        suggestedNextActions: ["Inspect the expression and retry with a supported calculator operation."],
        structuredContent: { expression: parsed.expression },
        meta: {
          expression: parsed.expression,
          durationMs: Date.now() - start,
        },
      });
    }
  },
};

const calculatorSkill: SkillDefinition = {
  id: "calculator",
  version: "1.0.0",
  description: "Bounded real-valued calculator with 50-significant-digit decimal arithmetic.",
  tools: [calculatorTool],
};

export default calculatorSkill;
