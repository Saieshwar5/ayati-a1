import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFile, writeJsonFileAtomic, backupFile } from "../../../context/loaders/io.js";
import { isSoulContext, type SoulContext } from "../../../context/types.js";
import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const contextDir = resolve(thisDir, "..", "..", "..", "..", "context");
const historyDir = resolve(thisDir, "..", "..", "..", "..", "data", "context-history");

const SOUL_FILE = "soul.json";

interface RenameInput {
  newName: string;
}

function validateInput(input: unknown): RenameInput | ToolResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Invalid input: expected object with newName." };
  }

  const v = input as Partial<RenameInput>;
  if (typeof v.newName !== "string") {
    return { ok: false, error: "Invalid input: newName must be a string." };
  }

  const trimmed = v.newName.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Invalid input: newName must not be empty." };
  }

  if (trimmed.length > 50) {
    return { ok: false, error: "Invalid input: newName must be 50 characters or fewer." };
  }

  return { newName: trimmed };
}

export interface IdentitySkillDeps {
  onSoulUpdated: (updatedSoul: SoulContext) => void;
}

function createRenameTool(deps: IdentitySkillDeps): ToolDefinition {
  return {
    name: "rename_agent",
    description: "Change the agent's display name. Only modifies soul.name in soul.json.",
    inputSchema: {
      type: "object",
      required: ["newName"],
      properties: {
        newName: { type: "string", description: "The new name for the agent (max 50 chars)." },
      },
    },
    async execute(input): Promise<ToolResult> {
      const parsed = validateInput(input);
      if ("ok" in parsed) {
        return parsed;
      }

      const soulPath = resolve(contextDir, SOUL_FILE);
      const raw = await readJsonFile(soulPath, SOUL_FILE);

      if (!isSoulContext(raw)) {
        return { ok: false, error: "soul.json is missing or invalid." };
      }

      await backupFile(soulPath, historyDir, "soul");

      const updated: SoulContext = { ...raw, soul: { ...raw.soul, name: parsed.newName } };
      await writeJsonFileAtomic(soulPath, updated);

      deps.onSoulUpdated(updated);

      return {
        ok: true,
        output: `Name changed to "${parsed.newName}".`,
        meta: { previousName: raw.soul.name ?? "", newName: parsed.newName },
      };
    },
  };
}

const IDENTITY_PROMPT_BLOCK = [
  "Identity Skill is available.",
  "Use rename_agent when a user asks you to change your name.",
  "Only the agent's display name is modified — all other soul properties remain unchanged.",
  "After renaming, immediately use the new name in conversation.",
].join("\n");

export function createIdentitySkill(deps: IdentitySkillDeps): SkillDefinition {
  return {
    id: "identity",
    version: "1.0.0",
    description: "Manage the agent's identity (name).",
    promptBlock: IDENTITY_PROMPT_BLOCK,
    tools: [createRenameTool(deps)],
  };
}
