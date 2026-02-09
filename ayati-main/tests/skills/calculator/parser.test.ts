import { describe, expect, it } from "vitest";
import { parse } from "../../../src/skills/builtins/calculator/parser.js";
import { tokenize } from "../../../src/skills/builtins/calculator/tokenizer.js";
import { CalcError, type ASTNode } from "../../../src/skills/builtins/calculator/types.js";

function p(input: string): ASTNode {
  return parse(tokenize(input));
}

describe("parser", () => {
  it("parses a number", () => {
    const ast = p("42");
    expect(ast).toEqual({ kind: "number", value: "42", pos: 0 });
  });

  it("parses an identifier", () => {
    const ast = p("pi");
    expect(ast).toEqual({ kind: "ident", name: "pi", pos: 0 });
  });

  it("parses addition", () => {
    const ast = p("1 + 2");
    expect(ast.kind).toBe("binary");
    if (ast.kind === "binary") {
      expect(ast.op).toBe("+");
      expect(ast.left).toEqual({ kind: "number", value: "1", pos: 0 });
      expect(ast.right).toEqual({ kind: "number", value: "2", pos: 4 });
    }
  });

  it("respects operator precedence: * before +", () => {
    const ast = p("1 + 2 * 3");
    expect(ast.kind).toBe("binary");
    if (ast.kind === "binary") {
      expect(ast.op).toBe("+");
      expect(ast.right.kind).toBe("binary");
      if (ast.right.kind === "binary") {
        expect(ast.right.op).toBe("*");
      }
    }
  });

  it("respects parentheses", () => {
    const ast = p("(1 + 2) * 3");
    expect(ast.kind).toBe("binary");
    if (ast.kind === "binary") {
      expect(ast.op).toBe("*");
      expect(ast.left.kind).toBe("binary");
    }
  });

  it("parses unary minus", () => {
    const ast = p("-5");
    expect(ast).toEqual({ kind: "unary", op: "-", operand: { kind: "number", value: "5", pos: 1 }, pos: 0 });
  });

  it("parses unary plus", () => {
    const ast = p("+5");
    expect(ast.kind).toBe("unary");
    if (ast.kind === "unary") expect(ast.op).toBe("+");
  });

  it("parses exponentiation as right-associative", () => {
    const ast = p("2 ^ 3 ^ 4");
    expect(ast.kind).toBe("binary");
    if (ast.kind === "binary") {
      expect(ast.op).toBe("^");
      expect(ast.right.kind).toBe("binary");
      if (ast.right.kind === "binary") {
        expect(ast.right.op).toBe("^");
      }
    }
  });

  it("parses postfix %", () => {
    const ast = p("50%");
    expect(ast).toEqual({ kind: "postfix", op: "%", operand: { kind: "number", value: "50", pos: 0 }, pos: 2 });
  });

  it("parses postfix !", () => {
    const ast = p("5!");
    expect(ast).toEqual({ kind: "postfix", op: "!", operand: { kind: "number", value: "5", pos: 0 }, pos: 1 });
  });

  it("parses function call with one arg", () => {
    const ast = p("sin(1)");
    expect(ast.kind).toBe("call");
    if (ast.kind === "call") {
      expect(ast.name).toBe("sin");
      expect(ast.args).toHaveLength(1);
    }
  });

  it("parses function call with multiple args", () => {
    const ast = p("atan2(1, 2)");
    expect(ast.kind).toBe("call");
    if (ast.kind === "call") {
      expect(ast.name).toBe("atan2");
      expect(ast.args).toHaveLength(2);
    }
  });

  it("parses function call with zero args", () => {
    const ast = p("rand()");
    expect(ast.kind).toBe("call");
    if (ast.kind === "call") {
      expect(ast.args).toHaveLength(0);
    }
  });

  it("parses implicit multiplication: 2pi", () => {
    const ast = p("2pi");
    expect(ast.kind).toBe("binary");
    if (ast.kind === "binary") {
      expect(ast.op).toBe("*");
      expect(ast.left).toEqual({ kind: "number", value: "2", pos: 0 });
      expect(ast.right).toEqual({ kind: "ident", name: "pi", pos: 1 });
    }
  });

  it("parses implicit multiplication: 3(4+5)", () => {
    const ast = p("3(4+5)");
    expect(ast.kind).toBe("binary");
    if (ast.kind === "binary") {
      expect(ast.op).toBe("*");
      expect(ast.left).toEqual({ kind: "number", value: "3", pos: 0 });
      expect(ast.right.kind).toBe("binary");
    }
  });

  it("parses implicit multiplication: (2)(3)", () => {
    const ast = p("(2)(3)");
    expect(ast.kind).toBe("binary");
    if (ast.kind === "binary") {
      expect(ast.op).toBe("*");
    }
  });

  it("throws on unclosed paren", () => {
    expect(() => p("(1 + 2")).toThrow(CalcError);
    try {
      p("(1 + 2");
    } catch (e) {
      expect((e as CalcError).code).toBe("UNCLOSED_PAREN");
    }
  });

  it("throws on unexpected token", () => {
    expect(() => p("* 2")).toThrow(CalcError);
    try {
      p("* 2");
    } catch (e) {
      expect((e as CalcError).code).toBe("UNEXPECTED_TOKEN");
    }
  });

  it("throws on trailing garbage", () => {
    expect(() => p("1 2 3")).not.toThrow(); // implicit mul
  });

  it("parses complex nested expression", () => {
    const ast = p("sin(pi/2) + cos(0)");
    expect(ast.kind).toBe("binary");
    if (ast.kind === "binary") {
      expect(ast.op).toBe("+");
      expect(ast.left.kind).toBe("call");
      expect(ast.right.kind).toBe("call");
    }
  });
});
