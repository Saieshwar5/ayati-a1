import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devWarn } from "../../shared/index.js";
import { emptySoulContext, isSoulContext, type SoulContext } from "../types.js";
import { readJsonFile } from "./io.js";

const SOUL_FILE = "soul.json";

export async function loadSoulContext(): Promise<SoulContext> {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const contextDir = resolve(thisDir, "..", "..", "..", "context");
  const filePath = resolve(contextDir, SOUL_FILE);

  const raw = await readJsonFile(filePath, SOUL_FILE);
  if (isSoulContext(raw)) {
    return raw;
  }

  devWarn("Soul context missing or invalid. Using empty soul context.");
  return emptySoulContext();
}
