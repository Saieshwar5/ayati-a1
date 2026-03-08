import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanExternalSkills, stopExternalSkills } from "../../../src/skills/external/scanner.js";
import type { ExternalSkillMeta } from "../../../src/skills/external/types.js";

// Mock child_process.exec to avoid real shell commands in tests
vi.mock("node:child_process", () => ({
  exec: vi.fn((cmd: string, _opts: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    // If called with promisify pattern (no callback), return an object with stdout/stderr
    if (!cb) {
      // promisify wraps exec, so we need to handle the callback pattern
      return undefined;
    }
    cb(null, { stdout: "", stderr: "" });
    return undefined;
  }),
}));

// Re-mock using promisify-compatible pattern
vi.mock("node:util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:util")>();
  return {
    ...actual,
    promisify: (fn: unknown) => {
      // Return a function that always resolves for exec
      return async (_cmd: string, _opts?: unknown) => {
        return { stdout: "", stderr: "" };
      };
    },
  };
});

describe("scanExternalSkills", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ayati-skills-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when directory does not exist", async () => {
    const result = await scanExternalSkills(join(tmpDir, "nonexistent"));
    expect(result).toEqual([]);
  });

  it("returns empty array when directory is empty", async () => {
    const result = await scanExternalSkills(tmpDir);
    expect(result).toEqual([]);
  });

  it("scans a valid skill.md and returns meta", async () => {
    const skillDir = join(tmpDir, "test-skill");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "skill.md"),
      `---
id: test-skill
description: A test skill for unit tests
start: echo started
stop: echo stopped
---

# test-skill
Full documentation here.
`,
    );

    const result = await scanExternalSkills(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("test-skill");
    expect(result[0]?.description).toBe("A test skill for unit tests");
    expect(result[0]?.installed).toBe(true);
    expect(result[0]?.start).toBe("echo started");
    expect(result[0]?.stop).toBe("echo stopped");
    expect(result[0]?.skillFilePath).toBe(join(skillDir, "skill.md"));
    expect(result[0]?.skillDir).toBe(skillDir);
  });

  it("skips directories without skill.md", async () => {
    mkdirSync(join(tmpDir, "empty-dir"));
    const result = await scanExternalSkills(tmpDir);
    expect(result).toEqual([]);
  });

  it("skips skills missing id or description", async () => {
    const skillDir = join(tmpDir, "bad-skill");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "skill.md"),
      `---
id: bad-skill
---

Missing description.
`,
    );

    const result = await scanExternalSkills(tmpDir);
    expect(result).toEqual([]);
  });

  it("parses dependency frontmatter with nested keys", async () => {
    const skillDir = join(tmpDir, "dep-skill");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "skill.md"),
      `---
id: dep-skill
description: Skill with dependency
dependency:
  check: dep-cli --version
  install: npm install -g dep-cli
---

# dep-skill
Docs here.
`,
    );

    const result = await scanExternalSkills(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("dep-skill");
    expect(result[0]?.installed).toBe(true);
  });

  it("scans multiple skills", async () => {
    for (const name of ["alpha", "beta"]) {
      const dir = join(tmpDir, name);
      mkdirSync(dir);
      writeFileSync(
        join(dir, "skill.md"),
        `---
id: ${name}
description: ${name} skill
---
`,
      );
    }

    const result = await scanExternalSkills(tmpDir);
    expect(result).toHaveLength(2);
    const ids = result.map((s) => s.id).sort();
    expect(ids).toEqual(["alpha", "beta"]);
  });
});

describe("stopExternalSkills", () => {
  it("handles skills without stop commands gracefully", async () => {
    const skills: ExternalSkillMeta[] = [
      {
        id: "no-stop",
        description: "no stop command",
        skillFilePath: "/tmp/skill.md",
        skillDir: "/tmp",
        installed: true,
      },
    ];

    // Should not throw
    await stopExternalSkills(skills);
  });
});
