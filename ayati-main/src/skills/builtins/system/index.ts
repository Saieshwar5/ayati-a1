import type { SkillDefinition } from "../../types.js";
import {
  createSystemHealthTool,
  type SystemHealthRawSample,
} from "./system-health.js";
import { createSystemTimeTool } from "./system-time.js";

export interface SystemSkillOptions {
  defaultTimezone: string;
  healthRoot: string;
  now?: () => Date;
  healthSample?: (
    healthRoot: string,
  ) => Promise<SystemHealthRawSample>;
}

export function createSystemSkill(
  options: SystemSkillOptions,
): SkillDefinition {
  return {
    id: "system",
    version: "1.0.0",
    description:
      "Fresh, bounded observations of local time and machine health.",
    tools: [
      createSystemTimeTool({
        defaultTimezone: options.defaultTimezone,
        ...(options.now ? { now: options.now } : {}),
      }),
      createSystemHealthTool({
        healthRoot: options.healthRoot,
        ...(options.healthSample ? { sample: options.healthSample } : {}),
      }),
    ],
  };
}

export {
  createSystemHealthTool,
  createSystemTimeTool,
};
export type {
  SystemHealthRawSample,
  SystemHealthToolOptions,
} from "./system-health.js";
export type { SystemTimeToolOptions } from "./system-time.js";
