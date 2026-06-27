import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(testDir, "../../src");

describe("architecture boundaries", () => {
  it("keeps app, server, and harness code behind context-engine public contracts", async () => {
    const files = await listTypeScriptFiles(srcRoot);
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const sourcePath = normalizePath(relative(srcRoot, file));
      const imports = extractStaticImports(source)
        .filter((specifier) => specifier.startsWith("."))
        .map((specifier) => normalizeImportTarget(file, specifier));

      for (const target of imports) {
        if (sourcePath.startsWith("ivec/") || sourcePath.startsWith("app/")) {
          if (target.startsWith("context-engine/daily-session/") || target.startsWith("context-server/daily-session/")) {
            violations.push(`${sourcePath} imports daily-session internals through ${target}`);
          }
        }

        if (sourcePath.startsWith("server/")) {
          if (target.startsWith("ivec/agent-runner/") || target.startsWith("context-engine/daily-session/")) {
            violations.push(`${sourcePath} imports runtime internals through ${target}`);
          }
        }

        if (sourcePath.startsWith("context-engine/") && target.startsWith("server/")) {
          violations.push(`${sourcePath} imports server code through ${target}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nestedFiles = await listTypeScriptFiles(path);
      files.push(...nestedFiles);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function extractStaticImports(source: string): string[] {
  const imports: string[] = [];
  const importPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(source)) !== null) {
    imports.push(match[1] ?? "");
  }
  return imports;
}

function normalizeImportTarget(sourceFile: string, specifier: string): string {
  const withoutExtension = specifier.replace(/\.(?:js|ts)$/, "");
  const absoluteTarget = join(dirname(sourceFile), withoutExtension);
  return normalizePath(relative(srcRoot, absoluteTarget));
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}
