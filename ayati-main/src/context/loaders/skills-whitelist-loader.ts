import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devWarn } from "../../shared/index.js";
import { readJsonFile } from "./io.js";

const SKILLS_WHITELIST_FILE = "skills_whitelist.json";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export async function loadSkillsWhitelist(): Promise<string[]> {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const contextDir = resolve(thisDir, "..", "..", "..", "context");
  const filePath = resolve(contextDir, SKILLS_WHITELIST_FILE);

  const raw = await readJsonFile(filePath, SKILLS_WHITELIST_FILE);
  if (isStringArray(raw)) {
    return raw;
  }

  if (raw !== undefined) {
    devWarn("Skills whitelist invalid. Using empty whitelist.");
  }
  return [];
}
