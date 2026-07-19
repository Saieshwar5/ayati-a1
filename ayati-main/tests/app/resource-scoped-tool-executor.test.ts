import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitContextService, WorkstreamResourceBinding } from "ayati-git-context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createResourceScopedToolExecutor } from "../../src/app/resource-scoped-tool-executor.js";
import { createToolExecutor, type ToolExecutor } from "../../src/skills/tool-executor.js";
import { listDirectoryTool } from "../../src/skills/builtins/filesystem/list-directory.js";
import { patchFilesTool } from "../../src/skills/builtins/filesystem/patch-files.js";
import { readFilesTool } from "../../src/skills/builtins/filesystem/read-files.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";

const NOW = "2026-07-19T10:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("resource-scoped tool executor", () => {
  it("maps the root shorthand to the default workspace for an unbound read", async () => {
    const workspace = tempDirectory("ayati-unbound-workspace-");
    writeFileSync(join(workspace, "workspace-only.txt"), "safe\n", "utf-8");
    const service = serviceFor(unboundActiveContext("R-unbound"));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([listDirectoryTool]),
      gitContext: service,
      workspaceRoot: workspace,
    });

    const result = await executor.execute("list_directory", {
      path: "/",
      recursive: false,
      showHidden: false,
    }, executionContext("R-unbound", "call-list"));

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      dirPath: workspace,
      entries: [expect.objectContaining({ name: "workspace-only.txt" })],
    });
  });

  it("allows an unbound read from an ingress filesystem resource", async () => {
    const workspace = tempDirectory("ayati-workspace-");
    const reference = tempDirectory("ayati-user-reference-");
    writeFileSync(join(reference, "brief.txt"), "Reference material\n", "utf-8");
    const service = serviceFor(unboundActiveContext("R-unbound", [resource("RES-REF", reference)]));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([listDirectoryTool]),
      gitContext: service,
      workspaceRoot: workspace,
    });

    const result = await executor.execute("list_directory", {
      path: reference,
      recursive: false,
      showHidden: false,
    }, executionContext("R-unbound", "call-reference"));

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({ dirPath: reference });
  });

  it("reads an exact ingress file from its parent execution directory", async () => {
    const workspace = tempDirectory("ayati-workspace-");
    const reference = tempDirectory("ayati-user-reference-");
    const brief = join(reference, "brief.txt");
    writeFileSync(brief, "Exact reference material\n", "utf-8");
    const service = serviceFor(unboundActiveContext("R-unbound", [
      resource("RES-BRIEF", brief, { kind: "file" }),
    ]));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([readFilesTool]),
      gitContext: service,
      workspaceRoot: workspace,
    });

    const result = await executor.execute("read_files", {
      files: [{ path: brief, mode: "full" }],
    }, executionContext("R-unbound", "call-reference-file"));

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      results: [expect.objectContaining({ filePath: brief, content: "Exact reference material\n" })],
    });
  });

  it("rejects an unbound read outside the workspace and admitted resources", async () => {
    const workspace = tempDirectory("ayati-unbound-workspace-");
    const outside = tempDirectory("ayati-unbound-outside-");
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([listDirectoryTool]),
      gitContext: serviceFor(unboundActiveContext("R-unbound")),
      workspaceRoot: workspace,
    });

    const result = await executor.execute("list_directory", {
      path: outside,
      recursive: false,
      showHidden: false,
    }, executionContext("R-unbound", "call-outside"));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATH_OUTSIDE_WORKSPACE_ROOT");
  });

  it("rejects mutation before workstream binding without preparing an operation", async () => {
    const workspace = tempDirectory("ayati-unbound-workspace-");
    const service = serviceFor(unboundActiveContext("R-unbound"));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([writeFilesTool]),
      gitContext: service,
      workspaceRoot: workspace,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: join(workspace, "index.html"), content: "unsafe" }],
    }, executionContext("R-unbound", "call-write"));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("R_MUTATION_REQUIRES_WORKSTREAM_BINDING");
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
    expect(existsSync(join(workspace, "index.html"))).toBe(false);
  });

  it("maps the root shorthand to the primary bound resource", async () => {
    const workspace = tempDirectory("ayati-workspace-");
    const site = tempDirectory("ayati-site-");
    writeFileSync(join(site, "index.html"), "ready\n", "utf-8");
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([listDirectoryTool]),
      gitContext: serviceFor(boundActiveContext([binding("RES-SITE", site)])),
      workspaceRoot: workspace,
    });

    const result = await executor.execute("list_directory", {
      path: "/",
      recursive: false,
      showHidden: false,
    }, executionContext());

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({ dirPath: site });
  });

  it("rejects a call spanning two bound resources", async () => {
    const first = tempDirectory("ayati-resource-one-");
    const second = tempDirectory("ayati-resource-two-");
    const execute = vi.fn(async () => ({ ok: true, output: "should not run" }));
    const executor = createResourceScopedToolExecutor({
      base: baseExecutor(execute, ["read_files"]),
      gitContext: serviceFor(boundActiveContext([
        binding("RES-ONE", first),
        binding("RES-TWO", second, { primary: false }),
      ])),
    });

    const result = await executor.execute("read_files", {
      paths: [join(first, "one.txt"), join(second, "two.txt")],
    }, executionContext());

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("WORKSTREAM_RESOURCE_SCOPE_VIOLATION");
    expect(execute).not.toHaveBeenCalled();
  });

  it("denies mutation through a read-only resource binding", async () => {
    const site = tempDirectory("ayati-read-only-site-");
    const service = serviceFor(boundActiveContext([
      binding("RES-SITE", site, { access: "read" }),
    ]));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([writeFilesTool]),
      gitContext: service,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: join(site, "index.html"), content: "denied" }],
    }, executionContext());

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("WORKSTREAM_RESOURCE_MUTATION_DENIED");
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
  });

  it("prepares and verifies exact mutation targets for a bound resource", async () => {
    const site = tempDirectory("ayati-site-");
    const service = serviceFor(boundActiveContext([binding("RES-SITE", site)]));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([writeFilesTool]),
      gitContext: service,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: join(site, "index.html"), content: "<h1>Aurora Coffee</h1>" }],
      createDirs: true,
      allowExternalPath: true,
    }, executionContext());

    expect(result.ok).toBe(true);
    expect(readFileSync(join(site, "index.html"), "utf-8")).toContain("Aurora Coffee");
    expect(service.prepareResourceMutation).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "S-1",
      runId: "R-1",
      workstreamId: "W-1",
      activeRequestId: "REQ-1",
      callId: "call-1",
      tool: "write_files",
      targets: [{
        resourceId: "RES-SITE",
        relativePath: "index.html",
        kind: "file",
        expectedVersionKey: "directory:RES-SITE",
      }],
    }));
    expect(service.verifyResourceMutation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "OP-1",
      leaseId: "LEASE-1",
      lockToken: "LOCK-1",
      toolStatus: "completed",
    }));
  });

  it("reads and patches an exact file resource without widening its authority", async () => {
    const site = tempDirectory("ayati-site-");
    const index = join(site, "index.html");
    const sibling = join(site, "private.txt");
    writeFileSync(index, "<h1>Orbit</h1>\n", "utf-8");
    writeFileSync(sibling, "not authorized\n", "utf-8");
    const service = serviceFor(boundActiveContext([
      binding("RES-INDEX", index, { kind: "file" }),
    ]));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([readFilesTool, patchFilesTool]),
      gitContext: service,
    });

    const readResult = await executor.execute("read_files", {
      files: [{ path: index, mode: "full" }],
    }, executionContext("R-1", "call-read-index"));
    expect(readResult.ok).toBe(true);
    expect(readResult.v2?.structuredContent).toMatchObject({
      results: [expect.objectContaining({ filePath: index, content: "<h1>Orbit</h1>\n" })],
    });

    const patchResult = await executor.execute("patch_files", {
      files: [{
        path: index,
        patches: [{ kind: "replace_text", find: "Orbit", replace: "Orbit Studio" }],
      }],
    }, executionContext("R-1", "call-patch-index"));

    expect(patchResult.ok).toBe(true);
    expect(readFileSync(index, "utf-8")).toBe("<h1>Orbit Studio</h1>\n");
    expect(readFileSync(sibling, "utf-8")).toBe("not authorized\n");
    expect(service.prepareResourceMutation).toHaveBeenCalledWith(expect.objectContaining({
      callId: "call-patch-index",
      targets: [{
        resourceId: "RES-INDEX",
        kind: "file",
        expectedVersionKey: "file:RES-INDEX",
      }],
    }));
  });

  it("rejects sibling access when only an exact file resource is bound", async () => {
    const site = tempDirectory("ayati-site-");
    const index = join(site, "index.html");
    const sibling = join(site, "private.txt");
    writeFileSync(index, "<h1>Orbit</h1>\n", "utf-8");
    writeFileSync(sibling, "not authorized\n", "utf-8");
    const execute = vi.fn(async () => ({ ok: true, output: "should not run" }));
    const executor = createResourceScopedToolExecutor({
      base: baseExecutor(execute, ["read_files"]),
      gitContext: serviceFor(boundActiveContext([
        binding("RES-INDEX", index, { kind: "file" }),
      ])),
    });

    const result = await executor.execute("read_files", {
      files: [{ path: sibling, mode: "full" }],
    }, executionContext("R-1", "call-read-sibling"));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("WORKSTREAM_RESOURCE_SCOPE_VIOLATION");
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails the call when post-mutation verification requires recovery", async () => {
    const site = tempDirectory("ayati-site-");
    const service = serviceFor(boundActiveContext([binding("RES-SITE", site)]), {
      verified: false,
      status: "recovery_required",
    });
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([writeFilesTool]),
      gitContext: service,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: join(site, "index.html"), content: "written but uncertain" }],
    }, executionContext());

    expect(result.ok).toBe(false);
    expect(result.error).toContain("requires recovery");
  });

  it("requires absolute paths before preparing mutation authority", async () => {
    const site = tempDirectory("ayati-site-");
    const execute = vi.fn(async () => ({ ok: true, output: "should not run" }));
    const service = serviceFor(boundActiveContext([binding("RES-SITE", site)]));
    const executor = createResourceScopedToolExecutor({
      base: baseExecutor(execute, ["write_files"]),
      gitContext: service,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: "nested/index.html", content: "invalid" }],
    }, executionContext());

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("WORKSTREAM_RESOURCE_SCOPE_VIOLATION");
    expect(execute).not.toHaveBeenCalled();
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
  });

  it("rejects a canonical path that escapes through a symlink", async () => {
    const site = tempDirectory("ayati-site-");
    const outside = tempDirectory("ayati-outside-");
    symlinkSync(outside, join(site, "linked-outside"), "dir");
    const execute = vi.fn(async () => ({ ok: true, output: "should not run" }));
    const service = serviceFor(boundActiveContext([binding("RES-SITE", site)]));
    const executor = createResourceScopedToolExecutor({
      base: baseExecutor(execute, ["write_files"]),
      gitContext: service,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: join(site, "linked-outside", "escaped.txt"), content: "invalid" }],
    }, executionContext());

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("WORKSTREAM_RESOURCE_SCOPE_VIOLATION");
    expect(execute).not.toHaveBeenCalled();
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
    expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
  });

  it("requires explicit targets for process mutations and scopes their cwd", async () => {
    const site = tempDirectory("ayati-site-");
    const execute = vi.fn(async () => ({ ok: true, output: "build complete" }));
    const service = serviceFor(boundActiveContext([binding("RES-SITE", site)]));
    const executor = createResourceScopedToolExecutor({
      base: baseExecutor(execute, ["process_run"]),
      gitContext: service,
    });

    const unbounded = await executor.execute("process_run", {
      executable: "pnpm",
      args: ["build"],
    }, executionContext());
    expect(unbounded.ok).toBe(false);
    expect(unbounded.v2?.code).toBe("WORKSTREAM_RESOURCE_SCOPE_VIOLATION");
    expect(execute).not.toHaveBeenCalled();

    const bounded = await executor.execute("process_run", {
      executable: "pnpm",
      args: ["build"],
      targets: [{ path: join(site, "dist"), kind: "directory" }],
    }, executionContext("R-1", "call-2"));

    expect(bounded.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith("process_run", expect.objectContaining({
      cwd: site,
      targets: [{ path: join(site, "dist"), kind: "directory" }],
    }), expect.objectContaining({
      resourceScope: {
        kind: "resource",
        rootPath: site,
        authorityPath: site,
        authorityKind: "directory",
        workstreamId: "W-1",
        resourceId: "RES-SITE",
      },
    }));
  });
});

function tempDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function executionContext(runId = "R-1", callId = "call-1") {
  return {
    clientId: "client-1",
    sessionId: "S-1",
    runId,
    stepNumber: 1,
    callId,
  };
}

function baseExecutor(execute: ReturnType<typeof vi.fn>, tools: string[]): ToolExecutor {
  return {
    list: () => tools,
    definitions: () => [],
    validate: () => ({ valid: true }),
    execute,
  };
}

function serviceFor(
  activeContext: ReturnType<typeof boundActiveContext> | ReturnType<typeof unboundActiveContext>,
  verification: { verified: boolean; status: string } = { verified: true, status: "verified" },
) {
  return {
    getActiveContext: vi.fn(async () => activeContext),
    prepareResourceMutation: vi.fn(async () => ({
      operationId: "OP-1",
      leaseId: "LEASE-1",
      lockToken: "LOCK-1",
    })),
    verifyResourceMutation: vi.fn(async () => verification),
  } as unknown as GitContextService & {
    getActiveContext: ReturnType<typeof vi.fn>;
    prepareResourceMutation: ReturnType<typeof vi.fn>;
    verifyResourceMutation: ReturnType<typeof vi.fn>;
  };
}

function resource(
  resourceId: string,
  path: string,
  options: { kind?: "file" | "directory" } = {},
) {
  return binding(resourceId, path, options).resource;
}

function binding(
  resourceId: string,
  path: string,
  options: {
    access?: "read" | "mutate";
    primary?: boolean;
    kind?: "file" | "directory";
  } = {},
): WorkstreamResourceBinding {
  const kind = options.kind ?? "directory";
  return {
    resource: {
      resourceId,
      kind,
      origin: "agent_created",
      displayName: resourceId,
      description: `Filesystem resource ${resourceId}`,
      aliases: [],
      locator: { kind: "filesystem", path },
      version: {
        key: `${kind}:${resourceId}`,
        observedAt: NOW,
        exists: true,
        kind,
        ...(kind === "directory" ? { entryCount: 0 } : { sizeBytes: 0 }),
      },
      availability: "available",
      metadataStatus: "enriched",
      createdAt: NOW,
      updatedAt: NOW,
    },
    role: "primary",
    access: options.access ?? "mutate",
    primary: options.primary ?? true,
    requestIds: ["REQ-1"],
    boundAt: NOW,
  };
}

function boundActiveContext(resources: WorkstreamResourceBinding[]) {
  return {
    run: {
      run: {
        runId: "R-1",
        sessionId: "S-1",
        conversationId: "C-1",
        workstreamBinding: {
          workstreamId: "W-1",
          requestId: "REQ-1",
          boundAt: NOW,
        },
      },
    },
    activeWorkstream: {
      workstream: { workstreamId: "W-1" },
      resources,
    },
    ingressResources: [],
  };
}

function unboundActiveContext(runId: string, ingressResources: ReturnType<typeof resource>[] = []) {
  return {
    run: { run: { runId } },
    activeWorkstream: undefined,
    ingressResources,
  };
}
