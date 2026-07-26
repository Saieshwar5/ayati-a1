import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { ContextEngineServiceError } from "../errors.js";

/**
 * Validate a host-filesystem locator without ever anchoring it to the daemon's
 * current working directory.
 */
export function requireAbsoluteFilesystemPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  const containsUnsafeControlCharacter = /[\u0000-\u001f\u007f]/.test(trimmed);
  if (
    trimmed.length === 0
    || containsUnsafeControlCharacter
    || trimmed === "~"
    || trimmed.startsWith("~/")
    || trimmed.startsWith("~\\")
    || /^file:/i.test(trimmed)
    || !isAbsolute(trimmed)
  ) {
    throw new ContextEngineServiceError({
      code: "RESOURCE_LOCATOR_INVALID",
      message: "Filesystem resource locators must be absolute paths; relative paths, ~ paths, and file URIs are not accepted.",
      details: { path: pathValue },
    });
  }
  return resolve(trimmed);
}

/**
 * Canonicalize a missing future path through its nearest existing ancestor.
 * Existing locators are inspected for a symbolic link before this is called.
 */
export async function canonicalizeMissingFilesystemPath(pathValue: string): Promise<string> {
  const absolutePath = requireAbsoluteFilesystemPath(pathValue);
  const suffix: string[] = [];
  let current = absolutePath;
  while (true) {
    try {
      const existing = await realpath(current);
      return resolve(existing, ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return absolutePath;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}
