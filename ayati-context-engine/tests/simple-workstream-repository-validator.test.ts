import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { validateWorkstreamRepository } from "../src/workstreams/workstream-repository-validator.js";
import {
  createBoundWorkstream,
  createWorkstreamServiceFixture,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const execFileAsync = promisify(execFile);
const fixtures: WorkstreamServiceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("workstream context repository validation", () => {
  it("accepts only the card, requests, and resource ledger as committed context", async () => {
    const fixture = await createWorkstreamServiceFixture("validate-ready");
    fixtures.push(fixture);
    const selected = await createBoundWorkstream(fixture);

    const validation = await validateWorkstreamRepository({
      workstreamRoot: `${fixture.root}/workstreams`,
      contextRepositoryPath: selected.workstream.contextRepositoryPath,
      expectedWorkstreamId: selected.workstream.workstreamId,
      requestReadMode: "all",
    });

    expect(validation).toMatchObject({
      workstreamId: selected.workstream.workstreamId,
      branch: "main",
      head: selected.workstream.head,
      health: "ready",
      workstreamCard: { currentRequest: "R-0001" },
      requests: [{ id: "R-0001", status: "active" }],
      resourceManifest: { resources: [] },
      workingTreeChanges: [],
    });
  });

  it("reports unjournaled files as dirty instead of treating them as deliverables", async () => {
    const fixture = await createWorkstreamServiceFixture("validate-dirty");
    fixtures.push(fixture);
    const selected = await createBoundWorkstream(fixture);
    await writeFile(`${selected.workstream.contextRepositoryPath}/index.html`, "not context\n", "utf8");

    const validation = await validateWorkstreamRepository({
      workstreamRoot: `${fixture.root}/workstreams`,
      contextRepositoryPath: selected.workstream.contextRepositoryPath,
      expectedWorkstreamId: selected.workstream.workstreamId,
    });

    expect(validation.health).toBe("dirty_external");
    expect(validation.workingTreeChanges).toEqual(["?? index.html"]);
  });

  it("rejects a committed deliverable inside the context repository", async () => {
    const fixture = await createWorkstreamServiceFixture("validate-tracked-output");
    fixtures.push(fixture);
    const selected = await createBoundWorkstream(fixture);
    await writeFile(`${selected.workstream.contextRepositoryPath}/index.html`, "not context\n", "utf8");
    await git(selected.workstream.contextRepositoryPath, ["add", "index.html"]);
    await git(selected.workstream.contextRepositoryPath, ["commit", "-m", "add invalid output"]);

    await expect(validateWorkstreamRepository({
      workstreamRoot: `${fixture.root}/workstreams`,
      contextRepositoryPath: selected.workstream.contextRepositoryPath,
      expectedWorkstreamId: selected.workstream.workstreamId,
    })).rejects.toMatchObject({ code: "WORKSTREAM_REPOSITORY_INVALID" });
  });
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
