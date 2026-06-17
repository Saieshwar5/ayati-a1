import type { InMemorySession } from "./session.js";
import type { SessionHandoffArtifact, SessionRotationReason } from "./types.js";

export interface BuildSessionHandoffInput {
  timezone: string;
  reason?: SessionRotationReason | null;
  preparedAt: string;
}

export function buildSessionHandoff(
  session: InMemorySession,
  input: BuildSessionHandoffInput,
): SessionHandoffArtifact {
  return {
    summary: "",
    snapshot: {
      sessionId: session.id,
      parentSessionId: null,
      timezone: input.timezone,
      reason: input.reason ?? null,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      activeGoals: [],
      completedWork: [],
      pendingWork: [],
      keyFacts: [],
      recentDialog: session.getConversationTurns(5),
      nextAction: "",
    },
    preparedAt: input.preparedAt,
    revision: session.timeline.length,
  };
}
