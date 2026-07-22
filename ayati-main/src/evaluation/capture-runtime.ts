import type { LlmProvider } from "../core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../core/contracts/llm-protocol.js";
import {
  currentEvaluationContext,
  runWithEvaluationContext,
  type EvaluationAsyncContext,
} from "./async-context.js";
import type {
  EvaluationOperationStart,
  ModelOperationPurpose,
} from "./contracts.js";
import type { LiveEvaluationRecorder } from "./recorder.js";

let activeRecorder: LiveEvaluationRecorder | undefined;

export function setActiveEvaluationRecorder(recorder: LiveEvaluationRecorder | undefined): void {
  activeRecorder = recorder;
}

export function getActiveEvaluationRecorder(): LiveEvaluationRecorder | undefined {
  return activeRecorder;
}

export function isLiveEvaluationEnabled(): boolean {
  return activeRecorder !== undefined;
}

export function withEvaluationContext<Value>(
  context: Partial<EvaluationAsyncContext>,
  task: () => Value,
): Value {
  const recorder = activeRecorder;
  if (!recorder) return task();
  return runWithEvaluationContext({ evaluationId: recorder.session.evaluationId, ...context }, task);
}

export async function withEvaluationModelOperation<Value>(
  input: EvaluationOperationStart,
  task: () => Promise<Value>,
): Promise<Value> {
  const recorder = activeRecorder;
  if (!recorder) return await task();
  const operationId = recorder.startOperation(input);
  try {
    const result = await runWithEvaluationContext({
      evaluationId: recorder.session.evaluationId,
      operationId,
      purpose: input.purpose,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.laneId ? { laneId: input.laneId } : {}),
      ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
      ...(input.attribution ? { attribution: input.attribution } : {}),
    }, task);
    recorder.finishOperation(operationId);
    return result;
  } catch (error) {
    recorder.finishOperation(operationId, error);
    throw error;
  }
}

export function captureProviderNativePayload(input: {
  provider: string;
  operation: "countInputTokens" | "generateTurn" | "streamTurn";
  payload: unknown;
}): void {
  activeRecorder?.recordProviderTransport(input);
}

export function captureProviderNativeResponse(input: {
  provider: string;
  operation: "countInputTokens" | "generateTurn" | "streamTurn";
  response: unknown;
}): void {
  activeRecorder?.recordProviderResponse(input);
}

export function createEvaluationProvider(provider: LlmProvider): LlmProvider {
  const recorder = activeRecorder;
  if (!recorder) return provider;
  return {
    get name() {
      return provider.name;
    },
    get version() {
      return provider.version;
    },
    get capabilities() {
      return provider.capabilities;
    },
    start: () => provider.start(),
    stop: () => provider.stop(),
    ...(provider.countInputTokens
      ? {
          countInputTokens: async (input: LlmTurnInput) => {
            const started = process.hrtime.bigint();
            try {
              const result = await provider.countInputTokens!(input);
              recorder.record({
                ...(currentEvaluationContext()?.sessionId ? { sessionId: currentEvaluationContext()!.sessionId } : {}),
                ...(currentEvaluationContext()?.runId ? { runId: currentEvaluationContext()!.runId } : {}),
                stage: "context_token_count",
                event: "completed",
                data: { durationMs: elapsedMs(started), result },
              });
              return result;
            } catch (error) {
              recorder.record({
                stage: "context_token_count",
                event: "failed",
                data: { durationMs: elapsedMs(started), error },
              });
              throw error;
            }
          },
        }
      : {}),
    generateTurn: async (input: LlmTurnInput): Promise<LlmTurnOutput> =>
      await captureTurn(provider, "generateTurn", input, () => provider.generateTurn(input), callbacksNone()),
    ...(provider.streamTurn
      ? {
          streamTurn: async (input, callbacks) => {
            let firstTokenNs: bigint | undefined;
            const wrapped = {
              ...callbacks,
              onTextDelta: (delta: string): void => {
                firstTokenNs ??= process.hrtime.bigint();
                callbacks.onTextDelta?.(delta);
              },
            };
            return await captureTurn(
              provider,
              "streamTurn",
              input,
              () => provider.streamTurn!(input, wrapped),
              () => firstTokenNs,
            );
          },
        }
      : {}),
  };
}

async function captureTurn(
  provider: LlmProvider,
  invocation: "generateTurn" | "streamTurn",
  input: LlmTurnInput,
  invoke: (callbacks?: unknown) => Promise<LlmTurnOutput>,
  firstToken: () => bigint | undefined,
): Promise<LlmTurnOutput> {
  const recorder = activeRecorder;
  if (!recorder) return await invoke();
  const current = currentEvaluationContext();
  if (!current?.operationId) {
    return await withEvaluationModelOperation({
      purpose: "unclassified",
      attribution: "background_unattributed",
    }, async () => await captureTurn(provider, invocation, input, invoke, firstToken));
  }
  const requestId = recorder.startProviderRequest({
    provider: provider.name,
    providerVersion: provider.version,
    invocation,
    input,
  });
  const startedNs = process.hrtime.bigint();
  return await runWithEvaluationContext({
    evaluationId: recorder.session.evaluationId,
    requestId,
  }, async () => {
    try {
      const output = await invoke();
      const completedNs = process.hrtime.bigint();
      const firstNs = firstToken();
      recorder.finishProviderRequest(requestId, {
        output,
        durationMs: nsDifferenceMs(startedNs, completedNs),
        ...(firstNs ? { timeToFirstTokenMs: nsDifferenceMs(startedNs, firstNs) } : {}),
        ...(firstNs ? { streamingDurationMs: nsDifferenceMs(firstNs, completedNs) } : {}),
      });
      return output;
    } catch (error) {
      recorder.finishProviderRequest(requestId, {
        error,
        durationMs: elapsedMs(startedNs),
      });
      throw error;
    }
  });
}

export function operationPurposeForDecision(input: {
  finalResponse: boolean;
  decisionAttempt: number;
  providerAttempt: number;
}): ModelOperationPurpose {
  if (input.providerAttempt > 1) return "provider_retry";
  if (input.finalResponse) return "final_response";
  return input.decisionAttempt > 1 ? "decision_repair" : "main_decision";
}

function callbacksNone(): () => undefined {
  return () => undefined;
}

function elapsedMs(startedNs: bigint): number {
  return Number(process.hrtime.bigint() - startedNs) / 1_000_000;
}

function nsDifferenceMs(startedNs: bigint, completedNs: bigint): number {
  return Number(completedNs - startedNs) / 1_000_000;
}
