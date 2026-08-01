import type { LlmToolSchema } from "../../core/contracts/llm-protocol.js";
import type { PromptRunContextMaintenanceCard } from "./run-context-maintenance-contracts.js";
import { RUN_CONTEXT_MAINTENANCE_LIMITS } from "./run-context-maintenance-contracts.js";
import { WORK_STATE_LIMITS } from "./work-state/contracts.js";

export const RUN_CONTEXT_MAINTENANCE_TOOL_NAME = "decision_maintain_run_context";

export function buildRunContextMaintenanceControlTool(
  card: PromptRunContextMaintenanceCard,
): LlmToolSchema {
  const exactRefs = card.candidates.map((candidate) => candidate.ref);
  const compactRefs = card.candidates
    .filter((candidate) => candidate.policy === "projectable" && !candidate.mandatoryExact)
    .map((candidate) => candidate.ref);
  const releaseRefs = card.candidates
    .filter((candidate) => candidate.policy !== "exact_only" && !candidate.mandatoryExact)
    .map((candidate) => candidate.ref);
  return {
    name: RUN_CONTEXT_MAINTENANCE_TOOL_NAME,
    description: "Complete run-context maintenance. Preserve a concise in-progress WorkState, pin only exceptional tool calls, and let the runtime deterministically compact or reference the rest. This changes only the active prompt projection; exact tool records remain durable.",
    inputSchema: objectSchema({
      maintenanceId: {
        type: "string",
        enum: [card.maintenanceId],
      },
      expectedWorkStateRevision: {
        type: "integer",
        enum: [card.expectedWorkStateRevision],
      },
      workState: workStateSchema(),
      keepExactRefs: referenceArraySchema(
        exactRefs,
        "Calls whose exact input/output is essential for the immediate next action. Keep this list small.",
      ),
      keepCompactRefs: referenceArraySchema(
        compactRefs,
        "Calls that still matter semantically but need only a bounded typed preview.",
      ),
      releaseRefs: referenceArraySchema(
        releaseRefs,
        "Calls no longer needed in active context. They remain recoverable from the exact run journal.",
      ),
      workingNotes: {
        type: "array",
        items: { type: "string" },
        maxItems: 5,
      },
    }, [
      "maintenanceId",
      "expectedWorkStateRevision",
      "workState",
      "keepExactRefs",
      "keepCompactRefs",
      "releaseRefs",
    ]),
  };
}

function workStateSchema(): Record<string, unknown> {
  return objectSchema({
    summary: {
      type: "string",
      minLength: 1,
      maxLength: WORK_STATE_LIMITS.summaryChars,
      description: "Concise verified progress and the current responsibility. Do not copy tool logs.",
    },
    plan: {
      type: "array",
      maxItems: WORK_STATE_LIMITS.planItems,
      items: objectSchema({
        id: {
          type: "string",
          minLength: 1,
          maxLength: WORK_STATE_LIMITS.planIdChars,
        },
        task: {
          type: "string",
          minLength: 1,
          maxLength: WORK_STATE_LIMITS.planTaskChars,
        },
        status: {
          type: "string",
          enum: ["pending", "active", "done", "blocked"],
        },
      }, ["id", "task", "status"]),
    },
    importantContext: {
      type: "array",
      maxItems: WORK_STATE_LIMITS.importantContextItems,
      items: objectSchema({
        kind: {
          type: "string",
          enum: ["artifact", "decision", "finding", "constraint"],
        },
        value: {
          type: "string",
          minLength: 1,
          maxLength: WORK_STATE_LIMITS.importantContextValueChars,
        },
        ref: {
          type: "string",
          minLength: 1,
          maxLength: WORK_STATE_LIMITS.importantContextRefChars,
        },
      }, ["kind", "value"]),
    },
    nextAction: {
      type: "string",
      minLength: 1,
      maxLength: WORK_STATE_LIMITS.nextActionChars,
    },
  }, ["summary", "plan", "importantContext"]);
}

function referenceArraySchema(refs: string[], description: string): Record<string, unknown> {
  return {
    type: "array",
    maxItems: RUN_CONTEXT_MAINTENANCE_LIMITS.selectionRefs,
    uniqueItems: true,
    description,
    items: refs.length > 0
      ? { type: "string", enum: refs }
      : { type: "string", enum: [] },
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
