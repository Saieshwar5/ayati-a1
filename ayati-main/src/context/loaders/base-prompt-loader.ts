import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devWarn } from "../../shared/index.js";
import { readTextFile } from "./io.js";

const SYSTEM_PROMPT_FILE = "system_prompt.md";
const DEFAULT_BASE_PROMPT =
  "Be clear, honest, concise, and never fabricate details.";

export async function loadBasePrompt(): Promise<string> {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const contextDir = resolve(thisDir, "..", "..", "..", "context");
  const filePath = resolve(contextDir, SYSTEM_PROMPT_FILE);

  const raw = await readTextFile(filePath, SYSTEM_PROMPT_FILE);
  const trimmed = raw?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }

  devWarn("Base system prompt missing or empty. Using fallback base prompt.");
  return DEFAULT_BASE_PROMPT;
}
