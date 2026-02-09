export type TokenType =
  | "NUMBER"
  | "IDENT"
  | "PLUS"
  | "MINUS"
  | "STAR"
  | "SLASH"
  | "CARET"
  | "PERCENT"
  | "BANG"
  | "LPAREN"
  | "RPAREN"
  | "COMMA"
  | "EOF";

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

export type ASTNode =
  | { kind: "number"; value: string; pos: number }
  | { kind: "ident"; name: string; pos: number }
  | { kind: "unary"; op: "+" | "-"; operand: ASTNode; pos: number }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "^"; left: ASTNode; right: ASTNode; pos: number }
  | { kind: "postfix"; op: "!" | "%"; operand: ASTNode; pos: number }
  | { kind: "call"; name: string; args: ASTNode[]; pos: number };

export type CalcErrorCode =
  | "UNEXPECTED_CHAR"
  | "UNEXPECTED_TOKEN"
  | "UNCLOSED_PAREN"
  | "UNKNOWN_FUNCTION"
  | "WRONG_ARITY"
  | "DIVISION_BY_ZERO"
  | "DOMAIN_ERROR"
  | "OVERFLOW"
  | "UNKNOWN_CONSTANT";

export class CalcError extends Error {
  constructor(
    message: string,
    public pos: number,
    public code: CalcErrorCode,
  ) {
    super(message);
    this.name = "CalcError";
  }
}
