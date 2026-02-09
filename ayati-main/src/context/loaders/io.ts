import { readFile, writeFile, rename, copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { devWarn } from "../../shared/index.js";

export async function readTextFile(filePath: string, fileName: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    devWarn(`Context file not found or unreadable, skipping: ${fileName}`);
    return undefined;
  }
}

export async function readJsonFile(filePath: string, fileName: string): Promise<unknown | undefined> {
  const raw = await readTextFile(filePath, fileName);
  if (raw === undefined) return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    devWarn(`Context file has invalid JSON, skipping: ${fileName}`);
    return undefined;
  }
}

export async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await rename(tmpPath, filePath);
}

export async function backupFile(
  sourcePath: string,
  historyDir: string,
  baseName: string,
): Promise<string> {
  await mkdir(historyDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destPath = resolve(historyDir, `${baseName}_${timestamp}.json`);
  await copyFile(sourcePath, destPath);
  return destPath;
}
