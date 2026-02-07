/**
 * Color-coded debug logger for development.
 *
 * All calls use a [DEBUG] prefix printed in bright magenta
 * so they stand out in the terminal and are easy to grep & remove:
 *
 *   grep -rn "devLog" src/
 *
 * Remove every devLog call before production builds.
 */

const RESET = "\x1b[0m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

const PREFIX = `${MAGENTA}[DEBUG]${RESET}`;

export function devLog(...args: unknown[]): void {
  console.log(PREFIX, `${CYAN}INFO${RESET}`, ...args);
}

export function devWarn(...args: unknown[]): void {
  console.log(PREFIX, `${YELLOW}WARN${RESET}`, ...args);
}

export function devError(...args: unknown[]): void {
  console.log(PREFIX, `${RED}ERROR${RESET}`, ...args);
}
