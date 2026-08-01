import type { LoopState } from "../types.js";
import type {
  ContextMaintenanceFinish,
  ContextMaintenanceLifecycle,
  ContextMaintenanceStart,
} from "../context-preparation/context-maintenance.js";
import type { AgentStateView } from "./state-view.js";
import {
  enterContextMaintainMode,
  restoreVirtualModeAfterContextMaintenance,
} from "./virtual-mode.js";

export function createContextMaintenanceLifecycle(input: {
  state: LoopState;
  buildStateView: () => AgentStateView;
  onEvent?: (event: "entered" | "restored", data: Record<string, unknown>) => void;
}): ContextMaintenanceLifecycle {
  return {
    enter: (start) => enter(input, start),
    exit: (finish) => exit(input, finish),
  };
}

function enter(
  input: {
    state: LoopState;
    onEvent?: (event: "entered" | "restored", data: Record<string, unknown>) => void;
  },
  start: ContextMaintenanceStart,
): void {
  const returnMode = input.state.virtualMode.active ?? "ENTRY";
  input.state.virtualMode = enterContextMaintainMode(
    input.state.virtualMode,
    start,
    input.state.iteration,
  );
  input.onEvent?.("entered", {
    reason: start.reason,
    returnMode,
    protectFromSeq: start.protectFromSeq,
    continuityMaxTokens: start.continuityMaxTokens,
    unloadedRanges: start.unloadedRanges,
    modeRevision: input.state.virtualMode.revision,
  });
}

function exit(
  input: {
    state: LoopState;
    buildStateView: () => AgentStateView;
    onEvent?: (event: "entered" | "restored", data: Record<string, unknown>) => void;
  },
  finish: ContextMaintenanceFinish,
): AgentStateView {
  const maintenanceRevision = input.state.virtualMode.revision;
  input.state.virtualMode = restoreVirtualModeAfterContextMaintenance(
    input.state.virtualMode,
  );
  input.onEvent?.("restored", {
    ...finish,
    restoredMode: input.state.virtualMode.active ?? "ENTRY",
    maintenanceRevision,
    modeRevision: input.state.virtualMode.revision,
  });
  return input.buildStateView();
}
