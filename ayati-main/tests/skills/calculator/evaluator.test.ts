import { describe, expect, it } from "vitest";
import { calculate } from "../../../src/skills/builtins/calculator/evaluator.js";
import { CalcError } from "../../../src/skills/builtins/calculator/types.js";

describe("evaluator (end-to-end)", () => {
  describe("precision", () => {
    it("0.1 + 0.2 = 0.3 (exact)", () => {
      expect(calculate("0.1 + 0.2")).toBe("0.3");
    });

    it("0.3 - 0.1 = 0.2 (exact)", () => {
      expect(calculate("0.3 - 0.1")).toBe("0.2");
    });
  });

  describe("arithmetic", () => {
    it("2 + 3 = 5", () => {
      expect(calculate("2 + 3")).toBe("5");
    });

    it("10 - 7 = 3", () => {
      expect(calculate("10 - 7")).toBe("3");
    });

    it("6 * 7 = 42", () => {
      expect(calculate("6 * 7")).toBe("42");
    });

    it("15 / 3 = 5", () => {
      expect(calculate("15 / 3")).toBe("5");
    });

    it("2 ^ 10 = 1024", () => {
      expect(calculate("2 ^ 10")).toBe("1024");
    });

    it("10 / 3 has precision", () => {
      const result = calculate("10 / 3");
      expect(result.startsWith("3.333")).toBe(true);
    });
  });

  describe("unary operators", () => {
    it("-5 = -5", () => {
      expect(calculate("-5")).toBe("-5");
    });

    it("--5 = 5", () => {
      expect(calculate("--5")).toBe("5");
    });

    it("+5 = 5", () => {
      expect(calculate("+5")).toBe("5");
    });
  });

  describe("percentage", () => {
    it("50% = 0.5", () => {
      expect(calculate("50%")).toBe("0.5");
    });

    it("200 * 15% = 30", () => {
      expect(calculate("200 * 15%")).toBe("30");
    });
  });

  describe("factorial", () => {
    it("5! = 120", () => {
      expect(calculate("5!")).toBe("120");
    });

    it("0! = 1", () => {
      expect(calculate("0!")).toBe("1");
    });

    it("20! = 2432902008176640000", () => {
      expect(calculate("20!")).toBe("2432902008176640000");
    });
  });

  describe("constants", () => {
    it("pi ≈ 3.14159", () => {
      expect(calculate("pi").startsWith("3.14159")).toBe(true);
    });

    it("e ≈ 2.71828", () => {
      expect(calculate("e").startsWith("2.71828")).toBe(true);
    });

    it("tau ≈ 6.28318", () => {
      expect(calculate("tau").startsWith("6.28318")).toBe(true);
    });

    it("phi ≈ 1.618", () => {
      expect(calculate("phi").startsWith("1.618")).toBe(true);
    });
  });

  describe("functions", () => {
    it("sqrt(9) = 3", () => {
      expect(calculate("sqrt(9)")).toBe("3");
    });

    it("abs(-42) = 42", () => {
      expect(calculate("abs(-42)")).toBe("42");
    });

    it("log10(1000) = 3", () => {
      expect(calculate("log10(1000)")).toBe("3");
    });

    it("ln(e) = 1", () => {
      expect(calculate("ln(e)")).toBe("1");
    });

    it("floor(3.9) = 3", () => {
      expect(calculate("floor(3.9)")).toBe("3");
    });

    it("ceil(3.1) = 4", () => {
      expect(calculate("ceil(3.1)")).toBe("4");
    });
  });

  describe("combinatorics", () => {
    it("nCr(10, 3) = 120", () => {
      expect(calculate("nCr(10, 3)")).toBe("120");
    });

    it("gcd(12, 8) = 4", () => {
      expect(calculate("gcd(12, 8)")).toBe("4");
    });

    it("lcm(4, 6) = 12", () => {
      expect(calculate("lcm(4, 6)")).toBe("12");
    });
  });

  describe("number bases", () => {
    it("0xFF = 255", () => {
      expect(calculate("0xFF")).toBe("255");
    });

    it("0b1010 = 10", () => {
      expect(calculate("0b1010")).toBe("10");
    });

    it("0o77 = 63", () => {
      expect(calculate("0o77")).toBe("63");
    });
  });

  describe("implicit multiplication", () => {
    it("2pi ≈ 6.28", () => {
      expect(calculate("2pi").startsWith("6.28")).toBe(true);
    });

    it("3(4 + 5) = 27", () => {
      expect(calculate("3(4 + 5)")).toBe("27");
    });

    it("(2)(3) = 6", () => {
      expect(calculate("(2)(3)")).toBe("6");
    });
  });

  describe("complex expressions", () => {
    it("sin(pi/4)^2 + cos(pi/4)^2 = 1", () => {
      const result = calculate("sin(pi/4)^2 + cos(pi/4)^2");
      // Should be very close to 1
      expect(parseFloat(result)).toBeCloseTo(1, 10);
    });

    it("nested: sqrt(3^2 + 4^2) = 5", () => {
      expect(calculate("sqrt(3^2 + 4^2)")).toBe("5");
    });

    it("mixed: 2 * pi * 5 ≈ 31.415", () => {
      expect(calculate("2 * pi * 5").startsWith("31.415")).toBe(true);
    });
  });

  describe("errors", () => {
    it("division by zero", () => {
      expect(() => calculate("1/0")).toThrow(CalcError);
      try { calculate("1/0"); } catch (e) {
        expect((e as CalcError).code).toBe("DIVISION_BY_ZERO");
      }
    });

    it("sqrt(-1) domain error", () => {
      expect(() => calculate("sqrt(-1)")).toThrow(CalcError);
      try { calculate("sqrt(-1)"); } catch (e) {
        expect((e as CalcError).code).toBe("DOMAIN_ERROR");
      }
    });

    it("asin(2) domain error", () => {
      expect(() => calculate("asin(2)")).toThrow(CalcError);
    });

    it("unknown function", () => {
      expect(() => calculate("bogus(1)")).toThrow(CalcError);
      try { calculate("bogus(1)"); } catch (e) {
        expect((e as CalcError).code).toBe("UNKNOWN_FUNCTION");
      }
    });

    it("unknown constant", () => {
      expect(() => calculate("xyz")).toThrow(CalcError);
      try { calculate("xyz"); } catch (e) {
        expect((e as CalcError).code).toBe("UNKNOWN_CONSTANT");
      }
    });

    it("wrong arity", () => {
      expect(() => calculate("sin(1, 2)")).toThrow(CalcError);
      try { calculate("sin(1, 2)"); } catch (e) {
        expect((e as CalcError).code).toBe("WRONG_ARITY");
      }
    });
  });
});
