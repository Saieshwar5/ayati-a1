import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";
import { commonAnnotations, errorResult, okResult, succeededContract, successV2 } from "../contract-helpers.js";
import { calculate } from "./evaluator.js";
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
  description: "Evaluate a mathematical expression with arbitrary-precision decimal arithmetic.",
  inputSchema: {
    type: "object",
    required: ["expression"],
    properties: {
      expression: { type: "string", description: "Mathematical expression to evaluate." },
    },
  },
  outputSchema: {
    type: "object",
    required: ["expression", "result"],
    properties: {
      expression: { type: "string" },
      result: { type: "string" },
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
    }],
    progressFacts: [{
      kind: "calculation_evaluated",
      path: "$.result.structuredContent.expression",
      message: "Calculator expression evaluated.",
    }],
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
      };
      const meta = {
        expression: parsed.expression,
        durationMs,
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

const CALC_PROMPT_BLOCK = [
  "The `calculator` tool is built in.",
  "Use it directly for mathematical computation instead of mental math.",
  "Supports: arithmetic, exponents, trig, logs, factorial, combinatorics, constants (pi, e, tau, phi).",
  "Supports hex (0xFF), binary (0b1010), octal (0o77), scientific notation (1.5e10).",
  "Implicit multiplication: 2pi, 3(4+5). Percentage: 50% = 0.5. Factorial: 5! = 120.",
  "All computation uses arbitrary-precision decimal arithmetic — no floating-point errors.",
].join("\n");

const calculatorSkill: SkillDefinition = {
  id: "calculator",
  version: "1.0.0",
  description: "Arbitrary-precision calculator with full math function support.",
  promptBlock: CALC_PROMPT_BLOCK,
  tools: [calculatorTool],
};

export default calculatorSkill;
