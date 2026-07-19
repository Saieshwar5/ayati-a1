import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionRef } from "../src/contracts.js";
import { SessionSummaryHotCache } from "../src/services/session-summary-hot-cache.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("session summary hot cache", () => {
  it("keeps five detailed commits and compacts older workstream-bound-run commits", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "ayati-session-summary-"));
    directories.push(repositoryPath);
    await git(repositoryPath, ["init", "--initial-branch=main"]);
    await git(repositoryPath, ["config", "user.name", "Ayati Test"]);
    await git(repositoryPath, ["config", "user.email", "test@ayati.local"]);
    await git(repositoryPath, ["commit", "--allow-empty", "-m", [
      "session: initialize S-20260712-local",
      "",
      "Ayati-Event: session_initialized",
    ].join("\n")]);
    for (let index = 1; index <= 6; index += 1) {
      await git(repositoryPath, ["commit", "--allow-empty", "-m", commitMessage(index)]);
    }
    const head = await git(repositoryPath, ["rev-parse", "HEAD"]);
    const session: SessionRef = {
      sessionId: "S-20260712-local",
      repositoryPath,
      head,
      date: "2026-07-12",
      timezone: "Asia/Kolkata",
      status: "open",
    };

    const firstCache = new SessionSummaryHotCache();
    const first = await firstCache.refresh(session);
    const restarted = await new SessionSummaryHotCache().refresh(session);

    expect(first.recentCommits).toHaveLength(5);
    expect(first.recentCommits[0]).toMatchObject({
      subject: "session: complete workstream work 6",
      conversationSummary: "Conversation summary 6.",
      workSummary: "Complete workstream work 6.",
      outcome: "done",
      validation: "passed",
      workstreamId: "T-20260712-0006",
      runId: "R-20260712-0006",
      assets: [{ path: "file-6.txt", description: "Asset 6" }],
    });
    expect(first.recentCommits[0]?.message).toContain("Assets:\n- file-6.txt — Asset 6");
    expect(first.summary).toContain("Complete workstream work 1.");
    expect(first.summary).not.toContain("Complete workstream work 2.");
    expect(restarted).toEqual(first);
  });
});

function commitMessage(index: number): string {
  const suffix = String(index).padStart(4, "0");
  return [
    "session: complete workstream work " + index,
    "",
    "Conversation:",
    "Conversation summary " + index + ".",
    "",
    "Workstream work:",
    "Complete workstream work " + index + ".",
    "",
    "Assets:",
    "- file-" + index + ".txt — Asset " + index,
    "",
    "Session-Id: S-20260712-local",
    "Conversation-Id: S-20260712-local-C-" + suffix,
    "Workstream-Id: T-20260712-" + suffix,
    "Workstream-Before: " + "a".repeat(40),
    "Workstream-After: " + "b".repeat(40),
    "Run: R-20260712-" + suffix,
    "Outcome: done",
    "Validation: passed",
    "Ayati-Event: workstream_bound_run_committed",
  ].join("\n");
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: repositoryPath, encoding: "utf8" });
  return result.stdout.trim();
}
