import { readFile } from "node:fs/promises";
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
