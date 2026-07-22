import { sha256Text } from "./canonical.js";
import type { EvaluationCaptureMode } from "./contracts.js";

interface RedactedSecret {
  redacted: true;
  type: string;
  sha256: string;
  length: number;
}

interface SafeString {
  safeCapture: true;
  sha256: string;
  length: number;
  preview: string;
}

const SECRET_KEY = /(?:^|_)(?:api_?key|access_?token|auth(?:orization)?|bearer|credential|password|private_?key|secret)(?:$|_)/i;
const TOKENISH_KEY_EXCEPTIONS = new Set([
  "token",
  "tokens",
  "inputtokens",
  "outputtokens",
  "totaltokens",
  "cachedinputtokens",
  "tokencount",
  "tooltoken",
]);
const INLINE_SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?([^\s"']{8,})["']?/gi,
];
const BASE64_OR_DATA = /^(?:data:[^;,]+;base64,)?[A-Za-z0-9+/=_-]{4096,}$/;

export function sanitizeEvaluationValue(
  value: unknown,
  capture: EvaluationCaptureMode,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  const knownSecrets = environmentSecrets(env);
  return sanitize(value, capture, knownSecrets, undefined, new WeakSet<object>());
}

export function containsRecognizedSecret(value: unknown): boolean {
  const text = JSON.stringify(value);
  return INLINE_SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function sanitize(
  value: unknown,
  capture: EvaluationCaptureMode,
  knownSecrets: string[],
  key: string | undefined,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (isSecretKey(key)) return redactSecret(String(value), key ?? "secret");
  if (typeof value === "string") return sanitizeString(value, capture, knownSecrets);
  if (["number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return sanitize({
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause,
      ...Object.fromEntries(Object.entries(value)),
    }, capture, knownSecrets, key, seen);
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return binaryReference(bytes);
  }
  if (value instanceof ArrayBuffer) return binaryReference(Buffer.from(value));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return { circularReference: true };
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item, capture, knownSecrets, undefined, seen));
    }
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      sanitize(child, capture, knownSecrets, childKey, seen),
    ]));
  } finally {
    seen.delete(value);
  }
}

function sanitizeString(
  value: string,
  capture: EvaluationCaptureMode,
  knownSecrets: string[],
): string | RedactedSecret | SafeString | Record<string, unknown> {
  if (BASE64_OR_DATA.test(value)) {
    return {
      binaryContentOmitted: true,
      sha256: sha256Text(value),
      encodedLength: value.length,
      prefix: value.startsWith("data:") ? value.slice(0, Math.min(value.indexOf(",") + 1, 120)) : undefined,
    };
  }
  let sanitized = value;
  for (const secret of knownSecrets) {
    if (secret.length >= 8 && sanitized.includes(secret)) {
      sanitized = sanitized.split(secret).join(`[REDACTED:${sha256Text(secret).slice(0, 12)}:${secret.length}]`);
    }
  }
  for (const pattern of INLINE_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, (match) => {
      const hash = sha256Text(match);
      return `[REDACTED:inline:${hash.slice(0, 12)}:${match.length}]`;
    });
  }
  if (capture === "safe" && sanitized.length > 160) {
    return {
      safeCapture: true,
      sha256: sha256Text(sanitized),
      length: sanitized.length,
      preview: `${sanitized.slice(0, 157)}...`,
    };
  }
  return sanitized;
}

function isSecretKey(key: string | undefined): boolean {
  if (!key) return false;
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (TOKENISH_KEY_EXCEPTIONS.has(normalized) || normalized.endsWith("tokens")) return false;
  return SECRET_KEY.test(key);
}

function redactSecret(value: string, type: string): RedactedSecret {
  return {
    redacted: true,
    type,
    sha256: sha256Text(value),
    length: value.length,
  };
}

function environmentSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key, value]) => Boolean(value) && isSecretKey(key))
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
}

function binaryReference(bytes: Buffer): Record<string, unknown> {
  return {
    binaryContentOmitted: true,
    sha256: sha256Text(bytes.toString("base64")),
    sizeBytes: bytes.byteLength,
  };
}
