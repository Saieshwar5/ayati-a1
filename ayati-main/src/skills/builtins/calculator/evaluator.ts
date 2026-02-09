import { type Decimal } from "decimal.js";
import { CalcDecimal, callFunction, factorial, getConstant, CONSTANTS, FUNCTIONS } from "./functions.js";
import { CalcError, type ASTNode } from "./types.js";
import { tokenize } from "./tokenizer.js";
import { parse } from "./parser.js";

type Dec = InstanceType<typeof Decimal>;

function parseNumberLiteral(value: string): Dec {
  if (value.startsWith("0x") || value.startsWith("0X") ||
      value.startsWith("0b") || value.startsWith("0B") ||
      value.startsWith("0o") || value.startsWith("0O")) {
    return new CalcDecimal(Number(value));
  }
  return new CalcDecimal(value);
}

export function evaluate(node: ASTNode): Dec {
  switch (node.kind) {
    case "number":
      return parseNumberLiteral(node.value);

    case "ident": {
      const val = CONSTANTS[node.name];
      if (val !== undefined) return val;
      if (FUNCTIONS[node.name]) {
        throw new CalcError(
          `'${node.name}' is a function — use ${node.name}(...)`,
          node.pos,
          "UNKNOWN_CONSTANT",
        );
      }
      return getConstant(node.name, node.pos);
    }

    case "unary":
      if (node.op === "+") return evaluate(node.operand);
      return evaluate(node.operand).negated();

    case "binary": {
      const left = evaluate(node.left);
      const right = evaluate(node.right);
      switch (node.op) {
        case "+": return left.plus(right);
        case "-": return left.minus(right);
        case "*": return left.times(right);
        case "/": {
          if (right.isZero()) {
            throw new CalcError("Division by zero", node.pos, "DIVISION_BY_ZERO");
          }
          return left.dividedBy(right);
        }
        case "^": return left.pow(right);
      }
      break;
    }

    case "postfix":
      if (node.op === "%") return evaluate(node.operand).dividedBy(100);
      if (node.op === "!") return factorial(evaluate(node.operand), node.pos);
      break;

    case "call": {
      const args = node.args.map((a) => evaluate(a));
      return callFunction(node.name, args, node.pos);
    }
  }

  throw new CalcError("Evaluation error", 0, "UNEXPECTED_TOKEN");
}

export function formatResult(d: Dec): string {
  if (d.isInteger()) return d.toFixed(0);
  return d.toString();
}

export function calculate(expression: string): string {
  const tokens = tokenize(expression);
  const ast = parse(tokens);
  const result = evaluate(ast);
  return formatResult(result);
}
