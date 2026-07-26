import type { LlmProvider } from "../../core/contracts/provider.js";
import type { LlmTurnInput } from "../../core/contracts/llm-protocol.js";
import type { ContextBudgetReport } from "../../prompt/context-budget.js";
import type {
  ContextCompilationMode,
  ContextCompilationReceipt,
} from "../../prompt/context-compilation-receipt.js";
import { measureTurnContext } from "../../prompt/context-token-counter.js";
import type { ResolvedModelContextLimits } from "../../providers/shared/model-context-limits.js";
import type { AgentPromptStateView } from "../agent-runner/prompt-context.js";
import type { AgentStateView } from "../agent-runner/state-view.js";
import { planToolContextProjection } from "../agent-runner/tool-context-projection-planner.js";
import { buildToolContextProjectionCandidate } from "../agent-runner/tool-context-shadow.js";
import type { DecisionContextCompilation } from "./admission-types.js";

export interface MainDeterministicRecoveryResult {
  stateView: AgentPromptStateView;
  turnInput: LlmTurnInput;
  intermediateBudget: ContextBudgetReport;
  finalBudget: ContextBudgetReport;
  transformations: ContextCompilationReceipt["transformations"];
  projection?: DecisionContextCompilation["projection"];
  mode: ContextCompilationMode;
  measured: boolean;
}

export async function recoverMainContextDeterministically(input: {
  provider: LlmProvider;
  contextLimits: ResolvedModelContextLimits;
  stateView: AgentPromptStateView;
  turnInput: LlmTurnInput;
  budget: ContextBudgetReport;
  buildPrompt: (stateView: AgentPromptStateView) => string;
}): Promise<MainDeterministicRecoveryResult> {
  let stateView = input.stateView;
  let turnInput = input.turnInput;
  let budget = input.budget;
  let intermediateBudget = budget;
  let measured = false;
  let mode: ContextCompilationMode = "full";
  const transformations: ContextCompilationReceipt["transformations"] = [];
  let projection: DecisionContextCompilation["projection"];

  const toolPlan = planToolContextProjection({
    calls: stateView.context.run?.toolCalls ?? [],
    candidateInputTokens: budget.measuredInputTokens,
    recoveryTargetTokens: budget.recoveryTargetTokens,
    softInputTokens: budget.softInputTokens,
  });
  const toolTransformations = toolPlan.calls.filter((call) => call.mode !== "full");
  if (toolTransformations.length > 0) {
    const before = budget.measuredInputTokens;
    const projected = buildToolContextProjectionCandidate({
      stateView: stateView as AgentStateView,
      requestMessages: turnInput.messages,
      turnInput,
      plan: toolPlan,
      budget,
      buildPrompt: input.buildPrompt,
    });
    const run = stateView.context.run;
    stateView = run ? {
      ...stateView,
      context: {
        ...stateView.context,
        run: { ...run, toolCalls: toolPlan.projectedCalls },
      },
    } : stateView;
    turnInput = projected.turnInput;
    budget = await measure(input, turnInput);
    intermediateBudget = budget;
    measured = true;
    mode = "tool_compact";
    projection = {
      event: "tool_context_projection_enforced",
      policy: "enforce",
      receipt: projected.receipt,
    };
    transformations.push(...toolTransformations.map((call) => ({
      kind: "tool_call_projection",
      ...(call.callId ? { callId: call.callId } : {}),
      tool: call.tool,
      ...(call.projectorId ? { projectorId: call.projectorId } : {}),
      from: "full",
      to: call.mode,
      reason: call.reason,
      tokensBefore: call.tokensBefore,
      tokensAfter: call.tokensAfter,
    })));
    if (before === budget.measuredInputTokens) intermediateBudget = input.budget;
  }

  return {
    stateView,
    turnInput,
    intermediateBudget,
    finalBudget: budget,
    transformations,
    ...(projection ? { projection } : {}),
    mode,
    measured,
  };
}

async function measure(
  input: { provider: LlmProvider; contextLimits: ResolvedModelContextLimits },
  turnInput: LlmTurnInput,
): Promise<ContextBudgetReport> {
  return await measureTurnContext({
    provider: input.provider,
    turnInput,
    limits: input.contextLimits,
  });
}
