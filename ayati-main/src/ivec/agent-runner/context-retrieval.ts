import type { ToolExecutionContext } from "../../skills/types.js";
import type { LoopState } from "../types.js";
import type { AgentAction } from "./decision.js";
import type { CapabilitySurfaceManager } from "./capabilities/surface-manager.js";
import { restoreVirtualModeAfterContextRetrieval } from "./virtual-mode.js";

export function isContextRetrievalAction(
  state: LoopState,
  action: AgentAction,
): boolean {
  return state.virtualMode.active === "context.retrieve"
    && action.calls.length > 0
    && action.calls.every((call) => call.tool === "context_load");
}

export function completeContextRetrieval(input: {
  state: LoopState;
  capabilitySurfaceManager?: CapabilitySurfaceManager;
  toolContext: ToolExecutionContext;
}): void {
  if (input.state.virtualMode.active !== "context.retrieve") {
    return;
  }

  input.state.virtualMode = restoreVirtualModeAfterContextRetrieval(
    input.state.virtualMode,
  );
  const active = input.state.virtualMode.active;
  const capabilities = input.state.virtualMode.capabilities;

  if (!input.capabilitySurfaceManager) {
    return;
  }
  if (
    !active
    || active === "context.maintain"
    || active === "run.maintain"
    || capabilities.length === 0
  ) {
    input.capabilitySurfaceManager.resetRun(input.toolContext);
    return;
  }

  input.state.lastCapabilitySurface = input.capabilitySurfaceManager
    .replaceWithCapabilities({
      capabilities,
      mode: active,
      state: input.state,
      context: input.toolContext,
    });
}
