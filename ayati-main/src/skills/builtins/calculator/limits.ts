export const CALCULATOR_PRECISION_DIGITS = 50;
export const CALCULATOR_ROUNDING_MODE = "half_up";

export const CALCULATOR_LIMITS = {
  expressionCharacters: 2_048,
  tokens: 512,
  nestingDepth: 64,
  numericLiteralCharacters: 256,
  powerExponentAbsolute: 10_000,
  exponentialArgumentAbsolute: 1_000,
  trigonometricArgumentAbsolute: 1_000_000,
} as const;
