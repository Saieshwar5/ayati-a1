import { CalcError, type ASTNode, type Token } from "./types.js";

// Binding powers
const BP_ADD = 10;
const BP_MUL = 20;
const BP_UNARY = 30;
const BP_EXP = 40;
const BP_POSTFIX = 50;

export function parse(tokens: Token[]): ASTNode {
  let pos = 0;

  function peek(): Token {
    return tokens[pos]!;
  }

  function advance(): Token {
    const tok = tokens[pos]!;
    pos++;
    return tok;
  }

  function expect(type: string): Token {
    const tok = peek();
    if (tok.type !== type) {
      throw new CalcError(
        `Expected '${type}' but got '${tok.type}'`,
        tok.pos,
        type === "RPAREN" ? "UNCLOSED_PAREN" : "UNEXPECTED_TOKEN",
      );
    }
    return advance();
  }

  function nud(tok: Token): ASTNode {
    switch (tok.type) {
      case "NUMBER":
        return { kind: "number", value: tok.value, pos: tok.pos };

      case "IDENT": {
        if (peek().type === "LPAREN") {
          return parseCall(tok);
        }
        return { kind: "ident", name: tok.value, pos: tok.pos };
      }

      case "LPAREN": {
        const expr = parseExpr(0);
        expect("RPAREN");
        return expr;
      }

      case "PLUS":
        return { kind: "unary", op: "+", operand: parseExpr(BP_UNARY), pos: tok.pos };

      case "MINUS":
        return { kind: "unary", op: "-", operand: parseExpr(BP_UNARY), pos: tok.pos };

      default:
        throw new CalcError(
          `Unexpected token: '${tok.value || tok.type}'`,
          tok.pos,
          "UNEXPECTED_TOKEN",
        );
    }
  }

  function parseCall(nameTok: Token): ASTNode {
    advance(); // skip LPAREN
    const args: ASTNode[] = [];

    if (peek().type !== "RPAREN") {
      args.push(parseExpr(0));
      while (peek().type === "COMMA") {
        advance(); // skip COMMA
        args.push(parseExpr(0));
      }
    }

    expect("RPAREN");
    return { kind: "call", name: nameTok.value, args, pos: nameTok.pos };
  }

  function led(left: ASTNode, tok: Token): ASTNode {
    switch (tok.type) {
      case "PLUS":
        return { kind: "binary", op: "+", left, right: parseExpr(BP_ADD), pos: tok.pos };
      case "MINUS":
        return { kind: "binary", op: "-", left, right: parseExpr(BP_ADD), pos: tok.pos };
      case "STAR":
        return { kind: "binary", op: "*", left, right: parseExpr(BP_MUL), pos: tok.pos };
      case "SLASH":
        return { kind: "binary", op: "/", left, right: parseExpr(BP_MUL), pos: tok.pos };
      case "CARET":
        // Right-associative: use BP_EXP - 1 for right side
        return { kind: "binary", op: "^", left, right: parseExpr(BP_EXP - 1), pos: tok.pos };
      case "PERCENT":
        return { kind: "postfix", op: "%", operand: left, pos: tok.pos };
      case "BANG":
        return { kind: "postfix", op: "!", operand: left, pos: tok.pos };
      default:
        throw new CalcError(`Unexpected infix token: '${tok.type}'`, tok.pos, "UNEXPECTED_TOKEN");
    }
  }

  function lbp(tok: Token): number {
    switch (tok.type) {
      case "PLUS":
      case "MINUS":
        return BP_ADD;
      case "STAR":
      case "SLASH":
        return BP_MUL;
      case "CARET":
        return BP_EXP;
      case "PERCENT":
      case "BANG":
        return BP_POSTFIX;
      // Implicit multiplication: NUMBER or IDENT or LPAREN after an atom
      case "NUMBER":
      case "IDENT":
      case "LPAREN":
        return BP_MUL;
      default:
        return 0;
    }
  }

  function isImplicitMul(tok: Token): boolean {
    return tok.type === "NUMBER" || tok.type === "IDENT" || tok.type === "LPAREN";
  }

  function parseExpr(minBp: number): ASTNode {
    let left = nud(advance());

    while (lbp(peek()) > minBp) {
      const tok = peek();

      if (isImplicitMul(tok)) {
        // Implicit multiplication — don't consume the token as an operator
        const right = nud(advance());
        left = { kind: "binary", op: "*", left, right, pos: tok.pos };
        continue;
      }

      advance();
      left = led(left, tok);
    }

    return left;
  }

  const result = parseExpr(0);

  if (peek().type !== "EOF") {
    const tok = peek();
    throw new CalcError(`Unexpected token: '${tok.value || tok.type}'`, tok.pos, "UNEXPECTED_TOKEN");
  }

  return result;
}
