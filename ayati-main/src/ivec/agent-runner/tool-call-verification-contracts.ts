export type ToolCallVerificationStatus =
  | "passed"
  | "failed"
  | "not_available";

export type ToolCallVerificationMethod =
  | "tool_contract"
  | "runtime_check"
  | "execution_only";

export interface ToolCallVerificationCheck {
  id: string;
  kind: string;
  status: "passed" | "failed" | "skipped";
  severity: "required" | "warning" | "info";
  code?: string;
}

export interface ToolCallVerifiedFact {
  id?: string;
  kind: string;
  message: string;
  subject?: string;
  data?: Record<string, unknown>;
}

export interface ToolCallVerificationFailure {
  code: string;
  message: string;
}

/**
 * Compact deterministic verification owned by one exact tool call.
 *
 * The complete input, output, artifacts, and diagnostics remain on the
 * surrounding call record. This object stores only whether that call was
 * deterministically verified and the normalized facts established by it.
 */
export interface ToolCallVerificationRecord {
  version: 1;
  status: ToolCallVerificationStatus;
  method: ToolCallVerificationMethod;
  contract?: "tool_result_v2" | "deterministic_success_gate_v1";
  summary: string;
  checks: ToolCallVerificationCheck[];
  facts: ToolCallVerifiedFact[];
  failure?: ToolCallVerificationFailure;
}
