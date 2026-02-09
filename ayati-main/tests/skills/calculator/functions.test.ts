import { describe, expect, it } from "vitest";
import {
  CalcDecimal,
  CONSTANTS,
  FUNCTIONS,
  callFunction,
  factorial,
  getConstant,
} from "../../../src/skills/builtins/calculator/functions.js";
import { CalcError } from "../../../src/skills/builtins/calculator/types.js";

function d(v: number | string) {
  return new CalcDecimal(v);
}

describe("constants", () => {
  it("pi is approximately 3.14159", () => {
    expect(CONSTANTS["pi"]!.toFixed(5)).toBe("3.14159");
  });

  it("e is approximately 2.71828", () => {
    expect(CONSTANTS["e"]!.toFixed(5)).toBe("2.71828");
  });

  it("tau = 2 * pi", () => {
    expect(CONSTANTS["tau"]!.toFixed(10)).toBe(CONSTANTS["pi"]!.times(2).toFixed(10));
  });

  it("phi = golden ratio ≈ 1.618", () => {
    expect(CONSTANTS["phi"]!.toFixed(3)).toBe("1.618");
  });

  it("getConstant throws for unknown", () => {
    expect(() => getConstant("xyz", 0)).toThrow(CalcError);
  });
});

describe("factorial", () => {
  it("0! = 1", () => {
    expect(factorial(d(0), 0).toString()).toBe("1");
  });

  it("5! = 120", () => {
    expect(factorial(d(5), 0).toString()).toBe("120");
  });

  it("20! = 2432902008176640000", () => {
    expect(factorial(d(20), 0).toString()).toBe("2432902008176640000");
  });

  it("throws on negative", () => {
    expect(() => factorial(d(-1), 0)).toThrow(CalcError);
  });

  it("throws on non-integer", () => {
    expect(() => factorial(d(2.5), 0)).toThrow(CalcError);
  });

  it("throws on > 1000", () => {
    expect(() => factorial(d(1001), 0)).toThrow(CalcError);
  });
});

describe("callFunction", () => {
  it("sin(0) = 0", () => {
    expect(callFunction("sin", [d(0)], 0).toString()).toBe("0");
  });

  it("cos(0) = 1", () => {
    expect(callFunction("cos", [d(0)], 0).toString()).toBe("1");
  });

  it("sqrt(4) = 2", () => {
    expect(callFunction("sqrt", [d(4)], 0).toString()).toBe("2");
  });

  it("sqrt(-1) throws DOMAIN_ERROR", () => {
    try {
      callFunction("sqrt", [d(-1)], 0);
    } catch (e) {
      expect(e).toBeInstanceOf(CalcError);
      expect((e as CalcError).code).toBe("DOMAIN_ERROR");
    }
  });

  it("asin(2) throws DOMAIN_ERROR", () => {
    expect(() => callFunction("asin", [d(2)], 0)).toThrow(CalcError);
  });

  it("ln(0) throws DOMAIN_ERROR", () => {
    expect(() => callFunction("ln", [d(0)], 0)).toThrow(CalcError);
  });

  it("log10(1000) = 3", () => {
    expect(callFunction("log10", [d(1000)], 0).toString()).toBe("3");
  });

  it("log(x, base) works", () => {
    expect(callFunction("log", [d(8), d(2)], 0).toString()).toBe("3");
  });

  it("abs(-5) = 5", () => {
    expect(callFunction("abs", [d(-5)], 0).toString()).toBe("5");
  });

  it("floor(3.7) = 3", () => {
    expect(callFunction("floor", [d(3.7)], 0).toString()).toBe("3");
  });

  it("ceil(3.2) = 4", () => {
    expect(callFunction("ceil", [d(3.2)], 0).toString()).toBe("4");
  });

  it("gcd(12, 8) = 4", () => {
    expect(callFunction("gcd", [d(12), d(8)], 0).toString()).toBe("4");
  });

  it("lcm(4, 6) = 12", () => {
    expect(callFunction("lcm", [d(4), d(6)], 0).toString()).toBe("12");
  });

  it("nCr(10, 3) = 120", () => {
    expect(callFunction("nCr", [d(10), d(3)], 0).toString()).toBe("120");
  });

  it("nPr(5, 2) = 20", () => {
    expect(callFunction("nPr", [d(5), d(2)], 0).toString()).toBe("20");
  });

  it("mod(10, 3) = 1", () => {
    expect(callFunction("mod", [d(10), d(3)], 0).toString()).toBe("1");
  });

  it("mod(x, 0) throws", () => {
    expect(() => callFunction("mod", [d(10), d(0)], 0)).toThrow(CalcError);
  });

  it("min/max work with variadic args", () => {
    expect(callFunction("min", [d(3), d(1), d(2)], 0).toString()).toBe("1");
    expect(callFunction("max", [d(3), d(1), d(2)], 0).toString()).toBe("3");
  });

  it("hypot(3, 4) = 5", () => {
    expect(callFunction("hypot", [d(3), d(4)], 0).toString()).toBe("5");
  });

  it("throws UNKNOWN_FUNCTION for bad name", () => {
    expect(() => callFunction("bogus", [], 0)).toThrow(CalcError);
    try {
      callFunction("bogus", [], 0);
    } catch (e) {
      expect((e as CalcError).code).toBe("UNKNOWN_FUNCTION");
    }
  });

  it("throws WRONG_ARITY for bad arg count", () => {
    expect(() => callFunction("sin", [], 0)).toThrow(CalcError);
    try {
      callFunction("sin", [], 0);
    } catch (e) {
      expect((e as CalcError).code).toBe("WRONG_ARITY");
    }
  });
});
