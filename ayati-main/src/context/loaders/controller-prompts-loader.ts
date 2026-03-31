import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devWarn } from "../../shared/index.js";
import type { ControllerPrompts } from "../types.js";
import { readTextFile } from "./io.js";

const CONTROLLER_DIR = "controller";
const UNDERSTAND_FILE = "understand.md";
const DIRECT_FILE = "direct.md";
const REEVAL_FILE = "reeval.md";
const SYSTEM_EVENT_FILE = "system-event.md";

function resolveContextDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, "..", "..", "..", "context", CONTROLLER_DIR);
}

async function loadPromptFile(fileName: string): Promise<string> {
  const filePath = resolve(resolveContextDir(), fileName);
  const contextLabel = `${CONTROLLER_DIR}/${fileName}`;
  const raw = await readTextFile(filePath, contextLabel);
  const trimmed = raw?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }

  devWarn(`Controller prompt missing or empty. Using built-in fallback for: ${contextLabel}`);
  return "";
}

export async function loadControllerPrompts(): Promise<ControllerPrompts> {
  const [understand, direct, reeval, systemEvent] = await Promise.all([
    loadPromptFile(UNDERSTAND_FILE),
    loadPromptFile(DIRECT_FILE),
    loadPromptFile(REEVAL_FILE),
    loadPromptFile(SYSTEM_EVENT_FILE),
  ]);

  return {
    understand,
    direct,
    reeval,
    systemEvent,
  };
}
