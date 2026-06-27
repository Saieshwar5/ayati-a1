import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPathSuggestion,
  getPathSuggestions,
} from "../../src/app/path-suggestions.js";

let tempDir: string | null = null;

function createTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "ayati-cli-suggestions-"));
  return tempDir;
}

describe("path suggestions", () => {
  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("completes files and directories for @path input", () => {
    const root = createTempDir();
    writeFileSync(join(root, "report.pdf"), "hello", "utf8");
    mkdirSync(join(root, "reports"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "report-secret.txt"), "noise", "utf8");

    const suggestions = getPathSuggestions("Summarize @./rep", {
      cwd: root,
      homeDir: root,
    });

    expect(suggestions.map((suggestion) => suggestion.name)).toEqual([
      "reports",
      "report.pdf",
    ]);
    expect(suggestions.every((suggestion) => !suggestion.displayPath.includes("node_modules"))).toBe(true);
  });

  it("fuzzy-searches likely roots for bare @query input", () => {
    const root = createTempDir();
    mkdirSync(join(root, "client-files"));
    writeFileSync(join(root, "client-files", "invoice-june.pdf"), "hello", "utf8");

    const suggestions = getPathSuggestions("Read @inv", {
      cwd: root,
      homeDir: root,
      roots: [root],
      maxDepth: 2,
    });

    expect(suggestions.some((suggestion) => suggestion.name === "invoice-june.pdf")).toBe(true);
  });

  it("applies the selected suggestion to the active mention", () => {
    const root = createTempDir();
    mkdirSync(join(root, "docs"));

    const suggestion = getPathSuggestions("Read @./d", {
      cwd: root,
      homeDir: root,
    })[0];

    expect(suggestion).toBeDefined();
    expect(applyPathSuggestion("Read @./d", suggestion!)).toBe(`Read @.${sep}docs${sep}`);
    expect(applyPathSuggestion("Read @./d", suggestion!, { finalizeDirectory: true }))
      .toBe(`Read @.${sep}docs${sep} `);
  });
});
