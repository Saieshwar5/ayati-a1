import { createHash } from "node:crypto";

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return canonicalize({
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause,
      ...Object.fromEntries(Object.entries(value)),
    });
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}
