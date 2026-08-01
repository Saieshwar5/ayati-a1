import {
  CONTEXT_CHECKPOINT_CATEGORY_MAX_ITEMS,
  CONTEXT_CHECKPOINT_NARRATIVE_MAX_CHARS,
  CONTEXT_CHECKPOINT_STATEMENT_MAX_CHARS,
  type AssistantFeedbackKind,
  type AssistantResponseKind,
  type MessageAttachmentRef,
  type StreamMessage,
} from "ayati-context-engine";

export type AgentTemporalExactEvent =
  | {
      kind: "user";
      seq: number;
      timestamp: string;
      content: string;
      attachmentRefs?: MessageAttachmentRef[];
      current?: true;
    }
  | {
      kind: "assistant";
      seq: number;
      timestamp: string;
      content: string;
      responseKind?: AssistantResponseKind;
      feedbackKind?: AssistantFeedbackKind;
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

export type AgentTemporalEvent = AgentTemporalExactEvent;

export function projectStreamMessageEvent(
  message: StreamMessage,
  current = false,
): AgentTemporalExactEvent {
  if (message.role === "assistant") {
    return {
      kind: "assistant",
      seq: message.sequence,
      timestamp: message.at,
      content: message.content,
      ...(message.responseKind ? { responseKind: message.responseKind } : {}),
      ...(message.feedbackKind ? { feedbackKind: message.feedbackKind } : {}),
      ...(current ? { current: true } : {}),
    };
  }
  if (message.role === "system_event") {
    return {
      kind: "system",
      seq: message.sequence,
      timestamp: message.at,
      content: message.content,
      ...(current ? { current: true } : {}),
    };
  }
  return {
    kind: "user",
    seq: message.sequence,
    timestamp: message.at,
    content: message.content,
    ...(message.attachmentRefs && message.attachmentRefs.length > 0
      ? { attachmentRefs: message.attachmentRefs }
      : {}),
    ...(current ? { current: true } : {}),
  };
}

const CHECKPOINT_STATEMENT_SCHEMA = {
  type: "object",
  properties: {
    seq: { type: "integer", minimum: 1 },
    text: {
      type: "string",
      minLength: 1,
      maxLength: CONTEXT_CHECKPOINT_STATEMENT_MAX_CHARS,
    },
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
    narrative: {
      type: "string",
      minLength: 1,
      maxLength: CONTEXT_CHECKPOINT_NARRATIVE_MAX_CHARS,
    },
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
    maxItems: CONTEXT_CHECKPOINT_CATEGORY_MAX_ITEMS,
  };
}
