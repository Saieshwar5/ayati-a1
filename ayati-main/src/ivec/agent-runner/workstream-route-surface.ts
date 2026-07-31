import type { ToolExecutionContext } from "../../skills/types.js";
import type { CapabilitySurfaceResult } from "./capabilities/contracts.js";
import type { CapabilitySurfaceManager } from "./capabilities/surface-manager.js";

export function createControlOnlyWorkstreamRouteSurface(): CapabilitySurfaceResult {
  return {
    status: "loaded",
    requested: [],
    capabilities: [],
    loaded: [],
    alreadyActive: [],
    evicted: [],
    missing: [],
    unavailable: [],
    unavailableCapabilities: [],
    omittedOptionalTools: [],
    coverage: [],
    message: "Prepared the control-only workstream routing stage.",
  };
}

export function mountControlOnlyWorkstreamRouteSurface(input: {
  capabilitySurfaceManager?: CapabilitySurfaceManager;
  toolContext: ToolExecutionContext;
}): CapabilitySurfaceResult {
  const evicted = input.capabilitySurfaceManager?.listActive(input.toolContext) ?? [];
  input.capabilitySurfaceManager?.resetRun(input.toolContext);
  return {
    ...createControlOnlyWorkstreamRouteSurface(),
    evicted,
    message: evicted.length > 0
      ? "Entered control-only workstream routing and cleared the observation tool surface."
      : "Entered control-only workstream routing with no executable tools.",
  };
}
