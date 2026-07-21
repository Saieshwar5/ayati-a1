import type { ContextCheckpointSummary } from "ayati-context-engine";

export type AgentTemporalExactEvent =
  | {
      kind: "user";
      seq: number;
      timestamp: string;
      content: string;
      current?: true;
    }
  | {
      kind: "assistant";
      seq: number;
      timestamp: string;
      content: string;
      responseKind?: string;
      expectsUserResponse?: boolean;
      current?: true;
    }
  | {
      kind: "system";
      seq: number;
      timestamp: string;
      content: string;
      current?: true;
    }
  | {
      kind: "system_event";
      seq: number;
      timestamp: string;
      source: string;
      event: string;
      summary: string;
      current?: true;
    };

export interface AgentTemporalCheckpointEvent {
  kind: "checkpoint";
  seq: number;
  timestamp: string;
  current?: never;
  schemaVersion: 1;
  coveredFromSeq: number;
  coveredToSeq: number;
  sourceEventCount: number;
  sourceHash: string;
  summary: ContextCheckpointSummary;
}

export type AgentTemporalEvent = AgentTemporalExactEvent | AgentTemporalCheckpointEvent;

const CHECKPOINT_STATEMENT_SCHEMA = {
  type: "object",
  properties: {
    seq: { type: "integer", minimum: 1 },
    text: { type: "string", minLength: 1 },
  },
  required: ["seq", "text"],
  additionalProperties: false,
};

export const AGENT_STREAM_CHECKPOINT_SUMMARY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    userRequests: checkpointStatementArraySchema(),
    constraints: checkpointStatementArraySchema(),
    decisions: checkpointStatementArraySchema(),
    corrections: checkpointStatementArraySchema(),
    importantFacts: checkpointStatementArraySchema(),
    unresolvedQuestions: checkpointStatementArraySchema(),
    references: checkpointStatementArraySchema(),
    narrative: { type: "string", minLength: 1 },
  },
  required: [
    "userRequests",
    "constraints",
    "decisions",
    "corrections",
    "importantFacts",
    "unresolvedQuestions",
    "references",
    "narrative",
  ],
  additionalProperties: false,
};

function checkpointStatementArraySchema(): Record<string, unknown> {
  return {
    type: "array",
    items: CHECKPOINT_STATEMENT_SCHEMA,
    maxItems: 64,
  };
}
