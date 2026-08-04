export interface AgentEventInput {
  clientId?: string;
  sessionId?: string;
  seq?: number;
  runId?: string;
  stage: string;
  event: string;
  data?: Record<string, unknown>;
}

export interface AgentEventSink {
  record(event: AgentEventInput): void;
  scheduleCheckpoint?(runId?: string): void;
}

export const NOOP_AGENT_EVENT_SINK: AgentEventSink = Object.freeze({
  record(): void {},
});
