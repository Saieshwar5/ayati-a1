import { SESSION_SNAPSHOT_JSON_SCHEMA } from "./session-snapshot-schema.js";

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function statementArraySchema(): Record<string, unknown> {
  return {
    type: "array",
    items: objectSchema({
      seq: { type: "integer", minimum: 1 },
      text: { type: "string", minLength: 1 },
    }),
    maxItems: 64,
  };
}

export const TASK_RUN_SESSION_INTERVAL_SCHEMA: Record<string, unknown> = objectSchema({
  summary: { type: "string", minLength: 1 },
  userRequests: statementArraySchema(),
  assistantCommitments: statementArraySchema(),
  decisions: statementArraySchema(),
  corrections: statementArraySchema(),
  constraints: statementArraySchema(),
  importantFacts: statementArraySchema(),
  unresolvedQuestions: statementArraySchema(),
  references: statementArraySchema(),
});

export const TASK_RUN_SESSION_UPDATE_SCHEMA: Record<string, unknown> = objectSchema({
  sessionInterval: TASK_RUN_SESSION_INTERVAL_SCHEMA,
  sessionSnapshot: SESSION_SNAPSHOT_JSON_SCHEMA,
});
