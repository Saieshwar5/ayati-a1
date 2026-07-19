export type GitContextErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "PAYLOAD_TOO_LARGE"
  | "IDEMPOTENCY_CONFLICT"
  | "SERVICE_NOT_READY"
  | "SERVICE_UNAVAILABLE"
  | "SESSION_NOT_ACTIVE"
  | "SESSION_ROLLOVER_PENDING"
  | "SESSION_HEAD_MISMATCH"
  | "CONVERSATION_NOT_ACTIVE"
  | "WORKSTREAM_NOT_FOUND"
  | "WORKSTREAM_SCHEMA_UNSUPPORTED"
  | "WORKSTREAM_CARD_INVALID"
  | "WORKSTREAM_ID_MISMATCH"
  | "WORKSTREAM_REQUEST_INVALID"
  | "WORKSTREAM_REQUEST_STATE_INVALID"
  | "WORKSTREAM_CURRENT_REQUEST_INVALID"
  | "WORKSTREAM_REPOSITORY_INVALID"
  | "WORKSTREAM_REPOSITORY_DIRTY"
  | "WORKSTREAM_BUSY"
  | "WORKSTREAM_LOCKED"
  | "WORKSTREAM_CHECKOUT_DIRTY"
  | "WORKSTREAM_HEAD_MISMATCH"
  | "RUN_NOT_ACTIVE"
  | "RUN_ALREADY_ACTIVE"
  | "RUN_ALREADY_FINALIZED"
  | "RUN_WORKSTREAM_BINDING_IMMUTABLE"
  | "RUN_STEP_NOT_CONTIGUOUS"
  | "MUTATION_REQUIRES_WORKSTREAM_BINDING"
  | "RUN_WORKSTREAM_BINDING_REQUIRED"
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_CONFLICT"
  | "RESOURCE_BINDING_INVALID"
  | "RESOURCE_LOCATOR_INVALID"
  | "RESOURCE_METADATA_INVALID"
  | "RESOURCE_STORE_CORRUPT"
  | "RESOURCE_MUTATION_UNAVAILABLE"
  | "RESOURCE_MUTATION_NOT_FOUND"
  | "RESOURCE_VERSION_MISMATCH"
  | "RESOURCE_VERIFICATION_UNAVAILABLE"
  | "MUTATION_TARGET_INVALID"
  | "MUTATION_LOCK_INVALID"
  | "MUTATION_AUTHORITY_CONFLICT"
  | "UNKNOWN_TOOL_CLASSIFICATION"
  | "REPOSITORY_UNAVAILABLE"
  | "GIT_CONFLICT"
  | "RECOVERY_REQUIRED"
  | "INTERNAL_ERROR";

export interface GitContextErrorBody {
  code: GitContextErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface GitContextErrorResponse {
  error: GitContextErrorBody;
}

export class GitContextServiceError extends Error {
  readonly code: GitContextErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(input: {
    code: GitContextErrorCode;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "GitContextServiceError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.details = input.details;
  }

  toResponse(): GitContextErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function isGitContextErrorResponse(value: unknown): value is GitContextErrorResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const error = (value as Record<string, unknown>)["error"];
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return false;
  }
  const record = error as Record<string, unknown>;
  return typeof record["code"] === "string"
    && typeof record["message"] === "string"
    && typeof record["retryable"] === "boolean";
}
