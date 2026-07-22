import type {
  ToolExecutor,
  ToolRegistryContext,
  ValidationResult,
} from "../skills/tool-executor.js";
import type {
  ToolExecutionContext,
  ToolResult,
} from "../skills/types.js";
import { getActiveEvaluationRecorder, withEvaluationContext } from "./capture-runtime.js";

export function createEvaluationToolExecutor(executor: ToolExecutor): ToolExecutor {
  const recorder = getActiveEvaluationRecorder();
  if (!recorder) return executor;
  return {
    list: (context?: ToolRegistryContext) => executor.list(context),
    definitions: (context?: ToolRegistryContext) => executor.definitions(context),
    validate: (toolName: string, input: unknown, context?: ToolRegistryContext): ValidationResult =>
      executor.validate(toolName, input, context),
    async execute(toolName: string, input: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
      const started = process.hrtime.bigint();
      const common = {
        ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
        ...(context?.runId ? { runId: context.runId } : {}),
      };
      return await withEvaluationContext({
        ...common,
        iteration: context?.stepNumber,
        attribution: "foreground",
      }, async () => {
        recorder.record({
          ...common,
          stage: "tool",
          event: "started",
          data: {
            tool: toolName,
            callId: context?.callId,
            step: context?.stepNumber,
            input,
          },
        });
        try {
          const result = await executor.execute(toolName, input, context);
          recorder.record({
            ...common,
            stage: "tool",
            event: "completed",
            data: {
              tool: toolName,
              callId: context?.callId,
              step: context?.stepNumber,
              input,
              output: result.output,
              rawOutput: result.rawOutput,
              error: result.error,
              ok: result.ok,
              v2: result.v2,
              durationMs: elapsedMs(started),
            },
          });
          return result;
        } catch (error) {
          recorder.record({
            ...common,
            stage: "tool",
            event: "failed",
            data: { tool: toolName, input, error, durationMs: elapsedMs(started) },
          });
          throw error;
        }
      });
    },
    ...(executor.mount ? { mount: (groupId, tools, meta) => executor.mount!(groupId, tools, meta) } : {}),
    ...(executor.unmount ? { unmount: (groupId) => executor.unmount!(groupId) } : {}),
    ...(executor.listMountedGroups ? { listMountedGroups: (context) => executor.listMountedGroups!(context) } : {}),
    ...(executor.cleanupExpired ? { cleanupExpired: (context) => executor.cleanupExpired!(context) } : {}),
  };
}

function elapsedMs(startedNs: bigint): number {
  return Number(process.hrtime.bigint() - startedNs) / 1_000_000;
}
