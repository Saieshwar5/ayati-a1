import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { validateWorkstreamRepository } from "../src/workstreams/workstream-repository-validator.js";
import {
  createBoundWorkstream,
  createWorkstreamServiceFixture,
  materializeBoundWorkstream,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const execFileAsync = promisify(execFile);
const fixtures: WorkstreamServiceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("workstream context repository validation", () => {
  it("accepts only the card, progress, requests, and resource ledger as committed context", async () => {
    const fixture = await createWorkstreamServiceFixture("validate-ready");
    fixtures.push(fixture);
    const selected = await createBoundWorkstream(fixture);
    const finalized = await materializeBoundWorkstream(fixture);
    if (finalized.workstreamContextCommit.status === "not_required") {
      throw new Error("Expected the workstream notebook to be committed.");
    }

    const validation = await validateWorkstreamRepository({
      workstreamRoot: `${fixture.root}/workstreams`,
      contextRepositoryPath: selected.workstream.contextRepositoryPath,
      expectedWorkstreamId: selected.workstream.workstreamId,
      requestReadMode: "all",
    });

    expect(validation).toMatchObject({
      workstreamId: selected.workstream.workstreamId,
      branch: "main",
      head: finalized.workstreamContextCommit.headAfter,
      health: "ready",
      workstreamCard: { currentRequest: "R-0001" },
      requests: [{ id: "R-0001", status: "active" }],
      resourceManifest: {
        resources: [expect.objectContaining({
          role: "primary",
          access: "mutate",
          primary: true,
        })],
      },
      workingTreeChanges: [],
    });
  });

  it("reports unjournaled files as dirty instead of treating them as deliverables", async () => {
    const fixture = await createWorkstreamServiceFixture("validate-dirty");
    fixtures.push(fixture);
    const selected = await createBoundWorkstream(fixture);
    await materializeBoundWorkstream(fixture);
    await writeFile(`${selected.workstream.contextRepositoryPath}/index.html`, "not context\n", "utf8");

    const validation = await validateWorkstreamRepository({
      workstreamRoot: `${fixture.root}/workstreams`,
      contextRepositoryPath: selected.workstream.contextRepositoryPath,
      expectedWorkstreamId: selected.workstream.workstreamId,
    });

    expect(validation.health).toBe("dirty_external");
    expect(validation.workingTreeChanges).toEqual([
      `?? ${basename(selected.workstream.contextRepositoryPath)}/index.html`,
    ]);
  });

  it("rejects a repository without its committed progress ledger", async () => {
    const fixture = await createWorkstreamServiceFixture("validate-missing-progress");
    fixtures.push(fixture);
    const selected = await createBoundWorkstream(fixture);
    await materializeBoundWorkstream(fixture);
    await git(selected.workstream.contextRepositoryPath, ["rm", "progress.md"]);
    await git(selected.workstream.contextRepositoryPath, ["commit", "-m", "remove progress"]);

    await expect(validateWorkstreamRepository({
      workstreamRoot: `${fixture.root}/workstreams`,
      contextRepositoryPath: selected.workstream.contextRepositoryPath,
      expectedWorkstreamId: selected.workstream.workstreamId,
    })).rejects.toMatchObject({
      code: "WORKSTREAM_REPOSITORY_INVALID",
      details: { path: "progress.md" },
    });
  });

  it("rejects a malformed committed progress ledger", async () => {
    const fixture = await createWorkstreamServiceFixture("validate-invalid-progress");
    fixtures.push(fixture);
    const selected = await createBoundWorkstream(fixture);
    await materializeBoundWorkstream(fixture);
    await writeFile(
      `${selected.workstream.contextRepositoryPath}/progress.md`,
      "# Progress\n\ninvalid entry\n",
      "utf8",
    );
    await git(selected.workstream.contextRepositoryPath, ["add", "progress.md"]);
    await git(selected.workstream.contextRepositoryPath, ["commit", "-m", "break progress"]);

    await expect(validateWorkstreamRepository({
      workstreamRoot: `${fixture.root}/workstreams`,
      contextRepositoryPath: selected.workstream.contextRepositoryPath,
      expectedWorkstreamId: selected.workstream.workstreamId,
    })).rejects.toMatchObject({ code: "WORKSTREAM_PROGRESS_INVALID" });
  });

  it("rejects a committed deliverable inside the context repository", async () => {
    const fixture = await createWorkstreamServiceFixture("validate-tracked-output");
    fixtures.push(fixture);
    const selected = await createBoundWorkstream(fixture);
    await materializeBoundWorkstream(fixture);
    await writeFile(`${selected.workstream.contextRepositoryPath}/index.html`, "not context\n", "utf8");
    await git(selected.workstream.contextRepositoryPath, ["add", "index.html"]);
    await git(selected.workstream.contextRepositoryPath, ["commit", "-m", "add invalid output"]);

    await expect(validateWorkstreamRepository({
      workstreamRoot: `${fixture.root}/workstreams`,
      contextRepositoryPath: selected.workstream.contextRepositoryPath,
      expectedWorkstreamId: selected.workstream.workstreamId,
    })).rejects.toMatchObject({ code: "WORKSTREAM_REPOSITORY_INVALID" });
  });

  it("keeps path-specific workstream revisions stable when another workstream advances HEAD", async () => {
    const fixture = await createWorkstreamServiceFixture(
      "validate-shared-head",
      "Create the first independently maintained project.",
    );
    fixtures.push(fixture);
    const first = await createBoundWorkstream(fixture, {
      title: "First Project",
      objective: "Maintain the first independent project.",
    });
    const firstFinalization = await materializeBoundWorkstream(fixture);
    if (firstFinalization.workstreamContextCommit.status !== "committed") {
      throw new Error("Expected the first workstream finalization to create a commit.");
    }
    const firstHead = firstFinalization.workstreamContextCommit.headAfter;

    fixture.prepared = await fixture.service.prepareAgentRun({
      requestId: "REQ-validate-shared-head-second",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Create a separate second independently maintained project.",
      at: "2026-07-19T11:00:00+05:30",
    });
    const second = await createBoundWorkstream(fixture, {
      title: "Second Project",
      objective: "Maintain the second independent project.",
    });
    const secondFinalization = await materializeBoundWorkstream(fixture);
    if (secondFinalization.workstreamContextCommit.status !== "committed") {
      throw new Error("Expected the second workstream finalization to create a commit.");
    }
    const repositoryHead = secondFinalization.workstreamContextCommit.headAfter;

    const firstValidation = await validateWorkstreamRepository({
      workstreamRoot: join(fixture.root, "workstreams"),
      contextRepositoryPath: first.workstream.contextRepositoryPath,
      expectedWorkstreamId: first.workstream.workstreamId,
      requestReadMode: "all",
    });
    const secondValidation = await validateWorkstreamRepository({
      workstreamRoot: join(fixture.root, "workstreams"),
      contextRepositoryPath: second.workstream.contextRepositoryPath,
      expectedWorkstreamId: second.workstream.workstreamId,
      requestReadMode: "all",
    });

    expect(firstHead).not.toBe(repositoryHead);
    expect(firstValidation).toMatchObject({
      health: "ready",
      head: firstHead,
      repositoryHead,
    });
    expect(secondValidation).toMatchObject({
      health: "ready",
      head: repositoryHead,
      repositoryHead,
    });
    expect(fixture.database.prepare([
      "SELECT workstream_id, last_commit_sha FROM workstreams",
      "ORDER BY workstream_id",
    ].join(" ")).all()).toEqual([
      { workstream_id: first.workstream.workstreamId, last_commit_sha: firstHead },
      { workstream_id: second.workstream.workstreamId, last_commit_sha: repositoryHead },
    ]);
    expect(fixture.database.prepare([
      "SELECT head_sha FROM workstream_repository_state WHERE singleton_id = 1",
    ].join(" ")).get()).toEqual({ head_sha: repositoryHead });
    expect(await gitOutput(join(fixture.root, "workstreams"), [
      "diff",
      "--name-only",
      firstHead + ".." + repositoryHead,
      "--",
      basename(first.workstream.contextRepositoryPath),
    ])).toBe("");
    expect(await gitOutput(join(fixture.root, "workstreams"), [
      "rev-list",
      "--count",
      "HEAD",
    ])).toBe("3");
  });
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}
