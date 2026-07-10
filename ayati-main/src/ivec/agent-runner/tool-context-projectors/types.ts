import type {
  PromptRunToolCallContext,
  PromptRunToolCallMode,
} from "../run-tool-call-context.js";

export type PressureProjectionMode = Extract<PromptRunToolCallMode, "preview" | "summary">;

export interface ToolContextProjection {
  projectorId: string;
  call: PromptRunToolCallContext;
}

export interface ToolContextProjector {
  id: string;
  supports(call: PromptRunToolCallContext): boolean;
  project(call: PromptRunToolCallContext, mode: PressureProjectionMode): ToolContextProjection;
}
