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
  | "TASK_NOT_FOUND"
  | "TASK_SCHEMA_UNSUPPORTED"
  | "TASK_CARD_INVALID"
  | "TASK_ID_MISMATCH"
  | "TASK_REQUEST_INVALID"
  | "TASK_REQUEST_STATE_INVALID"
  | "TASK_CURRENT_REQUEST_INVALID"
  | "TASK_REFERENCES_INVALID"
  | "TASK_REPOSITORY_INVALID"
  | "TASK_REPOSITORY_DIRTY"
  | "TASK_BUSY"
  | "TASK_LOCKED"
  | "TASK_CHECKOUT_DIRTY"
  | "TASK_HEAD_MISMATCH"
  | "RUN_NOT_ACTIVE"
  | "RUN_ALREADY_ACTIVE"
  | "RUN_ALREADY_FINALIZED"
  | "RUN_TASK_BINDING_IMMUTABLE"
  | "RUN_STEP_NOT_CONTIGUOUS"
  | "MUTATION_REQUIRES_TASK_BINDING"
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
