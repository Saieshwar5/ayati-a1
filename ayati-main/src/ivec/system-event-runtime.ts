import type { AyatiSystemEvent } from "../core/contracts/plugin.js";

export interface SystemEventRuntimeInput {
  clientId: string;
  event: AyatiSystemEvent;
}

export interface SystemEventRuntime {
  processSystemEvent(input: SystemEventRuntimeInput): Promise<void>;
}
