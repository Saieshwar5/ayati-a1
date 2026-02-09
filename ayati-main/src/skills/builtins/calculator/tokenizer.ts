import { CalcError, type Token, type TokenType } from "./types.js";

const SINGLE_CHAR_TOKENS: Record<string, TokenType> = {
  "+": "PLUS",
  "-": "MINUS",
  "*": "STAR",
  "/": "SLASH",
  "^": "CARET",
  "%": "PERCENT",
  "!": "BANG",
  "(": "LPAREN",
  ")": "RPAREN",
  ",": "COMMA",
};

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isAlpha(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isAlphaNum(ch: string): boolean {
  return isAlpha(ch) || isDigit(ch);
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function readNumber(input: string, start: number): Token {
  let i = start;

  // Check for hex, binary, or octal prefix
  if (input[i] === "0" && i + 1 < input.length) {
    const next = input[i + 1];
    if (next === "x" || next === "X") {
      return readPrefixedInt(input, start, 2, isHexDigit, "hex");
    }
    if (next === "b" || next === "B") {
      return readPrefixedInt(input, start, 2, isBinaryDigit, "binary");
    }
    if (next === "o" || next === "O") {
      return readPrefixedInt(input, start, 2, isOctalDigit, "octal");
    }
  }

  // Decimal integer part
  while (i < input.length && isDigit(input[i]!)) i++;

  // Decimal point
  if (i < input.length && input[i] === "." && i + 1 < input.length && isDigit(input[i + 1]!)) {
    i++; // skip '.'
    while (i < input.length && isDigit(input[i]!)) i++;
  }

  // Exponent
  if (i < input.length && (input[i] === "e" || input[i] === "E")) {
    let j = i + 1;
    if (j < input.length && (input[j] === "+" || input[j] === "-")) j++;
    if (j < input.length && isDigit(input[j]!)) {
      i = j;
      while (i < input.length && isDigit(input[i]!)) i++;
    }
  }

  return { type: "NUMBER", value: input.slice(start, i), pos: start };
}

function readPrefixedInt(
  input: string,
  start: number,
  prefixLen: number,
  isValidDigit: (ch: string) => boolean,
  label: string,
): Token {
  let i = start + prefixLen;
  if (i >= input.length || !isValidDigit(input[i]!)) {
    throw new CalcError(`Invalid ${label} literal`, start, "UNEXPECTED_CHAR");
  }
  while (i < input.length && isValidDigit(input[i]!)) i++;
  return { type: "NUMBER", value: input.slice(start, i), pos: start };
}

function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

function isBinaryDigit(ch: string): boolean {
  return ch === "0" || ch === "1";
}

function isOctalDigit(ch: string): boolean {
  return ch >= "0" && ch <= "7";
}

function readIdent(input: string, start: number): Token {
  let i = start;
  while (i < input.length && isAlphaNum(input[i]!)) i++;
  return { type: "IDENT", value: input.slice(start, i), pos: start };
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    if (isWhitespace(ch)) {
      i++;
      continue;
    }

    if (isDigit(ch) || (ch === "." && i + 1 < input.length && isDigit(input[i + 1]!))) {
      const tok = readNumber(input, i);
      tokens.push(tok);
      i = tok.pos + tok.value.length;
      continue;
    }

    if (isAlpha(ch)) {
      const tok = readIdent(input, i);
      tokens.push(tok);
      i = tok.pos + tok.value.length;
      continue;
    }

    const tokenType = SINGLE_CHAR_TOKENS[ch];
    if (tokenType) {
      tokens.push({ type: tokenType, value: ch, pos: i });
      i++;
      continue;
    }

    throw new CalcError(`Unexpected character: '${ch}'`, i, "UNEXPECTED_CHAR");
  }

  tokens.push({ type: "EOF", value: "", pos: i });
  return tokens;
}
