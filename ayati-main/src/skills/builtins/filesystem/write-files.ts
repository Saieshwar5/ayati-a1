import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { ToolDefinition, ToolResult } from "../../types.js";
import { resolveWorkspacePath } from "../../workspace-paths.js";
import { validateWriteFilesInput } from "./validators.js";

interface PreparedWrite {
  requestedPath: string;
  filePath: string;
  tempPath: string;
  content: string;
}

export const writeFilesTool: ToolDefinition = {
  name: "write_files",
  description: "Write or overwrite multiple files as one serialized batch. Validates all paths first, writes temp files, then renames them into place.",
  inputSchema: {
    type: "object",
    required: ["files"],
    properties: {
      files: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string", description: "Absolute or relative file path." },
            content: { type: "string", description: "Content to write." },
          },
          additionalProperties: false,
        },
      },
      createDirs: {
        type: "boolean",
        description: "Create parent directories if they don't exist (default: false).",
      },
    },
    additionalProperties: false,
  },
  selectionHints: {
    tags: ["filesystem", "write", "create", "file", "batch"],
    aliases: ["save_files", "overwrite_files", "batch_write_files"],
    examples: ["write multiple generated files", "save view.html and script.js together"],
    domain: "filesystem",
    priority: 4,
  },
  async execute(input): Promise<ToolResult> {
    const parsed = validateWriteFilesInput(input);
    if ("ok" in parsed) return parsed;

    const start = Date.now();
    const prepared: PreparedWrite[] = [];
    const seenPaths = new Set<string>();

    for (const file of parsed.files) {
      const filePath = resolveWorkspacePath(file.path);
      if (seenPaths.has(filePath)) {
        return {
          ok: false,
          error: `Duplicate target path in batch: ${filePath}`,
          meta: { durationMs: Date.now() - start, filePath },
        };
      }
      seenPaths.add(filePath);
      prepared.push({
        requestedPath: file.path,
        filePath,
        tempPath: buildTempPath(filePath),
        content: file.content,
      });
    }

    const tempPaths: string[] = [];
    const moved: Array<{ requestedPath: string; filePath: string; bytesWritten: number }> = [];

    try {
      const parentDirs = [...new Set(prepared.map((file) => dirname(file.filePath)))];
      if (parsed.createDirs) {
        for (const dir of parentDirs) {
          await mkdir(dir, { recursive: true });
        }
      }

      for (const file of prepared) {
        await writeFile(file.tempPath, file.content, "utf-8");
        tempPaths.push(file.tempPath);
      }

      for (const file of prepared) {
        await rename(file.tempPath, file.filePath);
        moved.push({
          requestedPath: file.requestedPath,
          filePath: file.filePath,
          bytesWritten: Buffer.byteLength(file.content, "utf-8"),
        });
      }

      const totalBytes = moved.reduce((sum, file) => sum + file.bytesWritten, 0);
      return {
        ok: true,
        output: JSON.stringify({
          filesWritten: moved.length,
          totalBytes,
          files: moved,
        }, null, 2),
        meta: {
          durationMs: Date.now() - start,
          filesWritten: moved.length,
          totalBytes,
          files: moved,
        },
      };
    } catch (err) {
      await Promise.all(
        tempPaths.map((path) => rm(path, { force: true }).catch(() => undefined)),
      );
      const message = err instanceof Error ? err.message : "Unknown filesystem batch write error";
      return {
        ok: false,
        error: moved.length > 0
          ? `${message} (${moved.length}/${prepared.length} files were already moved into place)`
          : message,
        meta: {
          durationMs: Date.now() - start,
          filesRequested: prepared.length,
          filesWritten: moved.length,
          partial: moved.length > 0,
          files: moved,
        },
      };
    }
  },
};

function buildTempPath(filePath: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
}
