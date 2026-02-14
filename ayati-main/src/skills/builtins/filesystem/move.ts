import { rename, copyFile, cp, stat, rm, access } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { validateMoveInput } from "./validators.js";

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
    },
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateMoveInput(input);
    if ("ok" in parsed) return parsed;

    const src = resolve(parsed.source);
    const dest = resolve(parsed.destination);
    const start = Date.now();

    try {
      if (!parsed.overwrite && (await exists(dest))) {
        return {
          ok: false,
          error: "Destination already exists. Set overwrite=true to replace.",
          meta: { durationMs: Date.now() - start, source: src, destination: dest },
        };
      }

      try {
        await rename(src, dest);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EXDEV") throw err;

        const info = await stat(src);
        if (info.isDirectory()) {
          await cp(src, dest, { recursive: true, force: parsed.overwrite ?? false });
        } else {
          await copyFile(src, dest);
        }
        await rm(src, { recursive: true, force: true });
      }

      return {
        ok: true,
        output: `Moved ${src} → ${dest}`,
        meta: { durationMs: Date.now() - start, source: src, destination: dest },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown filesystem error";
      return { ok: false, error: message, meta: { durationMs: Date.now() - start } };
    }
  },
};
