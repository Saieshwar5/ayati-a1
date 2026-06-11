import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readText(path: string): Promise<string> {
  return await readFile(path, "utf-8");
}

export function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return sha256Text(await readText(path));
}

