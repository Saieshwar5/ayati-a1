import { rename, copyFile, cp, stat, rm, access } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { validateMoveInput } from "./validators.js";
import { enforceFilesystemGuard } from "../../guardrails/index.js";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export const moveTool: ToolDefinition = {
  name: "move",
  description: "Move or rename a file or directory. Falls back to copy+delete for cross-device moves.",
  inputSchema: {
    type: "object",
    required: ["source", "destination"],
    properties: {
      source: { type: "string", description: "Source path." },
      destination: { type: "string", description: "Destination path." },
      overwrite: {
        type: "boolean",
        description: "Overwrite destination if it exists (default: false).",
      },
      confirmationToken: {
        type: "string",
        description: "Required confirmation token in format CONFIRM:<operation_id> for guarded moves.",
      },
    },
  },
  selectionHints: {
    tags: ["filesystem", "move", "rename"],
    aliases: ["mv", "rename_path"],
    examples: ["move file", "rename directory"],
    domain: "filesystem",
    priority: 2,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateMoveInput(input);
    if ("ok" in parsed) return parsed;

    const src = resolve(parsed.source);
    const dest = resolve(parsed.destination);
    const guard = await enforceFilesystemGuard({
      action: "move",
      path: dest,
      sourcePath: src,
      overwrite: parsed.overwrite,
      confirmationToken: parsed.confirmationToken,
    });
    if (!guard.ok) return guard.result;
    const guardedSrc = guard.resolvedSourcePath ?? src;
    const guardedDest = guard.resolvedPath;
    const start = Date.now();

    try {
      if (!parsed.overwrite && (await exists(guardedDest))) {
        return {
          ok: false,
          error: "Destination already exists. Set overwrite=true to replace.",
          meta: { durationMs: Date.now() - start, source: guardedSrc, destination: guardedDest },
        };
      }

      try {
        await rename(guardedSrc, guardedDest);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EXDEV") throw err;

        const info = await stat(guardedSrc);
        if (info.isDirectory()) {
          await cp(guardedSrc, guardedDest, { recursive: true, force: parsed.overwrite ?? false });
        } else {
          await copyFile(guardedSrc, guardedDest);
        }
        await rm(guardedSrc, { recursive: true, force: true });
      }

      return {
        ok: true,
        output: `Moved ${guardedSrc} → ${guardedDest}`,
        meta: { durationMs: Date.now() - start, source: guardedSrc, destination: guardedDest },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown filesystem error";
      return { ok: false, error: message, meta: { durationMs: Date.now() - start } };
    }
  },
};
