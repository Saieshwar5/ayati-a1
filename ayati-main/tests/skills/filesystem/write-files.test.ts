import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ToolExecutionContext,
  ToolResult,
} from "../../../src/skills/types.js";
import { writeFilesTool } from "../../../src/skills/builtins/filesystem/write-files.js";
import {
  MAX_WRITE_FILES,
  MAX_WRITE_TOTAL_BYTES,
} from "../../../src/skills/builtins/filesystem/validators.js";
import { createToolExecutor } from "../../../src/skills/tool-executor.js";

describe("writeFilesTool", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "write-files-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes a three-file website in one call and creates parents by default", async () => {
    const site = join(tmp, "lumen-finch");
    const paths = [
      join(site, "index.html"),
      join(site, "styles.css"),
      join(site, "script.js"),
    ];

    const result = await writeFilesTool.execute({
      files: [
        { path: paths[0], content: "<h1>Lumen Finch</h1>\n" },
        { path: paths[1], content: "body { color: navy; }\n" },
        { path: paths[2], content: "console.log(\"ready\");\n" },
      ],
    }, mutationContext(tmp));

    expect(result.ok).toBe(true);
    expect(result.v2?.code).toBe("FILES_APPLIED");
    expect(structured(result)).toMatchObject({
      filesRequested: 3,
      filesChanged: 3,
      filesUnchanged: 0,
      filesFailed: 0,
      files: paths.map((path) => ({ path, status: "created" })),
    });
    expect(await readFile(paths[0]!, "utf-8")).toContain("Lumen Finch");
    expect(await readFile(paths[1]!, "utf-8")).toContain("navy");
    expect(await readFile(paths[2]!, "utf-8")).toContain("ready");
  });

  it("accepts the configured maximum number of files", async () => {
    const files = Array.from({ length: MAX_WRITE_FILES }, (_, index) => ({
      path: join(tmp, `file-${index}.txt`),
      content: `content-${index}`,
    }));

    const result = await writeFilesTool.execute({ files }, mutationContext(tmp));

    expect(result.ok).toBe(true);
    expect(structured(result).filesRequested).toBe(MAX_WRITE_FILES);
  });

  it("rejects too many files before creating a destination", async () => {
    const destination = join(tmp, "not-created");
    const files = Array.from({ length: MAX_WRITE_FILES + 1 }, (_, index) => ({
      path: join(destination, `file-${index}.txt`),
      content: "x",
    }));

    const result = await writeFilesTool.execute({ files }, mutationContext(tmp));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("WRITE_INPUT_LIMIT_EXCEEDED");
    expect(await pathKind(destination)).toBe("missing");
  });

  it("rejects an oversized UTF-8 payload before mutation", async () => {
    const destination = join(tmp, "not-created");

    const result = await writeFilesTool.execute({
      files: [{
        path: join(destination, "large.txt"),
        content: "x".repeat(MAX_WRITE_TOTAL_BYTES + 1),
      }],
    }, mutationContext(tmp));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("WRITE_INPUT_LIMIT_EXCEEDED");
    expect(await pathKind(destination)).toBe("missing");
  });

  it("exposes no model-facing hash or permission fields", async () => {
    const schema = JSON.stringify(writeFilesTool.inputSchema);
    expect(schema).toContain("createParents");
    expect(schema).not.toContain("baseSha256");
    expect(schema).not.toContain("allowExternalPath");
    expect(schema).not.toContain("confirmationToken");

    const target = join(tmp, "legacy.txt");
    const result = await writeFilesTool.execute({
      allowExternalPath: true,
      files: [{
        path: target,
        content: "legacy",
        baseSha256: sha256Text("before"),
      }],
    }, mutationContext(tmp));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("WRITE_INPUT_INVALID");
    expect(await pathKind(target)).toBe("missing");
  });

  it("replaces an existing file without a model-supplied hash", async () => {
    const file = join(tmp, "existing.txt");
    await writeFile(file, "before", "utf-8");

    const result = await writeFilesTool.execute({
      files: [{ path: file, content: "after" }],
    }, mutationContext(tmp));

    expect(result.ok).toBe(true);
    expect(await readFile(file, "utf-8")).toBe("after");
    expect(structured(result)).toMatchObject({
      filesChanged: 1,
      files: [{
        path: file,
        status: "replaced",
        sha256: sha256Text("after"),
      }],
    });
  });

  it("returns unchanged when content is already current and is retry-safe", async () => {
    const file = join(tmp, "current.txt");
    await writeFile(file, "desired", "utf-8");

    const first = await writeFilesTool.execute({
      files: [{ path: file, content: "desired" }],
    }, mutationContext(tmp));
    const second = await writeFilesTool.execute({
      files: [{ path: file, content: "desired" }],
    }, mutationContext(tmp));

    expect(first.ok).toBe(true);
    expect(first.v2?.code).toBe("FILES_ALREADY_CURRENT");
    expect(second.ok).toBe(true);
    expect(structured(second)).toMatchObject({
      filesChanged: 0,
      filesUnchanged: 1,
      bytesWritten: 0,
      files: [{ path: file, status: "unchanged" }],
    });
  });

  it("rejects a stale internally supplied target state", async () => {
    const file = join(tmp, "conflict.txt");
    await writeFile(file, "current version", "utf-8");
    const context = mutationContext(tmp, [{
      path: file,
      expected: {
        kind: "file",
        sizeBytes: Buffer.byteLength("older version"),
        sha256: sha256Text("older version"),
        mode: 0o644,
        linkCount: 1,
      },
    }]);

    const result = await writeFilesTool.execute({
      files: [{ path: file, content: "desired version" }],
    }, context);

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("WRITE_CONFLICT");
    expect(await readFile(file, "utf-8")).toBe("current version");
    expect(structured(result)).toMatchObject({
      filesChanged: 0,
      filesFailed: 1,
      files: [{ path: file, status: "failed" }],
    });
  });

  it("rejects duplicate canonical target paths through a symlinked parent", async () => {
    const real = join(tmp, "real");
    const alias = join(tmp, "alias");
    await mkdir(real);
    await symlink(real, alias, "dir");

    const result = await writeFilesTool.execute({
      files: [
        { path: join(real, "same.txt"), content: "first" },
        { path: join(alias, "same.txt"), content: "second" },
      ],
    }, mutationContext(tmp));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("DUPLICATE_TARGET_PATH");
    expect(await pathKind(join(real, "same.txt"))).toBe("missing");
  });

  it("fails without parent creation when createParents is false", async () => {
    const target = join(tmp, "missing", "a.txt");

    const result = await writeFilesTool.execute({
      createParents: false,
      files: [{ path: target, content: "alpha" }],
    }, mutationContext(tmp));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("WRITE_PARENT_MISSING");
    expect(await pathKind(join(tmp, "missing"))).toBe("missing");
  });

  it("rejects relative file paths", async () => {
    const result = await writeFilesTool.execute({
      files: [{ path: "relative.txt", content: "no" }],
    }, mutationContext(tmp));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("ABSOLUTE_PATH_REQUIRED");
  });

  it("rejects paths outside the selected destination root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "write-files-outside-"));
    try {
      const target = join(outside, "blocked.txt");
      const result = await writeFilesTool.execute({
        files: [{ path: target, content: "blocked" }],
      }, mutationContext(tmp));

      expect(result.ok).toBe(false);
      expect(result.v2?.code).toBe("PATH_OUTSIDE_SELECTED_MUTATION_ROOT");
      expect(await pathKind(target)).toBe("missing");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not replace a symbolic-link target", async () => {
    const real = join(tmp, "real.txt");
    const alias = join(tmp, "alias.txt");
    await writeFile(real, "keep", "utf-8");
    await symlink(real, alias);

    const result = await writeFilesTool.execute({
      files: [{ path: alias, content: "replace" }],
    }, mutationContext(tmp));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("WRITE_TARGET_NOT_REGULAR_FILE");
    expect(await readFile(real, "utf-8")).toBe("keep");
  });

  it("does not break hard-link identity when replacement is requested", async () => {
    const first = join(tmp, "first.txt");
    const second = join(tmp, "second.txt");
    await writeFile(first, "shared", "utf-8");
    await link(first, second);

    const result = await writeFilesTool.execute({
      files: [{ path: first, content: "replacement" }],
    }, mutationContext(tmp));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("WRITE_HARDLINK_UNSUPPORTED");
    expect(await readFile(first, "utf-8")).toBe("shared");
    expect(await readFile(second, "utf-8")).toBe("shared");
  });

  it("preserves ordinary executable permission bits when replacing a file", async () => {
    const file = join(tmp, "script.sh");
    await writeFile(file, "#!/bin/sh\necho before\n", "utf-8");
    await chmod(file, 0o751);

    const result = await writeFilesTool.execute({
      files: [{ path: file, content: "#!/bin/sh\necho after\n" }],
    }, mutationContext(tmp));

    expect(result.ok).toBe(true);
    expect((await lstat(file)).mode & 0o777).toBe(0o751);
  });

  it("uses a structural generic contract and leaves physical hashes to the outer verifier", async () => {
    const first = join(tmp, "contract", "a.txt");
    const second = join(tmp, "contract", "b.txt");
    const executor = createToolExecutor([writeFilesTool]);

    const result = await executor.execute("write_files", {
      files: [
        { path: first, content: "alpha" },
        { path: second, content: "beta" },
      ],
    }, mutationContext(tmp));

    expect(result.ok).toBe(true);
    expect(result.v2?.verification?.status).toBe("passed");
    expect(result.v2?.verification?.assertions.map((assertion) => assertion.id)).toEqual([
      "operation_succeeded",
      "files_result_matches_request",
      "files_requested_matches_request",
    ]);
    expect(result.v2?.verification?.facts.some((fact) => fact.kind === "written_hash_verified")).toBe(false);
    expect(result.v2?.artifacts?.map((artifact) => artifact.path)).toEqual([first, second]);
  });
});

function mutationContext(
  root: string,
  filesystemTargetPreconditions?: ToolExecutionContext["filesystemTargetPreconditions"],
): ToolExecutionContext {
  return {
    ...(filesystemTargetPreconditions ? { filesystemTargetPreconditions } : {}),
    resourceScope: {
      kind: "mutation_root",
      rootPath: root,
      authorityPath: root,
      authorityKind: "directory",
    },
  };
}

function structured(result: ToolResult): Record<string, any> {
  return result.v2?.structuredContent as Record<string, any>;
}

async function pathKind(path: string): Promise<"missing" | "file" | "directory" | "other"> {
  try {
    const info = await lstat(path);
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}
