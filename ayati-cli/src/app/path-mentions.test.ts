import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findPathMentions,
  replacePathMentionsWithResolvedPaths,
  resolvePathMentions,
  stripPathMentions,
} from "./path-mentions.js";

let tempDir: string | null = null;

function createTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "ayati-cli-paths-"));
  return tempDir;
}

describe("path mentions", () => {
  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("finds unquoted and quoted @path mentions", () => {
    const mentions = findPathMentions("Compare @./report.pdf with @\"./Job Description.pdf\"");

    expect(mentions.map((mention) => mention.pathText)).toEqual([
      "./report.pdf",
      "./Job Description.pdf",
    ]);
  });

  it("ignores email addresses", () => {
    expect(findPathMentions("send it to sai@example.com")).toEqual([]);
  });

  it("resolves files and directories from the local machine", () => {
    const root = createTempDir();
    const filePath = join(root, "report.pdf");
    const docsPath = join(root, "docs");
    writeFileSync(filePath, "hello", "utf8");
    mkdirSync(docsPath);

    const result = resolvePathMentions("Read @./report.pdf and @./docs", { cwd: root });

    expect(result.missing).toEqual([]);
    expect(result.resolved.map((entry) => ({
      path: entry.attachment.path,
      kind: entry.attachment.kind,
      name: entry.attachment.name,
    }))).toEqual([
      { path: filePath, kind: "file", name: "report.pdf" },
      { path: docsPath, kind: "directory", name: "docs" },
    ]);
  });

  it("separates message text from attachment-only input", () => {
    expect(stripPathMentions("@./report.pdf @./docs")).toBe("");
    expect(stripPathMentions("Summarize @./report.pdf")).toBe("Summarize");
  });

  it("replaces mentions with resolved absolute paths for server content", () => {
    const root = createTempDir();
    const filePath = join(root, "report.pdf");
    writeFileSync(filePath, "hello", "utf8");

    const result = resolvePathMentions("Summarize @./report.pdf", { cwd: root });

    expect(replacePathMentionsWithResolvedPaths("Summarize @./report.pdf", result.resolved))
      .toBe(`Summarize ${filePath}`);
  });
});
