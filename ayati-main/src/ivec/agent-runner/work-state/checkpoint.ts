import type {
  ImportantContextItem,
  WorkPlanItem,
  WorkStateUpdateInput,
} from "./contracts.js";
import { WORK_STATE_LIMITS } from "./contracts.js";

export function normalizeWorkStateUpdateInput(
  value: Record<string, unknown>,
): WorkStateUpdateInput {
  const reason = value["reason"];
  if (reason !== "plan" && reason !== "context_pressure") {
    throw new Error("WorkState checkpoint reason must be plan or context_pressure.");
  }
  const summary = requiredText(
    value["summary"],
    "summary",
    WORK_STATE_LIMITS.summaryChars,
  );
  const plan = normalizePlan(value["plan"]);
  if (reason === "plan" && plan.length === 0) {
    throw new Error("A plan checkpoint requires at least one implementation-plan item.");
  }
  const importantContext = normalizeImportantContext(value["importantContext"]);
  const nextAction = optionalText(
    value["nextAction"],
    "nextAction",
    WORK_STATE_LIMITS.nextActionChars,
  );
  return {
    reason,
    summary,
    plan,
    importantContext,
    ...(nextAction ? { nextAction } : {}),
  };
}

function normalizePlan(value: unknown): WorkPlanItem[] {
  if (!Array.isArray(value) || value.length > WORK_STATE_LIMITS.planItems) {
    throw new Error(
      `WorkState plan must be an array with at most ${WORK_STATE_LIMITS.planItems} items.`,
    );
  }
  const seen = new Set<string>();
  let activeCount = 0;
  return value.map((candidate, index) => {
    const item = record(candidate, `plan[${index}]`);
    const id = requiredText(
      item["id"],
      `plan[${index}].id`,
      WORK_STATE_LIMITS.planIdChars,
    );
    if (seen.has(id)) {
      throw new Error("WorkState plan item ids must be unique.");
    }
    seen.add(id);
    const status = item["status"];
    if (!["pending", "active", "done", "blocked"].includes(String(status))) {
      throw new Error(`WorkState plan[${index}].status is invalid.`);
    }
    if (status === "active" && ++activeCount > 1) {
      throw new Error("WorkState plan may contain at most one active item.");
    }
    return {
      id,
      task: requiredText(
        item["task"],
        `plan[${index}].task`,
        WORK_STATE_LIMITS.planTaskChars,
      ),
      status: status as WorkPlanItem["status"],
    };
  });
}

function normalizeImportantContext(value: unknown): ImportantContextItem[] {
  if (!Array.isArray(value)
    || value.length > WORK_STATE_LIMITS.importantContextItems) {
    throw new Error(
      "WorkState importantContext must be an array with at most "
        + WORK_STATE_LIMITS.importantContextItems
        + " items.",
    );
  }
  return value.map((candidate, index) => {
    const item = record(candidate, `importantContext[${index}]`);
    const kind = item["kind"];
    if (!["artifact", "decision", "finding", "constraint"].includes(String(kind))) {
      throw new Error(`WorkState importantContext[${index}].kind is invalid.`);
    }
    const ref = optionalText(
      item["ref"],
      `importantContext[${index}].ref`,
      WORK_STATE_LIMITS.importantContextRefChars,
    );
    return {
      kind: kind as ImportantContextItem["kind"],
      value: requiredText(
        item["value"],
        `importantContext[${index}].value`,
        WORK_STATE_LIMITS.importantContextValueChars,
      ),
      ...(ref ? { ref } : {}),
    };
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`WorkState ${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string, maximum: number): string {
  const text = optionalText(value, field, maximum);
  if (!text) throw new Error(`WorkState ${field} must not be empty.`);
  return text;
}

function optionalText(
  value: unknown,
  field: string,
  maximum: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`WorkState ${field} must be a string.`);
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length > maximum) {
    throw new Error(`WorkState ${field} must contain at most ${maximum} characters.`);
  }
  return normalized || undefined;
}
