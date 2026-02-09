import { describe, expect, it } from "vitest";
import { tokenize } from "../../../src/skills/builtins/calculator/tokenizer.js";
import { CalcError } from "../../../src/skills/builtins/calculator/types.js";

describe("tokenizer", () => {
  it("tokenizes integers", () => {
    const tokens = tokenize("42");
    expect(tokens[0]).toEqual({ type: "NUMBER", value: "42", pos: 0 });
    expect(tokens[1]!.type).toBe("EOF");
  });

  it("tokenizes decimals", () => {
    const tokens = tokenize("3.14");
    expect(tokens[0]).toEqual({ type: "NUMBER", value: "3.14", pos: 0 });
  });

  it("tokenizes leading-dot decimals", () => {
    const tokens = tokenize(".5");
    expect(tokens[0]).toEqual({ type: "NUMBER", value: ".5", pos: 0 });
  });

  it("tokenizes scientific notation", () => {
    const tokens = tokenize("1.5e10");
    expect(tokens[0]).toEqual({ type: "NUMBER", value: "1.5e10", pos: 0 });
  });

  it("tokenizes scientific notation with sign", () => {
    const tokens = tokenize("1e-3");
    expect(tokens[0]).toEqual({ type: "NUMBER", value: "1e-3", pos: 0 });
  });

  it("tokenizes hex numbers", () => {
    const tokens = tokenize("0xFF");
    expect(tokens[0]).toEqual({ type: "NUMBER", value: "0xFF", pos: 0 });
  });

  it("tokenizes binary numbers", () => {
    const tokens = tokenize("0b1010");
    expect(tokens[0]).toEqual({ type: "NUMBER", value: "0b1010", pos: 0 });
  });

  it("tokenizes octal numbers", () => {
    const tokens = tokenize("0o77");
    expect(tokens[0]).toEqual({ type: "NUMBER", value: "0o77", pos: 0 });
  });

  it("tokenizes all operators", () => {
    const tokens = tokenize("+ - * / ^ % !");
    const types = tokens.map((t) => t.type);
    expect(types).toEqual(["PLUS", "MINUS", "STAR", "SLASH", "CARET", "PERCENT", "BANG", "EOF"]);
  });

  it("tokenizes parentheses and comma", () => {
    const tokens = tokenize("(a, b)");
    const types = tokens.map((t) => t.type);
    expect(types).toEqual(["LPAREN", "IDENT", "COMMA", "IDENT", "RPAREN", "EOF"]);
  });

  it("tokenizes identifiers", () => {
    const tokens = tokenize("sin cos pi");
    expect(tokens[0]).toEqual({ type: "IDENT", value: "sin", pos: 0 });
    expect(tokens[1]).toEqual({ type: "IDENT", value: "cos", pos: 4 });
    expect(tokens[2]).toEqual({ type: "IDENT", value: "pi", pos: 8 });
  });

  it("tokenizes a complex expression", () => {
    const tokens = tokenize("2 + 3 * sin(pi/2)");
    const values = tokens.map((t) => t.value);
    expect(values).toEqual(["2", "+", "3", "*", "sin", "(", "pi", "/", "2", ")", ""]);
  });

  it("skips whitespace", () => {
    const tokens = tokenize("  1  +  2  ");
    expect(tokens).toHaveLength(4); // NUMBER PLUS NUMBER EOF
  });

  it("throws on unexpected characters", () => {
    expect(() => tokenize("1 & 2")).toThrow(CalcError);
    try {
      tokenize("1 & 2");
    } catch (e) {
      expect(e).toBeInstanceOf(CalcError);
      expect((e as CalcError).code).toBe("UNEXPECTED_CHAR");
    }
  });

  it("throws on invalid hex literal", () => {
    expect(() => tokenize("0xG")).toThrow(CalcError);
  });

  it("throws on invalid binary literal", () => {
    expect(() => tokenize("0b2")).toThrow(CalcError);
  });

  it("records correct positions", () => {
    const tokens = tokenize("1 + 2");
    expect(tokens[0]!.pos).toBe(0);
    expect(tokens[1]!.pos).toBe(2);
    expect(tokens[2]!.pos).toBe(4);
  });

  it("handles empty input", () => {
    const tokens = tokenize("");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.type).toBe("EOF");
  });
});
