import type { ToolErrorCategory, ToolStructuredError } from "../types.js";

interface ErrnoLike {
  code?: string;
  path?: string;
}

function isErrnoLike(value: unknown): value is ErrnoLike {
  return typeof value === "object" && value !== null;
}

export function classifyErrorMessage(message: string): Pick<ToolStructuredError, "category" | "code" | "retryable" | "recoverable" | "suggestedNextActions"> {
  const normalized = message.toLowerCase();
  if (normalized.includes("invalid input")) {
    return {
      category: "validation",
      code: "VALIDATION_ERROR",
      retryable: true,
      recoverable: true,
      suggestedNextActions: ["Fix the tool input to match the schema and retry."],
    };
  }
  if (normalized.includes("duplicate target path")) {
    return {
      category: "conflict",
      code: "DUPLICATE_TARGET_PATH",
      retryable: true,
      recoverable: true,
      suggestedNextActions: ["Remove duplicate target paths from the request and retry."],
    };
  }
  if (normalized.includes("enoent") || normalized.includes("no such file") || normalized.includes("does not exist")) {
    return {
      category: "missing_path",
      code: "MISSING_PATH",
      retryable: true,
      recoverable: true,
      suggestedNextActions: ["Create the missing parent path or retry with createDirs=true when supported."],
    };
  }
  if (normalized.includes("eacces") || normalized.includes("permission denied")) {
    return {
      category: "permission",
      code: "PERMISSION_DENIED",
      retryable: false,
      recoverable: true,
      suggestedNextActions: ["Use a writable path or request permission before retrying."],
    };
  }
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return {
      category: "timeout",
      code: "TIMEOUT",
      retryable: true,
      recoverable: true,
      suggestedNextActions: ["Retry with a longer timeout or a narrower operation."],
    };
  }
  return {
    category: "unknown",
    code: "TOOL_ERROR",
    retryable: false,
    recoverable: false,
    suggestedNextActions: ["Inspect the tool error and choose a corrected next action."],
  };
}

export function errnoToCategory(err: unknown): ToolErrorCategory {
  if (!isErrnoLike(err)) {
    return "unknown";
  }
  switch (err.code) {
    case "ENOENT":
      return "missing_path";
    case "EACCES":
    case "EPERM":
      return "permission";
    case "EEXIST":
      return "conflict";
    case "ETIMEDOUT":
      return "timeout";
    default:
      return "unknown";
  }
}

