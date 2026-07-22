import { AsyncLocalStorage } from "node:async_hooks";
import type {
  EvaluationAttribution,
  ModelOperationPurpose,
} from "./contracts.js";

export interface EvaluationAsyncContext {
  evaluationId: string;
  sessionId?: string;
  runId?: string;
  laneId?: string;
  iteration?: number;
  operationId?: string;
  requestId?: string;
  spanId?: string;
  parentSpanId?: string;
  purpose?: ModelOperationPurpose;
  attribution: EvaluationAttribution;
}

const evaluationContextStorage = new AsyncLocalStorage<EvaluationAsyncContext>();

export function currentEvaluationContext(): EvaluationAsyncContext | undefined {
  return evaluationContextStorage.getStore();
}

export function runWithEvaluationContext<Value>(
  update: Partial<EvaluationAsyncContext>,
  task: () => Value,
): Value {
  const current = currentEvaluationContext();
  const evaluationId = update.evaluationId ?? current?.evaluationId;
  if (!evaluationId) return task();
  const next: EvaluationAsyncContext = {
    ...(current ?? { evaluationId, attribution: "background_unattributed" as const }),
    ...update,
    evaluationId,
    attribution: update.attribution ?? current?.attribution ?? "background_unattributed",
  };
  return evaluationContextStorage.run(next, task);
}

export function evaluationAttribution(): EvaluationAttribution {
  return currentEvaluationContext()?.attribution ?? "background_unattributed";
}
