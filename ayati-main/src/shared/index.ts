export function createId(): string {
  return crypto.randomUUID();
}

export {
  agentTrace,
  devError,
  devLog,
  devWarn,
  isAgentTraceEnabled,
  isAgentTracePromptEnabled,
  tracePreview,
} from "./debug-log.js";
