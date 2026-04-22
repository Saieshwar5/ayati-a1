import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { advanced, find, help, search, waitForCondition } from "../../../data/skills/agent-browser/adapter.js";

function createContext(commandRun = vi.fn()) {
  return {
    secrets: {
      resolve: vi.fn(),
      inspect: vi.fn(),
    },
    command: {
      run: commandRun,
    },
    http: {
      request: vi.fn(),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

describe("agent-browser adapter", () => {
  it("normalizes search results from the websearch CLI output", async () => {
    const ctx = createContext(vi.fn().mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({
        ok: true,
        data: {
          results: [
            {
              title: "Example Domain",
              url: "https://example.com/",
              snippet: "Example Domain overview.",
            },
            {
              title: "Example Docs",
              link: "https://docs.example.com/start",
              description: "Official documentation.",
            },
          ],
        },
      }),
      stderr: "",
      exitCode: 0,
    }));

    const result = await search(ctx, {
      input: {
        query: "example domain",
        site: "example.com",
        limit: 2,
      },
    });

    expect(result.ok).toBe(true);
    expect(ctx.command.run).toHaveBeenCalledWith({
      command: "websearch",
      args: ["example domain", "--limit", "2", "--json-pretty", "--site", "example.com"],
      timeoutMs: 15000,
    });

    const parsed = JSON.parse(result.output ?? "{}") as {
      query: string;
      results: Array<{ title: string; url: string; domain: string; snippet: string }>;
    };
    expect(parsed.query).toBe("example domain");
    expect(parsed.results).toEqual([
      {
        title: "Example Domain",
        url: "https://example.com/",
        domain: "example.com",
        snippet: "Example Domain overview.",
      },
      {
        title: "Example Docs",
        url: "https://docs.example.com/start",
        domain: "docs.example.com",
        snippet: "Official documentation.",
      },
    ]);
  });

  it("loads focused help from the installed local core skill docs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ayati-agent-browser-help-"));
    const referencesDir = join(tempDir, "references");
    mkdirSync(referencesDir, { recursive: true });
    writeFileSync(
      join(referencesDir, "snapshot-refs.md"),
      [
        "# Snapshot Refs",
        "Use @eN refs from `agent-browser snapshot -i`.",
      ].join("\n"),
    );

    try {
      const ctx = createContext(vi.fn().mockImplementation(async (input) => {
        if (input.command === "agent-browser" && JSON.stringify(input.args) === JSON.stringify(["skills", "path", "core"])) {
          return { ok: true, stdout: `${tempDir}\n`, stderr: "", exitCode: 0 };
        }
        throw new Error(`Unexpected command: ${input.command} ${JSON.stringify(input.args ?? [])}`);
      }));

      const result = await help(ctx, {
        input: {
          topic: "snapshot_refs",
        },
      });

      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.output ?? "{}") as { sources: string[]; content: string };
      expect(parsed.sources).toEqual(["references/snapshot-refs.md"]);
      expect(parsed.content).toContain("agent-browser snapshot -i");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("builds find commands for nth locators and parses JSON output", async () => {
    const ctx = createContext(vi.fn().mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ matched: true, target: "@e7" }),
      stderr: "",
      exitCode: 0,
    }));

    const result = await find(ctx, {
      input: {
        session: "docs",
        locator: "nth",
        index: 2,
        selector: ".card",
        action: "hover",
        json: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(ctx.command.run).toHaveBeenCalledWith({
      command: "agent-browser",
      args: ["--session", "docs", "--json", "find", "nth", "2", ".card", "hover"],
      timeoutMs: 30000,
    });

    const parsed = JSON.parse(result.output ?? "{}") as { matched: boolean; target: string };
    expect(parsed).toEqual({ matched: true, target: "@e7" });
  });

  it("validates wait mode selection and builds wait commands", async () => {
    const invalid = await waitForCondition(createContext(), {
      input: {
        ms: 1000,
        text: "done",
      },
    });

    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain("wait requires exactly one mode");

    const ctx = createContext(vi.fn().mockResolvedValue({
      ok: true,
      stdout: "waited",
      stderr: "",
      exitCode: 0,
    }));
    const valid = await waitForCondition(ctx, {
      input: {
        session: "docs",
        loadState: "networkidle",
      },
    });

    expect(valid.ok).toBe(true);
    expect(ctx.command.run).toHaveBeenCalledWith({
      command: "agent-browser",
      args: ["--session", "docs", "wait", "--load", "networkidle"],
      timeoutMs: 30000,
    });
  });

  it("dispatches validated advanced commands and rejects unsupported options", async () => {
    const ctx = createContext(vi.fn().mockResolvedValue({
      ok: true,
      stdout: JSON.stringify({ requests: [] }),
      stderr: "",
      exitCode: 0,
    }));

    const result = await advanced(ctx, {
      input: {
        session: "research",
        group: "network",
        command: "requests",
        options: {
          filter: "api",
          method: "POST",
        },
        json: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(ctx.command.run).toHaveBeenCalledWith({
      command: "agent-browser",
      args: ["--session", "research", "--json", "network", "requests", "--filter", "api", "--method", "POST"],
      timeoutMs: 30000,
    });

    const invalid = await advanced(createContext(), {
      input: {
        group: "network",
        command: "requests",
        options: {
          bogus: true,
        },
      },
    });

    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain("Unsupported option keys: bogus");
    expect(invalid.output).toContain("Use agent-browser.help before agent-browser.advanced");
  });
});
