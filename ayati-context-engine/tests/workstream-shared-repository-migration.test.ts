import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import {
  migrateToSharedWorkstreamRepository,
} from "../src/services/workstream-shared-repository-migration.js";
import {
  renderWorkstreamProgress,
} from "../src/workstreams/workstream-progress.js";
import {
  renderWorkstreamResourceManifest,
} from "../src/workstreams/workstream-resource-manifest.js";
import {
  validateWorkstreamRepository,
} from "../src/workstreams/workstream-repository-validator.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const databases: ContextDatabase[] = [];
const NOW = "2026-07-29T10:00:00+05:30";

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("shared workstream repository migration", () => {
  it("converts multiple clean nested repositories, archives them, and rebuilds V12 projections", async () => {
    const root = await createRoot("success");
    const workstreamRoot = join(root, "workstreams");
    await mkdir(workstreamRoot);
    const first = await createLegacyRepository(workstreamRoot, {
      id: "W-20260729-0001",
      slug: "first-project",
      title: "First Project",
      requestStatus: "active",
      currentRequest: "R-0001",
      runId: "RUN-AABBCCDD-0000000001",
    });
    const second = await createLegacyRepository(workstreamRoot, {
      id: "W-20260729-0002",
      slug: "second-project",
      title: "Second Project",
      requestStatus: "done",
      currentRequest: null,
      runId: "RUN-AABBCCDD-0000000002",
      includeProgress: false,
    });

    const preview = await migrateToSharedWorkstreamRepository({
      workstreamRoot,
      now: NOW,
      confirm: false,
    });

    expect(preview).toMatchObject({
      scannedDirectories: 2,
      applied: false,
      failures: [],
      workstreams: [
        {
          workstreamId: "W-20260729-0001",
          requestCount: 1,
          progressCount: 1,
          resourceCount: 0,
          convertedFiles: 2,
        },
        {
          workstreamId: "W-20260729-0002",
          requestCount: 1,
          progressCount: 0,
          resourceCount: 0,
          convertedFiles: 3,
        },
      ],
    });
    expect(await exists(join(first, ".git"))).toBe(true);
    expect(await exists(join(second, ".git"))).toBe(true);

    const database = await ContextDatabase.open({
      path: join(root, "context-v9.db"),
      now: () => NOW,
    });
    databases.push(database);
    const archiveRoot = join(root, "workstreams-archive");
    const migrated = await migrateToSharedWorkstreamRepository({
      workstreamRoot,
      archiveRoot,
      database,
      now: NOW,
      confirm: true,
    });

    expect(migrated).toMatchObject({
      applied: true,
      archiveRoot,
      sharedRepositoryHead: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(await exists(join(workstreamRoot, ".git"))).toBe(true);
    expect(await exists(join(workstreamRoot, basename(first), ".git"))).toBe(false);
    expect(await exists(join(workstreamRoot, basename(second), ".git"))).toBe(false);
    expect(await exists(join(archiveRoot, "workstreams", basename(first), ".git"))).toBe(true);
    expect(await exists(join(archiveRoot, "workstreams", basename(second), ".git"))).toBe(true);
    expect(await git(workstreamRoot, ["rev-list", "--count", "HEAD"])).toBe("1");

    const firstValidation = await validateWorkstreamRepository({
      workstreamRoot,
      contextRepositoryPath: join(workstreamRoot, basename(first)),
      expectedWorkstreamId: "W-20260729-0001",
      requestReadMode: "all",
    });
    const secondValidation = await validateWorkstreamRepository({
      workstreamRoot,
      contextRepositoryPath: join(workstreamRoot, basename(second)),
      expectedWorkstreamId: "W-20260729-0002",
      requestReadMode: "all",
    });
    expect(firstValidation).toMatchObject({
      health: "ready",
      workstreamCard: {
        schema: "ayati.workstream/v3",
        currentRequest: "R-0001",
      },
      requests: [{
        schema: "ayati.request/v3",
        id: "R-0001",
        status: "active",
        finalOutcome: "Pending.",
      }],
    });
    expect(secondValidation).toMatchObject({
      health: "ready",
      workstreamCard: {
        schema: "ayati.workstream/v3",
        currentRequest: null,
      },
      requests: [{
        schema: "ayati.request/v3",
        id: "R-0001",
        status: "done",
        finalOutcome: "The legacy request was completed.",
      }],
      progress: {
        entries: [],
      },
    });
    expect(database.prepare([
      "SELECT",
      "(SELECT COUNT(*) FROM workstreams) AS workstreams,",
      "(SELECT COUNT(*) FROM workstream_requests) AS requests,",
      "(SELECT COUNT(*) FROM workstream_progress) AS progress,",
      "(SELECT COUNT(*) FROM workstream_repository_state) AS repository_state",
    ].join(" ")).get()).toEqual({
      workstreams: 2,
      requests: 2,
      progress: 1,
      repository_state: 1,
    });
    expect(database.prepare([
      "SELECT head_sha FROM workstream_repository_state WHERE singleton_id = 1",
    ].join(" ")).get()).toEqual({ head_sha: migrated.sharedRepositoryHead });
    expect(JSON.parse(await readFile(join(archiveRoot, "manifest.json"), "utf8")))
      .toMatchObject({
        version: 1,
        status: "completed",
        sharedRepositoryHead: migrated.sharedRepositoryHead,
      });
  });

  it("reports and refuses a nested repository that tracks a deliverable", async () => {
    const root = await createRoot("invalid");
    const workstreamRoot = join(root, "workstreams");
    await mkdir(workstreamRoot);
    const repository = await createLegacyRepository(workstreamRoot, {
      id: "W-20260729-0001",
      slug: "invalid-project",
      title: "Invalid Project",
      requestStatus: "active",
      currentRequest: "R-0001",
      runId: "RUN-EEFF0011-0000000001",
    });
    await writeFile(join(repository, "index.html"), "<p>deliverable</p>\n", "utf8");
    await git(repository, ["add", "index.html"]);
    await git(repository, ["commit", "-m", "track an invalid deliverable"]);

    const preview = await migrateToSharedWorkstreamRepository({
      workstreamRoot,
      now: NOW,
      confirm: false,
    });

    expect(preview).toMatchObject({
      scannedDirectories: 1,
      workstreams: [],
      applied: false,
      failures: [{
        sourcePath: repository,
        message: expect.stringContaining("non-context paths: index.html"),
      }],
    });
    expect(await exists(join(workstreamRoot, ".git"))).toBe(false);
    expect(await exists(join(repository, ".git"))).toBe(true);

    const database = await ContextDatabase.open({
      path: join(root, "context-v9.db"),
      now: () => NOW,
    });
    databases.push(database);
    await expect(migrateToSharedWorkstreamRepository({
      workstreamRoot,
      archiveRoot: join(root, "workstreams-archive"),
      database,
      now: NOW,
      confirm: true,
    })).rejects.toThrow("requires at least one valid nested workstream");
    expect(await exists(join(repository, ".git"))).toBe(true);
  });

  it("restores the nested root when catalog installation fails after the filesystem switch", async () => {
    const root = await createRoot("rollback");
    const workstreamRoot = join(root, "workstreams");
    await mkdir(workstreamRoot);
    const repository = await createLegacyRepository(workstreamRoot, {
      id: "W-20260729-0001",
      slug: "rollback-project",
      title: "Rollback Project",
      requestStatus: "active",
      currentRequest: "R-0001",
      runId: "RUN-11223344-0000000001",
    });
    const database = await ContextDatabase.open({
      path: join(root, "context-v9.db"),
      now: () => NOW,
    });
    databases.push(database);
    database.prepare([
      "INSERT INTO workstream_repository_state(",
      "singleton_id, repository_path, branch, head_sha, repository_health, updated_at",
      ") VALUES (1, ?, 'main', ?, 'ready', ?)",
    ].join(" ")).run(
      join(root, "unrelated-repository"),
      "a".repeat(40),
      NOW,
    );
    const archiveRoot = join(root, "workstreams-archive");

    await expect(migrateToSharedWorkstreamRepository({
      workstreamRoot,
      archiveRoot,
      database,
      now: NOW,
      confirm: true,
    })).rejects.toThrow("requires an empty workstream");

    expect(await exists(join(workstreamRoot, ".git"))).toBe(false);
    expect(await exists(join(repository, ".git"))).toBe(true);
    expect(await exists(join(archiveRoot, "failed-shared-repository", ".git"))).toBe(true);
    expect(JSON.parse(await readFile(join(archiveRoot, "manifest.json"), "utf8")))
      .toMatchObject({
        status: "failed",
        error: expect.stringContaining("requires an empty workstream"),
      });
  });
});

async function createRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `ayati-v9-migration-${name}-`));
  roots.push(root);
  return root;
}

async function createLegacyRepository(
  workstreamRoot: string,
  input: {
    id: string;
    slug: string;
    title: string;
    requestStatus: "active" | "done";
    currentRequest: "R-0001" | null;
    runId: string;
    includeProgress?: boolean;
  },
): Promise<string> {
  const repository = join(workstreamRoot, input.id + "-" + input.slug);
  await mkdir(join(repository, "requests"), { recursive: true });
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.name", "Ayati migration test"]);
  await git(repository, ["config", "user.email", "migration-test@ayati.local"]);
  await writeFile(join(repository, "workstream.md"), legacyCard(input), "utf8");
  await writeFile(
    join(repository, "requests", "R-0001-initial-request.md"),
    legacyRequest(input),
    "utf8",
  );
  if (input.includeProgress !== false) {
    await writeFile(join(repository, "progress.md"), renderWorkstreamProgress([{
      runId: input.runId,
      requestId: "R-0001",
      at: "2026-07-28T10:00:00+05:30",
      outcome: input.requestStatus === "done" ? "done" : "incomplete",
      summary: "Recorded legacy progress.",
      workCompleted: ["Preserved the existing request context."],
      verifiedMutations: [],
      validation: ["The legacy context was valid."],
      findingsAndDecisions: [],
      problems: [],
      ...(input.requestStatus === "active"
        ? { next: "Continue the legacy request." }
        : {}),
    }]), "utf8");
  }
  await writeFile(join(repository, "resources.json"), renderWorkstreamResourceManifest({
    schema: "ayati.workstream-resources/v1",
    workstreamId: input.id,
    updatedAt: "2026-07-28T10:00:00+05:30",
    resources: [],
  }), "utf8");
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "record legacy context"]);
  return repository;
}

function legacyCard(input: {
  id: string;
  title: string;
  currentRequest: "R-0001" | null;
}): string {
  return [
    "---",
    "schema: ayati.workstream/v2",
    "id: " + input.id,
    "title: " + input.title,
    "status: active",
    "current_request: " + (input.currentRequest ?? "none"),
    "---",
    "",
    "# " + input.title,
    "",
    "## Purpose",
    "",
    "Maintain " + input.title + " as a durable project.",
    "",
    "## Current snapshot",
    "",
    "The legacy project context is valid.",
    "",
    "## Current focus",
    "",
    input.currentRequest ? "Continue the initial request." : "Choose the next request.",
    "",
    "## Blockers",
    "",
    "None.",
    "",
    "## Working agreements",
    "",
    "- Keep deliverables outside the context repository.",
    "",
  ].join("\n");
}

function legacyRequest(input: {
  title: string;
  requestStatus: "active" | "done";
}): string {
  return [
    "---",
    "schema: ayati.request/v2",
    "id: R-0001",
    "status: " + input.requestStatus,
    "created_at: 2026-07-28T09:00:00+05:30",
    "source: user",
    "---",
    "",
    "# Initial " + input.title + " request",
    "",
    "## Request",
    "",
    "Complete the initial bounded project outcome.",
    "",
    "## Acceptance",
    "",
    "- The requested outcome is verified.",
    "",
    "## Constraints",
    "",
    "- Preserve the existing project directory.",
    "",
    "## Outcome",
    "",
    input.requestStatus === "done"
      ? "The legacy request was completed."
      : "Not completed yet.",
    "",
  ].join("\n");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-07-28T10:00:00+05:30",
      GIT_COMMITTER_DATE: "2026-07-28T10:00:00+05:30",
    },
  });
  return result.stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(() => true, () => false);
}
