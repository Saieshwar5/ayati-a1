import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";
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
  async execute(input): Promise<ToolResult> {
    const parsed = validateInput(input);
    if ("ok" in parsed) {
      return parsed;
    }

    const start = Date.now();

    try {
      const result = calculate(parsed.expression);
      return {
        ok: true,
        output: result,
        meta: {
          expression: parsed.expression,
          durationMs: Date.now() - start,
        },
      };
    } catch (err) {
      if (err instanceof CalcError) {
        return {
          ok: false,
          error: `${err.code}: ${err.message}`,
          meta: {
            expression: parsed.expression,
            durationMs: Date.now() - start,
            errorCode: err.code,
            errorPos: err.pos,
          },
        };
      }
      const message = err instanceof Error ? err.message : "Unknown calculator error";
      return {
        ok: false,
        error: message,
        meta: {
          expression: parsed.expression,
          durationMs: Date.now() - start,
        },
      };
    }
  },
};

const CALC_PROMPT_BLOCK = [
  "Calculator Skill is available.",
  "Use calculator for any mathematical computation — do NOT attempt mental math.",
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
