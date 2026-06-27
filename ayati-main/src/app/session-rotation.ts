import type { SessionMemory, SessionRotationReason } from "../memory/types.js";
import {
  evaluateSessionRotation,
  type RotationPolicyConfig,
} from "../ivec/session-rotation-policy.js";
import { devWarn } from "../shared/index.js";

export type PreRunSessionRotationResult =
  | {
      rotated: false;
      reason: "unsupported" | "missing_status" | "not_needed";
    }
  | {
      rotated: true;
      reason: SessionRotationReason | "policy_rotation";
      contextPercent: number;
    };

export interface RotateSessionBeforeRunInput {
  clientId: string;
  sessionMemory: SessionMemory;
  now: () => Date;
  rotationPolicyConfig?: Partial<RotationPolicyConfig>;
}

export function rotateSessionBeforeRunIfNeeded(input: RotateSessionBeforeRunInput): PreRunSessionRotationResult {
  const createSession = input.sessionMemory.createSession;
  if (!createSession) {
    return { rotated: false, reason: "unsupported" };
  }

  const sessionStatus = input.sessionMemory.getSessionStatus?.() ?? null;
  if (!sessionStatus) {
    return { rotated: false, reason: "missing_status" };
  }

  const rotationDecision = evaluateSessionRotation({
    now: input.now(),
    contextPercent: sessionStatus.contextPercent,
    sessionStartedAt: sessionStatus.startedAt,
    timezone: null,
    pendingRotationReason: sessionStatus.pendingRotationReason,
    config: input.rotationPolicyConfig,
  });

  if (!rotationDecision.rotate) {
    return { rotated: false, reason: "not_needed" };
  }

  const reason = rotationDecision.reason ?? "policy_rotation";
  createSession.call(input.sessionMemory, input.clientId, {
    runId: `pre-run-rotation-${Date.now()}`,
    reason,
    source: "system",
    timezone: rotationDecision.timezone,
  });

  devWarn(
    `Pre-run session rotation triggered (${rotationDecision.reason ?? "unknown"}) at ${Math.round(sessionStatus.contextPercent)}% context`,
  );

  return {
    rotated: true,
    reason,
    contextPercent: sessionStatus.contextPercent,
  };
}
