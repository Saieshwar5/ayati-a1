import { Decimal } from "decimal.js";
import { CalcError } from "./types.js";

type Dec = InstanceType<typeof Decimal>;

export const CalcDecimal = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });

// --- Constants ---

const PI = CalcDecimal.acos(-1);
const E = CalcDecimal.exp(1);
const TAU = PI.times(2);
const PHI = new CalcDecimal(1).plus(new CalcDecimal(5).sqrt()).dividedBy(2);

export const CONSTANTS: Record<string, Dec> = {
  pi: PI,
  e: E,
  tau: TAU,
  phi: PHI,
};

// --- Helpers ---

function assertArity(name: string, args: Dec[], min: number, max: number, pos: number): void {
  if (args.length < min || args.length > max) {
    const expected = min === max ? `${min}` : `${min}-${max}`;
    throw new CalcError(
      `${name}() expects ${expected} argument(s), got ${args.length}`,
      pos,
      "WRONG_ARITY",
    );
  }
}

function assertDomain(cond: boolean, name: string, msg: string, pos: number): void {
  if (!cond) {
    throw new CalcError(`${name}: ${msg}`, pos, "DOMAIN_ERROR");
  }
}

export function factorial(n: Dec, pos: number): Dec {
  if (!n.isInteger() || n.isNegative()) {
    throw new CalcError("factorial requires a non-negative integer", pos, "DOMAIN_ERROR");
  }
  if (n.greaterThan(1000)) {
    throw new CalcError("factorial argument too large (max 1000)", pos, "OVERFLOW");
  }
  let result: Dec = new CalcDecimal(1);
  for (let i = 2; i <= n.toNumber(); i++) {
    result = result.times(i);
  }
  return result;
}

function gcd(a: Dec, b: Dec): Dec {
  a = a.abs();
  b = b.abs();
  while (!b.isZero()) {
    const t = b;
    b = a.mod(b);
    a = t;
  }
  return a;
}

function lcm(a: Dec, b: Dec): Dec {
  if (a.isZero() && b.isZero()) return new CalcDecimal(0);
  return a.abs().times(b.abs()).dividedBy(gcd(a, b));
}

// --- Function table ---

interface FuncDef {
  min: number;
  max: number;
  fn: (args: Dec[], pos: number) => Dec;
}

export const FUNCTIONS: Record<string, FuncDef> = {
  // Trig
  sin:   { min: 1, max: 1, fn: ([x]) => CalcDecimal.sin(x!) },
  cos:   { min: 1, max: 1, fn: ([x]) => CalcDecimal.cos(x!) },
  tan:   { min: 1, max: 1, fn: ([x]) => CalcDecimal.tan(x!) },
  asin:  { min: 1, max: 1, fn: ([x], pos) => {
    assertDomain(x!.abs().lte(1), "asin", "argument must be in [-1, 1]", pos);
    return CalcDecimal.asin(x!);
  }},
  acos:  { min: 1, max: 1, fn: ([x], pos) => {
    assertDomain(x!.abs().lte(1), "acos", "argument must be in [-1, 1]", pos);
    return CalcDecimal.acos(x!);
  }},
  atan:  { min: 1, max: 1, fn: ([x]) => CalcDecimal.atan(x!) },
  atan2: { min: 2, max: 2, fn: ([y, x]) => CalcDecimal.atan2(y!, x!) },

  // Hyperbolic
  sinh:  { min: 1, max: 1, fn: ([x]) => CalcDecimal.sinh(x!) },
  cosh:  { min: 1, max: 1, fn: ([x]) => CalcDecimal.cosh(x!) },
  tanh:  { min: 1, max: 1, fn: ([x]) => CalcDecimal.tanh(x!) },
  asinh: { min: 1, max: 1, fn: ([x]) => CalcDecimal.asinh(x!) },
  acosh: { min: 1, max: 1, fn: ([x], pos) => {
    assertDomain(x!.gte(1), "acosh", "argument must be >= 1", pos);
    return CalcDecimal.acosh(x!);
  }},
  atanh: { min: 1, max: 1, fn: ([x], pos) => {
    assertDomain(x!.abs().lt(1), "atanh", "argument must be in (-1, 1)", pos);
    return CalcDecimal.atanh(x!);
  }},

  // Power/Root
  sqrt: { min: 1, max: 1, fn: ([x], pos) => {
    assertDomain(!x!.isNegative(), "sqrt", "argument must be non-negative", pos);
    return x!.sqrt();
  }},
  cbrt:  { min: 1, max: 1, fn: ([x]) => x!.cbrt() },
  pow:   { min: 2, max: 2, fn: ([b, e]) => b!.pow(e!) },
  exp:   { min: 1, max: 1, fn: ([x]) => x!.exp() },
  hypot: { min: 1, max: 255, fn: (args) => {
    let sum: Dec = new CalcDecimal(0);
    for (const a of args) sum = sum.plus(a.times(a));
    return sum.sqrt();
  }},

  // Logarithmic
  ln:    { min: 1, max: 1, fn: ([x], pos) => {
    assertDomain(x!.greaterThan(0), "ln", "argument must be positive", pos);
    return x!.ln();
  }},
  log2:  { min: 1, max: 1, fn: ([x], pos) => {
    assertDomain(x!.greaterThan(0), "log2", "argument must be positive", pos);
    return x!.ln().dividedBy(new CalcDecimal(2).ln());
  }},
  log10: { min: 1, max: 1, fn: ([x], pos) => {
    assertDomain(x!.greaterThan(0), "log10", "argument must be positive", pos);
    return x!.log(10);
  }},
  log:   { min: 1, max: 2, fn: ([x, base], pos) => {
    assertDomain(x!.greaterThan(0), "log", "argument must be positive", pos);
    if (base) {
      assertDomain(base.isPositive() && !base.eq(1), "log", "base must be positive and != 1", pos);
      return x!.ln().dividedBy(base.ln());
    }
    return x!.ln();
  }},

  // Rounding
  floor: { min: 1, max: 1, fn: ([x]) => x!.floor() },
  ceil:  { min: 1, max: 1, fn: ([x]) => x!.ceil() },
  round: { min: 1, max: 1, fn: ([x]) => x!.round() },
  trunc: { min: 1, max: 1, fn: ([x]) => x!.trunc() },
  abs:   { min: 1, max: 1, fn: ([x]) => x!.abs() },
  sign:  { min: 1, max: 1, fn: ([x]) => new CalcDecimal(x!.isZero() ? 0 : x!.isPositive() ? 1 : -1) },

  // Integer
  factorial: { min: 1, max: 1, fn: ([x], pos) => factorial(x!, pos) },
  gcd: { min: 2, max: 2, fn: ([a, b], pos) => {
    assertDomain(a!.isInteger() && b!.isInteger(), "gcd", "arguments must be integers", pos);
    return gcd(a!, b!);
  }},
  lcm: { min: 2, max: 2, fn: ([a, b], pos) => {
    assertDomain(a!.isInteger() && b!.isInteger(), "lcm", "arguments must be integers", pos);
    return lcm(a!, b!);
  }},
  nPr: { min: 2, max: 2, fn: ([n, r], pos) => {
    assertDomain(n!.isInteger() && r!.isInteger() && !n!.isNegative() && !r!.isNegative() && r!.lte(n!),
      "nPr", "requires 0 <= r <= n, both integers", pos);
    return factorial(n!, pos).dividedBy(factorial(n!.minus(r!), pos));
  }},
  nCr: { min: 2, max: 2, fn: ([n, r], pos) => {
    assertDomain(n!.isInteger() && r!.isInteger() && !n!.isNegative() && !r!.isNegative() && r!.lte(n!),
      "nCr", "requires 0 <= r <= n, both integers", pos);
    return factorial(n!, pos).dividedBy(factorial(r!, pos).times(factorial(n!.minus(r!), pos)));
  }},

  // Comparison
  min: { min: 1, max: 255, fn: (args) => CalcDecimal.min(...args) },
  max: { min: 1, max: 255, fn: (args) => CalcDecimal.max(...args) },

  // Utility
  mod: { min: 2, max: 2, fn: ([a, b], pos) => {
    assertDomain(!b!.isZero(), "mod", "divisor must not be zero", pos);
    return a!.mod(b!);
  }},
};

export function callFunction(name: string, args: Dec[], pos: number): Dec {
  const def = FUNCTIONS[name];
  if (!def) {
    throw new CalcError(`Unknown function: ${name}`, pos, "UNKNOWN_FUNCTION");
  }
  assertArity(name, args, def.min, def.max, pos);
  return def.fn(args, pos);
}

export function getConstant(name: string, pos: number): Dec {
  const val = CONSTANTS[name];
  if (!val) {
    throw new CalcError(`Unknown constant: ${name}`, pos, "UNKNOWN_CONSTANT");
  }
  return val;
}
