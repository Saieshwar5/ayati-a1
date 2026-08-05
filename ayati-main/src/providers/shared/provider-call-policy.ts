export const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 120_000;
export const MAX_PROVIDER_REQUEST_TIMEOUT_MS = 600_000;
export const PROVIDER_RETRY_DELAY_MS = 400;
export const MAX_PROVIDER_RETRY_DELAY_MS = 5_000;
export const MAX_PROVIDER_RETRIES = 1;

const PROVIDER_REQUEST_TIMEOUT_ENV = "AYATI_LLM_REQUEST_TIMEOUT_MS";
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export type ProviderFailureKind = "transient" | "permanent" | "cancelled" | "unknown";

export interface ProviderFailureDetails {
  provider: string;
  kind: ProviderFailureKind;
  retryable: boolean;
  errorName: string;
  errorMessage: string;
  status?: number;
  code?: string;
  retryDelayMs?: number;
}

export class ProviderCallError extends Error {
  readonly details: ProviderFailureDetails;
  readonly cause?: unknown;

  constructor(details: ProviderFailureDetails, cause?: unknown) {
    super(`${details.provider} provider request failed (${details.kind}): ${details.errorMessage}`);
    this.name = "ProviderCallError";
    this.details = details;
    this.cause = cause;
  }
}

export function getProviderRequestOptions(
  env: NodeJS.ProcessEnv = process.env,
): { timeout: number; maxRetries: 0 } {
  return {
    timeout: readProviderRequestTimeoutMs(env),
    maxRetries: 0,
  };
}

export function readProviderRequestTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = env[PROVIDER_REQUEST_TIMEOUT_ENV];
  if (configured === undefined || configured.trim().length === 0) {
    return DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
  }
  const timeoutMs = Number(configured);
  if (
    !Number.isInteger(timeoutMs)
    || timeoutMs < 1_000
    || timeoutMs > MAX_PROVIDER_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      `${PROVIDER_REQUEST_TIMEOUT_ENV} must be an integer between 1000 and ${MAX_PROVIDER_REQUEST_TIMEOUT_MS}.`,
    );
  }
  return timeoutMs;
}

export function classifyProviderFailure(
  error: unknown,
  provider: string,
): ProviderFailureDetails {
  if (error instanceof ProviderCallError) {
    return error.details;
  }
  const record = errorRecord(error);
  const errorName = error instanceof Error ? error.name : readString(record, "name") ?? "UnknownError";
  const errorMessage = boundedMessage(error instanceof Error ? error.message : String(error));
  const status = readStatus(record);
  const code = readErrorCode(record);
  const searchable = `${errorName} ${errorMessage} ${code ?? ""}`.toLowerCase();

  if (
    errorName === "AbortError"
    || errorName === "APIUserAbortError"
    || code === "ABORT_ERR"
  ) {
    return details({ provider, kind: "cancelled", errorName, errorMessage, status, code });
  }
  if (isPermanentQuotaFailure(status, searchable)) {
    return details({ provider, kind: "permanent", errorName, errorMessage, status, code });
  }
  if (
    status === 408
    || status === 409
    || status === 429
    || (status !== undefined && status >= 500)
    || isTransientTransportFailure(errorName, code, searchable)
  ) {
    return details({
      provider,
      kind: "transient",
      errorName,
      errorMessage,
      status,
      code,
      retryDelayMs: readRetryDelayMs(record) ?? PROVIDER_RETRY_DELAY_MS,
    });
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return details({ provider, kind: "permanent", errorName, errorMessage, status, code });
  }
  return details({ provider, kind: "unknown", errorName, errorMessage, status, code });
}

export function toProviderCallError(
  error: unknown,
  provider: string,
): ProviderCallError {
  return error instanceof ProviderCallError
    ? error
    : new ProviderCallError(classifyProviderFailure(error, provider), error);
}

function details(input: Omit<ProviderFailureDetails, "retryable">): ProviderFailureDetails {
  return {
    ...input,
    retryable: input.kind === "transient",
  };
}

function isPermanentQuotaFailure(status: number | undefined, searchable: string): boolean {
  const accountFailure = searchable.includes("insufficient_quota")
    || searchable.includes("quota exceeded")
    || searchable.includes("billing")
    || searchable.includes("spending limit")
    || searchable.includes("credit balance");
  return accountFailure && (status === undefined || status === 429 || status === 402);
}

function isTransientTransportFailure(
  errorName: string,
  code: string | undefined,
  searchable: string,
): boolean {
  return errorName === "APIConnectionError"
    || errorName === "APIConnectionTimeoutError"
    || (code !== undefined && TRANSIENT_ERROR_CODES.has(code))
    || searchable.includes("request timed out")
    || searchable.includes("connection error")
    || searchable.includes("connection reset");
}

function readRetryDelayMs(record: Record<string, unknown>): number | undefined {
  const headers = record["headers"];
  const retryAfterMs = readHeader(headers, "retry-after-ms");
  if (retryAfterMs !== undefined) {
    const parsed = Number(retryAfterMs);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(Math.round(parsed), MAX_PROVIDER_RETRY_DELAY_MS);
    }
  }
  const retryAfter = readHeader(headers, "retry-after");
  if (retryAfter === undefined) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1_000), MAX_PROVIDER_RETRY_DELAY_MS);
  }
  const timestamp = Date.parse(retryAfter);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(Math.max(0, timestamp - Date.now()), MAX_PROVIDER_RETRY_DELAY_MS);
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = getter.call(headers, name);
    return typeof value === "string" ? value : undefined;
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function readStatus(record: Record<string, unknown>): number | undefined {
  const status = record["status"];
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function readErrorCode(record: Record<string, unknown>): string | undefined {
  const direct = readString(record, "code");
  if (direct) return direct.toUpperCase();
  const nested = errorRecord(record["error"]);
  const nestedCode = readString(nested, "code") ?? readString(nested, "type");
  if (nestedCode) return nestedCode.toUpperCase();
  const cause = errorRecord(record["cause"]);
  const causeCode = readString(cause, "code");
  return causeCode?.toUpperCase();
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function errorRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function boundedMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim() || "Unknown provider error";
  return normalized.length <= 300 ? normalized : `${normalized.slice(0, 297)}...`;
}
