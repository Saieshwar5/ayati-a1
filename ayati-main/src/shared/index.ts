export function createId(): string {
  return crypto.randomUUID();
}

export { devLog, devWarn, devError } from "./debug-log.js";
