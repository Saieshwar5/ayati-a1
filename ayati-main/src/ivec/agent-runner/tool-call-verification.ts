import type { VerifiedFact } from "../../skills/types.js";
import { checkDeterministicSuccessGate } from "../verification-gates.js";
import type { ActToolCallRecord } from "../types.js";
import type {
  ToolCallVerificationCheck,
  ToolCallVerificationRecord,
  ToolCallVerifiedFact,
} from "./tool-call-verification-contracts.js";

const TOOL_EXECUTION_FAILED = "TOOL_EXECUTION_FAILED";
const TOOL_OPERATION_INCOMPLETE = "TOOL_OPERATION_INCOMPLETE";
const TOOL_CONTRACT_FAILED = "TOOL_CONTRACT_FAILED";

export function deriveToolCallVerification(
  call: ActToolCallRecord,
): ToolCallVerificationRecord {
  const contract = call.result?.verification;
  if (call.error || call.operationStatus === "failed" || call.result?.operationStatus === "failed") {
    return failedVerification(call, contractChecks(call));
  }

  if (call.operationStatus === "partial" || call.result?.operationStatus === "partial") {
    return {
      version: 1,
      status: "failed",
      method: contract ? "tool_contract" : "execution_only",
      ...(contract ? { contract: "tool_result_v2" as const } : {}),
      summary: contract?.summary ?? `${call.tool} completed only partially.`,
      checks: contractChecks(call),
      facts: [],
      failure: {
        code: call.code ?? call.result?.code ?? TOOL_OPERATION_INCOMPLETE,
        message: contract?.summary ?? `${call.tool} completed only partially.`,
      },
    };
  }

  if (contract?.status === "passed") {
    return {
      version: 1,
      status: "passed",
      method: "tool_contract",
      contract: "tool_result_v2",
      summary: contract.summary,
      checks: contractChecks(call),
      facts: normalizeFacts(contract.facts),
    };
  }

  if (contract?.status === "failed") {
    return {
      version: 1,
      status: "failed",
      method: "tool_contract",
      contract: "tool_result_v2",
      summary: contract.summary,
      checks: contractChecks(call),
      facts: [],
      failure: {
        code: firstFailedCheckCode(call) ?? call.code ?? call.result?.code ?? TOOL_CONTRACT_FAILED,
        message: contract.summary,
      },
    };
  }

  const deterministic = checkDeterministicSuccessGate(
    { toolCalls: [call], finalText: "" },
    call.purpose?.trim() || `${call.tool} completed`,
  );
  if (deterministic?.passed) {
    return {
      version: 1,
      status: "passed",
      method: "runtime_check",
      contract: "deterministic_success_gate_v1",
      summary: deterministic.summary,
      checks: [{
        id: "deterministic_success_gate",
        kind: "runtime_check",
        status: "passed",
        severity: "required",
      }],
      facts: deterministic.newFacts.map((message) => ({
        kind: "tool.execution.verified",
        message,
      })),
    };
  }

  return {
    version: 1,
    status: "not_available",
    method: "execution_only",
    summary: `${call.tool} returned successfully, but no deterministic verification contract was available.`,
    checks: [],
    facts: [],
  };
}

export function toolCallVerificationPassed(
  call: {
    verification?: ToolCallVerificationRecord;
    verificationPassed?: boolean;
  },
): boolean {
  if (call.verification) {
    return call.verification.status === "passed";
  }
  return call.verificationPassed === true;
}

function failedVerification(
  call: ActToolCallRecord,
  checks: ToolCallVerificationCheck[],
): ToolCallVerificationRecord {
  const contract = call.result?.verification;
  const message = call.error
    ?? contract?.summary
    ?? call.result?.message
    ?? `${call.tool} failed during execution.`;
  return {
    version: 1,
    status: "failed",
    method: contract?.status === "failed" ? "tool_contract" : "execution_only",
    ...(contract?.status === "failed" ? { contract: "tool_result_v2" as const } : {}),
    summary: message,
    checks,
    facts: [],
    failure: {
      code: firstFailedCheckCode(call) ?? call.code ?? call.result?.code ?? TOOL_EXECUTION_FAILED,
      message,
    },
  };
}

function contractChecks(call: ActToolCallRecord): ToolCallVerificationCheck[] {
  return (call.result?.verification?.assertions ?? []).map((assertion) => ({
    id: assertion.id,
    kind: assertion.kind,
    status: assertion.status,
    severity: assertion.severity,
    ...(assertion.error?.code ? { code: assertion.error.code } : {}),
  }));
}

function firstFailedCheckCode(call: ActToolCallRecord): string | undefined {
  return call.result?.verification?.assertions.find(
    (assertion) => assertion.status === "failed" && assertion.severity === "required",
  )?.error?.code;
}

function normalizeFacts(facts: VerifiedFact[]): ToolCallVerifiedFact[] {
  const normalized = facts.map((fact) => ({
    ...(fact.id ? { id: fact.id } : {}),
    kind: fact.kind,
    message: fact.message,
    ...(fact.path ? { subject: fact.path } : {}),
    ...(fact.data ? { data: fact.data } : {}),
  }));
  return [...new Map(normalized.map((fact) => [
    JSON.stringify([fact.id, fact.kind, fact.message, fact.subject, fact.data]),
    fact,
  ])).values()];
}
