import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoulContext } from "../../src/context/types.js";

const VALID_SOUL: SoulContext = {
  version: 2,
  soul: { name: "Ayati", identity: "test identity", personality: ["curious"], values: ["honesty"] },
  voice: { tone: ["warm"], style: ["casual"], quirks: ["says okay so"], never_do: ["never be rude"] },
};

let tmpDir: string;
let soulPath: string;
let historyDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "identity-test-"));
  soulPath = join(tmpDir, "soul.json");
  historyDir = join(tmpDir, "history");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

async function buildTool(overrides?: { onSoulUpdated?: (s: SoulContext) => void }) {
  const io = await import("../../src/context/loaders/io.js");
  const types = await import("../../src/context/types.js");

  const renameTool = {
    name: "rename_agent",
    description: "Change the agent's display name.",
    inputSchema: {
      type: "object",
      required: ["newName"],
      properties: { newName: { type: "string" } },
    },
    async execute(input: unknown) {
      if (!input || typeof input !== "object") {
        return { ok: false, error: "Invalid input: expected object with newName." };
      }
      const v = input as { newName?: unknown };
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

      const raw = await io.readJsonFile(soulPath, "soul.json");
      if (!types.isSoulContext(raw)) {
        return { ok: false, error: "soul.json is missing or invalid." };
      }

      await io.backupFile(soulPath, historyDir, "soul");

      const updated: SoulContext = { ...raw, soul: { ...raw.soul, name: trimmed } };
      await io.writeJsonFileAtomic(soulPath, updated);

      overrides?.onSoulUpdated?.(updated);

      return {
        ok: true,
        output: `Name changed to "${trimmed}".`,
        meta: { previousName: raw.soul.name ?? "", newName: trimmed },
      };
    },
  };

  return renameTool;
}

describe("rename_agent tool", () => {
  describe("input validation", () => {
    it("rejects null input", async () => {
      const tool = await buildTool();
      const result = await tool.execute(null);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("expected object");
    });

    it("rejects non-string newName", async () => {
      const tool = await buildTool();
      const result = await tool.execute({ newName: 123 });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("must be a string");
    });

    it("rejects empty string", async () => {
      const tool = await buildTool();
      const result = await tool.execute({ newName: "" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("must not be empty");
    });

    it("rejects whitespace-only string", async () => {
      const tool = await buildTool();
      const result = await tool.execute({ newName: "   " });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("must not be empty");
    });

    it("rejects names longer than 50 characters", async () => {
      const tool = await buildTool();
      const result = await tool.execute({ newName: "A".repeat(51) });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("50 characters");
    });
  });

  describe("happy path", () => {
    it("renames the agent on disk", async () => {
      await writeFile(soulPath, JSON.stringify(VALID_SOUL));
      const tool = await buildTool();

      const result = await tool.execute({ newName: "Nova" });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("Nova");

      const ondisk = JSON.parse(await readFile(soulPath, "utf-8")) as SoulContext;
      expect(ondisk.soul.name).toBe("Nova");
    });

    it("preserves all other soul fields", async () => {
      await writeFile(soulPath, JSON.stringify(VALID_SOUL));
      const tool = await buildTool();

      await tool.execute({ newName: "Nova" });

      const ondisk = JSON.parse(await readFile(soulPath, "utf-8")) as SoulContext;
      expect(ondisk.version).toBe(VALID_SOUL.version);
      expect(ondisk.soul.identity).toBe(VALID_SOUL.soul.identity);
      expect(ondisk.soul.personality).toEqual(VALID_SOUL.soul.personality);
      expect(ondisk.soul.values).toEqual(VALID_SOUL.soul.values);
      expect(ondisk.voice).toEqual(VALID_SOUL.voice);
    });

    it("trims whitespace from the name", async () => {
      await writeFile(soulPath, JSON.stringify(VALID_SOUL));
      const tool = await buildTool();

      const result = await tool.execute({ newName: "  Nova  " });

      expect(result.ok).toBe(true);
      const ondisk = JSON.parse(await readFile(soulPath, "utf-8")) as SoulContext;
      expect(ondisk.soul.name).toBe("Nova");
    });
  });

  describe("callback", () => {
    it("fires onSoulUpdated with the full updated SoulContext", async () => {
      await writeFile(soulPath, JSON.stringify(VALID_SOUL));
      const callback = vi.fn();
      const tool = await buildTool({ onSoulUpdated: callback });

      await tool.execute({ newName: "Nova" });

      expect(callback).toHaveBeenCalledOnce();
      const arg = callback.mock.calls[0]![0] as SoulContext;
      expect(arg.soul.name).toBe("Nova");
      expect(arg.soul.identity).toBe(VALID_SOUL.soul.identity);
      expect(arg.voice).toEqual(VALID_SOUL.voice);
    });
  });

  describe("backup", () => {
    it("creates a backup before overwriting", async () => {
      await writeFile(soulPath, JSON.stringify(VALID_SOUL));
      const tool = await buildTool();

      await tool.execute({ newName: "Nova" });

      const { readdir } = await import("node:fs/promises");
      const files = await readdir(historyDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/^soul_.*\.json$/);
    });
  });

  describe("error cases", () => {
    it("returns error when soul.json is missing", async () => {
      const tool = await buildTool();
      const result = await tool.execute({ newName: "Nova" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("missing or invalid");
    });

    it("returns error when soul.json has malformed JSON", async () => {
      await writeFile(soulPath, "not json at all");
      const tool = await buildTool();
      const result = await tool.execute({ newName: "Nova" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("missing or invalid");
    });
  });
});

describe("identity skill metadata", () => {
  it("has correct id, version, and tool count", async () => {
    const { createIdentitySkill } = await import("../../src/skills/builtins/identity/index.js");
    const skill = createIdentitySkill({ onSoulUpdated: () => {} });

    expect(skill.id).toBe("identity");
    expect(skill.version).toBe("1.0.0");
    expect(skill.tools).toHaveLength(1);
    expect(skill.tools[0]!.name).toBe("rename_agent");
  });

  it("has a non-empty promptBlock", async () => {
    const { createIdentitySkill } = await import("../../src/skills/builtins/identity/index.js");
    const skill = createIdentitySkill({ onSoulUpdated: () => {} });

    expect(skill.promptBlock.length).toBeGreaterThan(0);
    expect(skill.promptBlock).toContain("rename_agent");
  });
});
