import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextEngineService, WorkstreamResourceBinding } from "ayati-context-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createResourceScopedToolExecutor } from "../../src/app/resource-scoped-tool-executor.js";
import { createToolExecutor, type ToolExecutor } from "../../src/skills/tool-executor.js";
import { createDirectoryTool } from "../../src/skills/builtins/filesystem/create-directory.js";
import { copyTool } from "../../src/skills/builtins/filesystem/copy.js";
import { deleteTool } from "../../src/skills/builtins/filesystem/delete.js";
import { findFilesTool } from "../../src/skills/builtins/filesystem/find-files.js";
import { inspectPathsTool } from "../../src/skills/builtins/filesystem/inspect-paths.js";
import { listDirectoryTool } from "../../src/skills/builtins/filesystem/list-directory.js";
import { moveTool } from "../../src/skills/builtins/filesystem/move.js";
import { patchFilesTool } from "../../src/skills/builtins/filesystem/patch-files.js";
import { readFilesTool } from "../../src/skills/builtins/filesystem/read-files.js";
import { searchInFilesTool } from "../../src/skills/builtins/filesystem/search-in-files.js";
import { setPermissionsTool } from "../../src/skills/builtins/filesystem/set-permissions.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { createContextSkill } from "../../src/skills/builtins/context/index.js";
import {
  createPersonalMemoryHotContextSource,
  HotContextRuntime,
} from "../../src/ivec/hot-context/index.js";

const NOW = "2026-07-19T10:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("resource-scoped tool executor", () => {
  it("uses the exact default workspace path for an unbound read", async () => {
    const workspace = tempDirectory("ayati-unbound-workspace-");
    writeFileSync(join(workspace, "workspace-only.txt"), "safe\n", "utf-8");
    const service = serviceFor(unboundActiveContext("R-unbound"));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([listDirectoryTool]),
      contextEngine: service,
      workspaceRoot: workspace,
    });

    const result = await executor.execute("list_directory", {
      path: workspace,
      recursive: false,
      showHidden: false,
    }, executionContext("R-unbound", "call-list"));

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      dirPath: workspace,
      entries: [expect.objectContaining({ name: "workspace-only.txt" })],
    });
  });

  it("allows an explicit machine root for an unbound filesystem read", async () => {
    const workspace = tempDirectory("ayati-unbound-workspace-");
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([listDirectoryTool]),
      contextEngine: serviceFor(unboundActiveContext("R-unbound")),
      workspaceRoot: workspace,
    });

    const result = await executor.execute("list_directory", {
      path: "/",
      recursive: false,
      showHidden: false,
    }, executionContext("R-unbound", "call-root"));

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({ dirPath: "/" });
  });

  it("allows an unbound read from an ingress filesystem resource", async () => {
    const workspace = tempDirectory("ayati-workspace-");
    const reference = tempDirectory("ayati-user-reference-");
    writeFileSync(join(reference, "brief.txt"), "Reference material\n", "utf-8");
    const service = serviceFor(unboundActiveContext("R-unbound", [resource("RES-REF", reference)]));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([listDirectoryTool]),
      contextEngine: service,
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
      contextEngine: service,
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

  it("allows an unbound read outside the workspace without resource admission", async () => {
    const workspace = tempDirectory("ayati-unbound-workspace-");
    const outside = tempDirectory("ayati-unbound-outside-");
    writeFileSync(join(outside, "external.txt"), "machine readable\n", "utf-8");
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([listDirectoryTool]),
      contextEngine: serviceFor(unboundActiveContext("R-unbound")),
      workspaceRoot: workspace,
    });

    const result = await executor.execute("list_directory", {
      path: outside,
      recursive: false,
      showHidden: false,
    }, executionContext("R-unbound", "call-outside"));

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      dirPath: outside,
      entries: [expect.objectContaining({ name: "external.txt" })],
    });
  });

  it("can restore workspace-only reads through operator configuration", async () => {
    const workspace = tempDirectory("ayati-read-policy-workspace-");
    const outside = tempDirectory("ayati-read-policy-outside-");
    const externalFile = join(outside, "external.txt");
    writeFileSync(externalFile, "outside\n", "utf-8");
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([readFilesTool]),
      contextEngine: serviceFor(unboundActiveContext("R-unbound")),
      workspaceRoot: workspace,
      filesystemAccess: {
        readScope: "workspace",
        mutationScope: "workspace",
      },
    });

    const result = await executor.execute("read_files", {
      files: [{ path: externalFile, mode: "full" }],
    }, executionContext("R-unbound", "call-workspace-policy-read"));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATH_OUTSIDE_WORKSPACE_ROOT");
  });

  it("uses the workspace only as the default search root when roots are omitted", async () => {
    const workspace = tempDirectory("ayati-search-workspace-");
    const outside = tempDirectory("ayati-search-outside-");
    writeFileSync(join(workspace, "workspace-orbit.txt"), "workspace\n", "utf-8");
    writeFileSync(join(outside, "outside-orbit.txt"), "outside\n", "utf-8");
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([findFilesTool]),
      contextEngine: serviceFor(unboundActiveContext("R-unbound")),
      workspaceRoot: workspace,
    });

    const defaultResult = await executor.execute("find_files", {
      query: "orbit",
    }, executionContext("R-unbound", "call-default-search"));
    const externalResult = await executor.execute("find_files", {
      query: "orbit",
      roots: [outside],
    }, executionContext("R-unbound", "call-external-search"));

    expect(defaultResult.v2?.structuredContent).toMatchObject({
      roots: [workspace],
      matchCount: 1,
    });
    expect(externalResult.v2?.structuredContent).toMatchObject({
      roots: [outside],
      matches: [expect.objectContaining({
        absolutePath: join(outside, "outside-orbit.txt"),
      })],
    });
  });

  it("searches text under an explicit external directory", async () => {
    const workspace = tempDirectory("ayati-search-workspace-");
    const outside = tempDirectory("ayati-search-outside-");
    writeFileSync(join(outside, "brief.txt"), "Coordinator: Mira Sol\n", "utf-8");
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([searchInFilesTool]),
      contextEngine: serviceFor(unboundActiveContext("R-unbound")),
      workspaceRoot: workspace,
    });

    const result = await executor.execute("search_in_files", {
      query: "Mira Sol",
      roots: [outside],
    }, executionContext("R-unbound", "call-external-content-search"));

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      roots: [outside],
      matchedFileCount: 1,
    });
  });

  it("follows a workspace symlink to a readable external file", async () => {
    const workspace = tempDirectory("ayati-symlink-workspace-");
    const outside = tempDirectory("ayati-symlink-outside-");
    const target = join(outside, "external.txt");
    const link = join(workspace, "external-link.txt");
    writeFileSync(target, "External through symlink\n", "utf-8");
    symlinkSync(target, link, "file");
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([readFilesTool]),
      contextEngine: serviceFor(unboundActiveContext("R-unbound")),
      workspaceRoot: workspace,
    });

    const result = await executor.execute("read_files", {
      files: [{ path: link, mode: "full" }],
    }, executionContext("R-unbound", "call-symlink-read"));

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      results: [expect.objectContaining({
        requestedPath: link,
        content: "External through symlink\n",
      })],
    });
  });

  it("inspects metadata for an external file without resource admission", async () => {
    const workspace = tempDirectory("ayati-inspect-workspace-");
    const outside = tempDirectory("ayati-inspect-outside-");
    const externalFile = join(outside, "external.txt");
    writeFileSync(externalFile, "External metadata\n", "utf-8");
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([inspectPathsTool]),
      contextEngine: serviceFor(unboundActiveContext("R-unbound")),
      workspaceRoot: workspace,
    });

    const result = await executor.execute("inspect_paths", {
      paths: [externalFile],
      includeHash: true,
    }, executionContext("R-unbound", "call-external-inspect"));

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      results: [expect.objectContaining({
        path: externalFile,
        exists: true,
        kind: "file",
      })],
    });
  });

  it("still rejects relative paths for machine-wide reads", async () => {
    const workspace = tempDirectory("ayati-read-workspace-");
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([readFilesTool]),
      contextEngine: serviceFor(unboundActiveContext("R-unbound")),
      workspaceRoot: workspace,
    });

    const result = await executor.execute("read_files", {
      files: [{ path: "relative.txt", mode: "full" }],
    }, executionContext("R-unbound", "call-relative-read"));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("ABSOLUTE_PATH_REQUIRED");
  });

  it.skipIf(process.getuid?.() === 0)(
    "returns no content when the operating-system account cannot read a file",
    async () => {
      const workspace = tempDirectory("ayati-permission-workspace-");
      const outside = tempDirectory("ayati-permission-outside-");
      const protectedFile = join(outside, "protected.txt");
      writeFileSync(protectedFile, "NEVER-RETURN-THIS-CONTENT\n", "utf-8");
      chmodSync(protectedFile, 0o000);
      const executor = createResourceScopedToolExecutor({
        base: createToolExecutor([readFilesTool]),
        contextEngine: serviceFor(unboundActiveContext("R-unbound")),
        workspaceRoot: workspace,
      });

      const result = await executor.execute("read_files", {
        files: [{ path: protectedFile, mode: "full" }],
      }, executionContext("R-unbound", "call-protected-read"));

      expect(result.ok).toBe(false);
      expect(JSON.stringify(result.v2?.structuredContent)).not.toContain(
        "NEVER-RETURN-THIS-CONTENT",
      );
      expect(result.v2?.structuredContent).toMatchObject({
        results: [expect.objectContaining({
          requestedPath: protectedFile,
          ok: false,
        })],
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not treat a non-regular device as an ordinary readable file",
    async () => {
      const workspace = tempDirectory("ayati-device-workspace-");
      const executor = createResourceScopedToolExecutor({
        base: createToolExecutor([readFilesTool]),
        contextEngine: serviceFor(unboundActiveContext("R-unbound")),
        workspaceRoot: workspace,
      });

      const result = await executor.execute("read_files", {
        files: [{ path: "/dev/null", mode: "full" }],
      }, executionContext("R-unbound", "call-device-read"));

      expect(result.ok).toBe(false);
      expect(result.v2?.structuredContent).toMatchObject({
        results: [expect.objectContaining({
          requestedPath: "/dev/null",
          ok: false,
          code: "NOT_A_FILE",
        })],
      });
    },
  );

  it("rejects every direct external mutation before resource lookup or execution", async () => {
    const workspace = tempDirectory("ayati-mutation-workspace-");
    const outside = tempDirectory("ayati-mutation-outside-");
    const patchTarget = join(outside, "patch.txt");
    const moveSource = join(outside, "move-source.txt");
    const deleteTarget = join(outside, "delete.txt");
    writeFileSync(patchTarget, "before patch\n", "utf-8");
    writeFileSync(moveSource, "before move\n", "utf-8");
    writeFileSync(deleteTarget, "before delete\n", "utf-8");
    const service = serviceFor(boundActiveContext([
      binding("RES-EXTERNAL", outside),
    ]));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([
        writeFilesTool,
        patchFilesTool,
        createDirectoryTool,
        moveTool,
        deleteTool,
      ]),
      contextEngine: service,
      workspaceRoot: workspace,
    });
    const calls = [
      {
        tool: "write_files",
        input: {
          files: [{ path: join(outside, "written.txt"), content: "must not exist" }],
          allowExternalPath: true,
        },
      },
      {
        tool: "patch_files",
        input: {
          files: [{
            path: patchTarget,
            patches: [{ kind: "replace_text", find: "before", replace: "after" }],
          }],
        },
      },
      {
        tool: "create_directory",
        input: { path: join(outside, "created"), recursive: true },
      },
      {
        tool: "move",
        input: {
          source: moveSource,
          destination: join(outside, "move-destination.txt"),
        },
      },
      {
        tool: "delete",
        input: { path: deleteTarget, recursive: false },
      },
    ];

    for (const [index, call] of calls.entries()) {
      const result = await executor.execute(
        call.tool,
        call.input,
        executionContext("R-1", `call-external-${index + 1}`),
      );
      expect(result.ok, call.tool).toBe(false);
      expect(result.v2?.code, call.tool).toBe("PATH_OUTSIDE_MUTATION_WORKSPACE");
      expect(result.v2?.error).toMatchObject({
        category: "permission",
        code: "PATH_OUTSIDE_MUTATION_WORKSPACE",
        retryable: false,
      });
    }

    expect(service.getAgentContext).not.toHaveBeenCalled();
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
    expect(existsSync(join(outside, "written.txt"))).toBe(false);
    expect(existsSync(join(outside, "created"))).toBe(false);
    expect(readFileSync(patchTarget, "utf-8")).toBe("before patch\n");
    expect(readFileSync(moveSource, "utf-8")).toBe("before move\n");
    expect(existsSync(join(outside, "move-destination.txt"))).toBe(false);
    expect(readFileSync(deleteTarget, "utf-8")).toBe("before delete\n");
  });

  it("enforces mutation policy and binding even when execution context is absent", async () => {
    const workspace = tempDirectory("ayati-contextless-workspace-");
    const outside = tempDirectory("ayati-contextless-outside-");
    const execute = vi.fn(async () => ({ ok: true, output: "should not run" }));
    const service = serviceFor(unboundActiveContext("R-unbound"));
    const executor = createResourceScopedToolExecutor({
      base: baseExecutor(execute, ["write_files"]),
      contextEngine: service,
      workspaceRoot: workspace,
    });

    const external = await executor.execute("write_files", {
      files: [{ path: join(outside, "external.txt"), content: "denied" }],
    });
    const unboundWorkspace = await executor.execute("write_files", {
      files: [{ path: join(workspace, "inside.txt"), content: "denied" }],
    });

    expect(external.v2?.code).toBe("PATH_OUTSIDE_MUTATION_WORKSPACE");
    expect(unboundWorkspace.v2?.code).toBe(
      "R_MUTATION_REQUIRES_WORKSTREAM_BINDING",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(service.getAgentContext).not.toHaveBeenCalled();
    expect(existsSync(join(outside, "external.txt"))).toBe(false);
    expect(existsSync(join(workspace, "inside.txt"))).toBe(false);
  });

  it("rejects a move that crosses the workspace boundary in either direction", async () => {
    const workspace = tempDirectory("ayati-move-workspace-");
    const outside = tempDirectory("ayati-move-outside-");
    const insideSource = join(workspace, "inside-source.txt");
    const outsideSource = join(outside, "outside-source.txt");
    writeFileSync(insideSource, "inside\n", "utf-8");
    writeFileSync(outsideSource, "outside\n", "utf-8");
    const service = serviceFor(boundActiveContext([
      binding("RES-WORKSPACE", workspace),
    ]));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([moveTool]),
      contextEngine: service,
      workspaceRoot: workspace,
    });

    const outResult = await executor.execute("move", {
      source: insideSource,
      destination: join(outside, "from-inside.txt"),
    }, executionContext("R-1", "call-move-out"));
    const inResult = await executor.execute("move", {
      source: outsideSource,
      destination: join(workspace, "from-outside.txt"),
    }, executionContext("R-1", "call-move-in"));

    expect(outResult.v2?.code).toBe("PATH_OUTSIDE_MUTATION_WORKSPACE");
    expect(inResult.v2?.code).toBe("PATH_OUTSIDE_MUTATION_WORKSPACE");
    expect(readFileSync(insideSource, "utf-8")).toBe("inside\n");
    expect(readFileSync(outsideSource, "utf-8")).toBe("outside\n");
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
  });

  it("rejects mutation before workstream binding without preparing an operation", async () => {
    const workspace = tempDirectory("ayati-unbound-workspace-");
    const service = serviceFor(unboundActiveContext("R-unbound"));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([writeFilesTool]),
      contextEngine: service,
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

  it("does not apply filesystem resource scope to a context-domain tool", async () => {
    const runtime = new HotContextRuntime({
      sources: [
        createPersonalMemoryHotContextSource({
          getSnapshot: () => "The user prefers concise answers.",
        }),
      ],
    });
    const contextTool = createContextSkill({ hotContextRuntime: runtime }).tools[0]!;
    const service = serviceFor(boundActiveContext([]));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([contextTool]),
      contextEngine: service,
    });

    const result = await executor.execute(
      "context_load",
      { keys: ["personal.memory"] },
      executionContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.v2?.code).toBe("HOT_CONTEXT_LOADED");
    expect(service.getAgentContext).not.toHaveBeenCalled();
  });

  it("uses the exact primary bound resource path", async () => {
    const workspace = tempDirectory("ayati-workspace-");
    const site = tempDirectory("ayati-site-");
    writeFileSync(join(site, "index.html"), "ready\n", "utf-8");
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([listDirectoryTool]),
      contextEngine: serviceFor(boundActiveContext([binding("RES-SITE", site)])),
      workspaceRoot: workspace,
    });

    const result = await executor.execute("list_directory", {
      path: site,
      recursive: false,
      showHidden: false,
    }, executionContext());

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({ dirPath: site });
  });

  it("allows a bound read to span machine files without resource admission", async () => {
    const workspace = tempDirectory("ayati-workspace-");
    const first = tempDirectory("ayati-resource-one-");
    const second = tempDirectory("ayati-resource-two-");
    const one = join(first, "one.txt");
    const two = join(second, "two.txt");
    writeFileSync(one, "one\n", "utf-8");
    writeFileSync(two, "two\n", "utf-8");
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([readFilesTool]),
      contextEngine: serviceFor(boundActiveContext([
        binding("RES-ONE", first),
      ])),
      workspaceRoot: workspace,
    });

    const result = await executor.execute("read_files", {
      files: [
        { path: one, mode: "full" },
        { path: two, mode: "full" },
      ],
    }, executionContext());

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      results: [
        expect.objectContaining({ filePath: one, content: "one\n" }),
        expect.objectContaining({ filePath: two, content: "two\n" }),
      ],
    });
  });

  it("denies mutation through a read-only resource binding", async () => {
    const workspace = tempDirectory("ayati-read-only-workspace-");
    const site = directoryInside(workspace, "site");
    const service = serviceFor(boundActiveContext([
      binding("RES-SITE", site, { access: "read" }),
    ]));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([writeFilesTool]),
      contextEngine: service,
      workspaceRoot: workspace,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: join(site, "index.html"), content: "denied" }],
    }, executionContext());

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("WORKSTREAM_RESOURCE_MUTATION_DENIED");
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
  });

  it("creates a project and files inside a selected absolute destination without pre-registering resources", async () => {
    const workspace = tempDirectory("ayati-simple-mutation-workspace-");
    const externalParent = tempDirectory("ayati-simple-mutation-external-");
    const site = join(externalParent, "lumen-finch");
    const service = serviceFor(boundActiveContext([]));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([createDirectoryTool, writeFilesTool]),
      contextEngine: service,
      workspaceRoot: workspace,
    });
    const context = {
      ...executionContext("R-1", "call-create-site"),
      filesystemMutationRoots: [site],
    };

    const written = await executor.execute("write_files", {
      files: [
        { path: join(site, "index.html"), content: "<h1>Lumen Finch</h1>\n" },
        { path: join(site, "styles.css"), content: "body { color: navy; }\n" },
        { path: join(site, "script.js"), content: "console.log(\"ready\");\n" },
      ],
      createParents: true,
    }, {
      ...context,
      callId: "call-write-site",
    });

    expect(written, JSON.stringify(written)).toMatchObject({ ok: true });
    expect(readFileSync(join(site, "index.html"), "utf-8")).toContain("Lumen Finch");
    expect(readFileSync(join(site, "styles.css"), "utf-8")).toContain("navy");
    expect(readFileSync(join(site, "script.js"), "utf-8")).toContain("ready");
    expect(written.meta?.["filesystemMutationVerification"]).toMatchObject({
      strategy: "target_local",
      verified: true,
      targetCount: 3,
    });
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
    expect(service.verifyResourceMutation).not.toHaveBeenCalled();
  });

  it("moves and deletes inside a selected root with target-local verification", async () => {
    const workspace = tempDirectory("ayati-targeted-move-workspace-");
    const site = directoryInside(workspace, "site");
    const source = join(site, "before.txt");
    const destination = join(site, "after.txt");
    const deleteTarget = join(site, "delete.txt");
    writeFileSync(source, "move me\n", "utf-8");
    writeFileSync(deleteTarget, "delete me\n", "utf-8");
    const service = serviceFor(boundActiveContext([]));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([moveTool, deleteTool]),
      contextEngine: service,
      workspaceRoot: workspace,
    });
    const context = {
      ...executionContext("R-1", "call-move"),
      filesystemMutationRoots: [site],
    };

    const moved = await executor.execute("move", {
      source,
      destination,
      overwrite: false,
    }, context);
    const deleted = await executor.execute("delete", {
      path: deleteTarget,
      recursive: false,
    }, {
      ...context,
      callId: "call-delete",
    });

    expect(moved).toMatchObject({
      ok: true,
      meta: {
        filesystemMutationVerification: {
          strategy: "target_local",
          verified: true,
          targetCount: 2,
        },
      },
    });
    expect(deleted).toMatchObject({
      ok: true,
      meta: {
        filesystemMutationVerification: {
          strategy: "target_local",
          verified: true,
          targetCount: 1,
        },
      },
    });
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(destination, "utf-8")).toBe("move me\n");
    expect(existsSync(deleteTarget)).toBe(false);
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
    expect(service.verifyResourceMutation).not.toHaveBeenCalled();
  });

  it("copies from a read-only external source and sets permissions only inside the selected root", async () => {
    const workspace = tempDirectory("ayati-targeted-copy-workspace-");
    const outside = tempDirectory("ayati-targeted-copy-source-");
    const site = directoryInside(workspace, "site");
    const source = join(outside, "source.txt");
    const destination = join(site, "copied.txt");
    writeFileSync(source, "copy me\n", "utf-8");
    const service = serviceFor(boundActiveContext([]));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([copyTool, setPermissionsTool]),
      contextEngine: service,
      workspaceRoot: workspace,
    });
    const context = {
      ...executionContext("R-1", "call-copy"),
      filesystemMutationRoots: [site],
    };

    const copied = await executor.execute("copy", {
      source,
      destination,
    }, context);
    const permissions = await executor.execute("set_permissions", {
      files: [{ path: destination, mode: "640" }],
    }, {
      ...context,
      callId: "call-permissions",
    });

    expect(copied).toMatchObject({
      ok: true,
      meta: {
        filesystemMutationVerification: {
          verified: true,
          targetCount: 2,
        },
      },
    });
    expect(permissions).toMatchObject({
      ok: true,
      meta: {
        filesystemMutationVerification: {
          verified: true,
          targetCount: 1,
        },
      },
    });
    expect(readFileSync(source, "utf-8")).toBe("copy me\n");
    expect(readFileSync(destination, "utf-8")).toBe("copy me\n");
    expect(statSync(destination).mode & 0o777).toBe(0o640);
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
  });

  it("verifies selected-root calls from declared targets without scanning siblings", async () => {
    const workspace = tempDirectory("ayati-targeted-unexpected-workspace-");
    const site = directoryInside(workspace, "site");
    const target = join(site, "index.html");
    const unexpected = join(site, "unexpected.txt");
    const execute = vi.fn(async () => {
      writeFileSync(target, "<h1>Expected</h1>\n", "utf-8");
      writeFileSync(unexpected, "undeclared\n", "utf-8");
      return {
        ok: true,
        v2: {
          transportOk: true,
          operationStatus: "succeeded" as const,
          code: "FILES_APPLIED",
          message: "Files written.",
          structuredContent: {
            files: [{
              path: target,
              status: "created",
              sha256: createHash("sha256")
                .update("<h1>Expected</h1>\n", "utf8")
                .digest("hex"),
            }],
          },
        },
      };
    });
    const service = serviceFor(boundActiveContext([]));
    const executor = createResourceScopedToolExecutor({
      base: baseExecutor(execute, ["write_files"]),
      contextEngine: service,
      workspaceRoot: workspace,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: target, content: "<h1>Expected</h1>\n" }],
    }, {
      ...executionContext("R-1", "call-unexpected-write"),
      filesystemMutationRoots: [site],
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.code).toBe("FILES_APPLIED");
    expect(result.meta?.["filesystemMutationVerification"]).toMatchObject({
      strategy: "target_local",
      verified: true,
      unexpectedPaths: [],
      parentChangedPathCount: 0,
      gitChangedPathCount: 0,
    });
    expect(execute.mock.calls[0]?.[2]).toMatchObject({
      filesystemTargetPreconditions: [{
        path: target,
        expected: { kind: "missing" },
      }],
    });
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
  });

  it("resolves relative paths against the workspace and rejects paths outside the selected destination", async () => {
    const workspace = tempDirectory("ayati-simple-scope-workspace-");
    const site = directoryInside(workspace, "site");
    const sibling = directoryInside(workspace, "sibling");
    const execute = vi.fn(async () => ({ ok: true, output: "should not run" }));
    const service = serviceFor(boundActiveContext([]));
    const executor = createResourceScopedToolExecutor({
      base: baseExecutor(execute, ["write_files"]),
      contextEngine: service,
      workspaceRoot: workspace,
    });
    const context = {
      ...executionContext(),
      filesystemMutationRoots: [site],
    };

    const relativeResult = await executor.execute("write_files", {
      files: [{ path: "index.html", content: "invalid" }],
    }, context);
    const outsideResult = await executor.execute("write_files", {
      files: [{ path: join(sibling, "index.html"), content: "invalid" }],
    }, context);

    expect(relativeResult.v2?.code).toBe("PATH_OUTSIDE_SELECTED_MUTATION_ROOT");
    expect(outsideResult.v2?.code).toBe("PATH_OUTSIDE_SELECTED_MUTATION_ROOT");
    expect(execute).not.toHaveBeenCalled();
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
  });

  it("rejects duplicate canonical targets before selected-root execution", async () => {
    const workspace = tempDirectory("ayati-canonical-duplicate-workspace-");
    const site = directoryInside(workspace, "site");
    const real = directoryInside(site, "real");
    const alias = join(site, "alias");
    symlinkSync(real, alias, "dir");
    const execute = vi.fn(async () => ({ ok: true, output: "should not run" }));
    const service = serviceFor(boundActiveContext([]));
    const executor = createResourceScopedToolExecutor({
      base: baseExecutor(execute, ["write_files"]),
      contextEngine: service,
      workspaceRoot: workspace,
    });

    const result = await executor.execute("write_files", {
      files: [
        { path: join(real, "same.txt"), content: "first" },
        { path: join(alias, "same.txt"), content: "second" },
      ],
    }, {
      ...executionContext("R-1", "call-canonical-duplicate"),
      filesystemMutationRoots: [site],
    });

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("DUPLICATE_TARGET_PATH");
    expect(result.v2?.error).toMatchObject({
      category: "conflict",
      retryable: true,
      target: join(real, "same.txt"),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("prepares and verifies exact mutation targets for a bound resource", async () => {
    const workspace = tempDirectory("ayati-workspace-");
    const site = directoryInside(workspace, "site");
    const service = serviceFor(boundActiveContext([binding("RES-SITE", site)]));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([writeFilesTool]),
      contextEngine: service,
      workspaceRoot: workspace,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: join(site, "index.html"), content: "<h1>Aurora Coffee</h1>" }],
      createParents: true,
    }, executionContext());

    expect(result.ok).toBe(true);
    expect(readFileSync(join(site, "index.html"), "utf-8")).toContain("Aurora Coffee");
    expect(service.prepareResourceMutation).toHaveBeenCalledWith(expect.objectContaining({
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
    const workspace = tempDirectory("ayati-workspace-");
    const site = directoryInside(workspace, "site");
    const index = join(site, "index.html");
    const sibling = join(site, "private.txt");
    writeFileSync(index, "<h1>Orbit</h1>\n", "utf-8");
    writeFileSync(sibling, "not authorized\n", "utf-8");
    const service = serviceFor(boundActiveContext([
      binding("RES-INDEX", index, { kind: "file" }),
    ]));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([readFilesTool, patchFilesTool]),
      contextEngine: service,
      workspaceRoot: workspace,
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

  it("allows sibling reads without widening exact-file mutation authority", async () => {
    const workspace = tempDirectory("ayati-workspace-");
    const site = directoryInside(workspace, "site");
    const index = join(site, "index.html");
    const sibling = join(site, "private.txt");
    writeFileSync(index, "<h1>Orbit</h1>\n", "utf-8");
    writeFileSync(sibling, "not authorized\n", "utf-8");
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([readFilesTool]),
      contextEngine: serviceFor(boundActiveContext([
        binding("RES-INDEX", index, { kind: "file" }),
      ])),
      workspaceRoot: workspace,
    });

    const result = await executor.execute("read_files", {
      files: [{ path: sibling, mode: "full" }],
    }, executionContext("R-1", "call-read-sibling"));

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toMatchObject({
      results: [expect.objectContaining({
        filePath: sibling,
        content: "not authorized\n",
      })],
    });
  });

  it("fails the call when post-mutation verification requires recovery", async () => {
    const workspace = tempDirectory("ayati-workspace-");
    const site = directoryInside(workspace, "site");
    const service = serviceFor(boundActiveContext([binding("RES-SITE", site)]), {
      verified: false,
      status: "recovery_required",
    });
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([writeFilesTool]),
      contextEngine: service,
      workspaceRoot: workspace,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: join(site, "index.html"), content: "written but uncertain" }],
    }, executionContext());

    expect(result.ok).toBe(false);
    expect(result.error).toContain("requires recovery");
  });

  it("resolves workspace-relative mutation paths before authority checks", async () => {
    const workspace = tempDirectory("ayati-workspace-");
    const site = directoryInside(workspace, "site");
    const target = join(site, "nested", "index.html");
    const execute = vi.fn(async () => ({ ok: true, output: "written" }));
    const service = serviceFor(boundActiveContext([binding("RES-SITE", site)]));
    const executor = createResourceScopedToolExecutor({
      base: baseExecutor(execute, ["write_files"]),
      contextEngine: service,
      workspaceRoot: workspace,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: "site/nested/index.html", content: "valid" }],
    }, executionContext());

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      "write_files",
      { files: [{ path: target, content: "valid" }] },
      expect.objectContaining({
        resourceScope: expect.objectContaining({
          resourceId: "RES-SITE",
          authorityPath: site,
        }),
      }),
    );
    expect(service.prepareResourceMutation).toHaveBeenCalledOnce();
  });

  it("rejects workspace-relative mutation paths that escape the workspace", async () => {
    const workspace = tempDirectory("ayati-workspace-");
    const site = directoryInside(workspace, "site");
    const execute = vi.fn(async () => ({ ok: true, output: "should not run" }));
    const service = serviceFor(boundActiveContext([binding("RES-SITE", site)]));
    const executor = createResourceScopedToolExecutor({
      base: baseExecutor(execute, ["write_files"]),
      contextEngine: service,
      workspaceRoot: workspace,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: "../outside.txt", content: "invalid" }],
    }, executionContext());

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATH_OUTSIDE_MUTATION_WORKSPACE");
    expect(execute).not.toHaveBeenCalled();
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
  });

  it("rejects a canonical path that escapes through a symlink", async () => {
    const workspace = tempDirectory("ayati-workspace-");
    const site = directoryInside(workspace, "site");
    const outside = tempDirectory("ayati-outside-");
    symlinkSync(outside, join(site, "linked-outside"), "dir");
    const execute = vi.fn(async () => ({ ok: true, output: "should not run" }));
    const service = serviceFor(boundActiveContext([binding("RES-SITE", site)]));
    const executor = createResourceScopedToolExecutor({
      base: baseExecutor(execute, ["write_files"]),
      contextEngine: service,
      workspaceRoot: workspace,
    });

    const result = await executor.execute("write_files", {
      files: [{ path: join(site, "linked-outside", "escaped.txt"), content: "invalid" }],
    }, executionContext());

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATH_OUTSIDE_MUTATION_WORKSPACE");
    expect(execute).not.toHaveBeenCalled();
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
    expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
  });

  it("rejects external process, Python, database, and dataset mutation effects", async () => {
    const workspace = tempDirectory("ayati-effect-workspace-");
    const outside = tempDirectory("ayati-effect-outside-");
    const execute = vi.fn(async () => ({ ok: true, output: "should not run" }));
    const service = serviceFor(boundActiveContext([
      binding("RES-WORKSPACE", workspace),
    ]));
    const executor = createResourceScopedToolExecutor({
      base: baseExecutor(execute, [
        "process_run",
        "process_start",
        "python_execute",
        "db_execute_sql",
        "dataset_promote_table",
      ]),
      contextEngine: service,
      workspaceRoot: workspace,
    });
    const calls = [
      {
        tool: "process_run",
        input: {
          executable: "pnpm",
          args: ["build"],
          cwd: outside,
          targets: [{ path: join(workspace, "dist"), kind: "directory" }],
        },
      },
      {
        tool: "process_start",
        input: {
          executable: "node",
          args: ["server.js"],
          cwd: outside,
        },
      },
      {
        tool: "python_execute",
        input: {
          mode: "code",
          code: "print('no execution')",
          cwd: outside,
          targets: [{ path: join(workspace, "chart.png"), kind: "file" }],
        },
      },
      {
        tool: "db_execute_sql",
        input: {
          dbPath: join(outside, "external.sqlite"),
          sql: "CREATE TABLE forbidden(id INTEGER)",
        },
      },
      {
        tool: "dataset_promote_table",
        input: {
          targetDbPath: join(outside, "promoted.sqlite"),
          targetTable: "forbidden",
        },
      },
    ];

    for (const [index, call] of calls.entries()) {
      const result = await executor.execute(
        call.tool,
        call.input,
        executionContext("R-1", `call-effect-${index + 1}`),
      );
      expect(result.ok, call.tool).toBe(false);
      expect(result.v2?.code, call.tool).toBe("PATH_OUTSIDE_MUTATION_WORKSPACE");
    }

    expect(execute).not.toHaveBeenCalled();
    expect(service.getAgentContext).not.toHaveBeenCalled();
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
  });

  it("scopes process sessions without pretending their future writes are snapshot-verified", async () => {
    const workspace = tempDirectory("ayati-process-session-workspace-");
    const site = directoryInside(workspace, "site");
    const execute = vi.fn(async () => ({
      ok: true,
      v2: {
        transportOk: true,
        operationStatus: "succeeded" as const,
        code: "PROCESS_SESSION_ACTION_COMPLETE",
        message: "Process session action completed.",
      },
    }));
    const service = serviceFor(boundActiveContext([
      binding("RES-SITE", site),
    ]));
    const executor = createResourceScopedToolExecutor({
      base: baseExecutor(execute, ["process_start", "process_send_input"]),
      contextEngine: service,
      workspaceRoot: workspace,
    });

    const started = await executor.execute("process_start", {
      executable: "node",
      args: ["server.js"],
    }, executionContext("R-1", "call-session-start"));
    const sent = await executor.execute("process_send_input", {
      sessionId: "PROC-1",
      input: "continue\n",
    }, executionContext("R-1", "call-session-input"));

    expect(started.ok).toBe(true);
    expect(sent.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      "process_start",
      expect.objectContaining({ cwd: site }),
      expect.objectContaining({
        resourceScope: expect.objectContaining({
          authorityPath: site,
          resourceId: "RES-SITE",
        }),
      }),
    );
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
    expect(service.verifyResourceMutation).not.toHaveBeenCalled();
  });

  it("requires explicit targets for process mutations and scopes their cwd", async () => {
    const workspace = tempDirectory("ayati-workspace-");
    const site = directoryInside(workspace, "site");
    const execute = vi.fn(async () => ({ ok: true, output: "build complete" }));
    const service = serviceFor(boundActiveContext([binding("RES-SITE", site)]));
    const executor = createResourceScopedToolExecutor({
      base: baseExecutor(execute, ["process_run"]),
      contextEngine: service,
      workspaceRoot: workspace,
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

  it("rejects filesystem-effecting tools that omit an exact destination", async () => {
    const workspace = tempDirectory("ayati-target-workspace-");
    const execute = vi.fn(async () => ({ ok: true, output: "should not run" }));
    const service = serviceFor(boundActiveContext([
      binding("RES-WORKSPACE", workspace),
    ]));
    const executor = createResourceScopedToolExecutor({
      base: baseExecutor(execute, [
        "python_execute",
        "db_execute_sql",
        "dataset_promote_table",
        "file_fetch_url",
      ]),
      contextEngine: service,
      workspaceRoot: workspace,
    });
    const calls = [
      {
        tool: "python_execute",
        input: { mode: "code", code: "print('no execution')" },
      },
      {
        tool: "db_execute_sql",
        input: { sql: "CREATE TABLE forbidden(id INTEGER)" },
      },
      {
        tool: "dataset_promote_table",
        input: { targetTable: "forbidden" },
      },
      {
        tool: "file_fetch_url",
        input: { url: "https://example.invalid/file.txt" },
      },
    ];

    for (const [index, call] of calls.entries()) {
      const result = await executor.execute(
        call.tool,
        call.input,
        executionContext("R-1", `call-missing-target-${index + 1}`),
      );
      expect(result.ok, call.tool).toBe(false);
      expect(result.v2?.code, call.tool).toBe(
        "WORKSTREAM_RESOURCE_SCOPE_VIOLATION",
      );
    }

    expect(execute).not.toHaveBeenCalled();
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
  });

  it("can restore bound-resource mutation scope through operator configuration", async () => {
    const workspace = tempDirectory("ayati-policy-workspace-");
    const outside = tempDirectory("ayati-policy-external-");
    const service = serviceFor(boundActiveContext([
      binding("RES-EXTERNAL", outside),
    ]));
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([writeFilesTool]),
      contextEngine: service,
      workspaceRoot: workspace,
      filesystemAccess: {
        readScope: "machine",
        mutationScope: "bound_resource",
      },
    });
    const target = join(outside, "configured.txt");

    const result = await executor.execute("write_files", {
      files: [{ path: target, content: "operator enabled\n" }],
      createParents: false,
    }, executionContext("R-1", "call-configured-external"));

    expect(result.ok).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("operator enabled\n");
    expect(service.prepareResourceMutation).toHaveBeenCalledOnce();
  });
});

function tempDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function directoryInside(parent: string, name: string): string {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
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
    getAgentContext: vi.fn(async () => activeContext),
    prepareResourceMutation: vi.fn(async () => ({
      operationId: "OP-1",
      leaseId: "LEASE-1",
      lockToken: "LOCK-1",
    })),
    verifyResourceMutation: vi.fn(async () => verification),
  } as unknown as ContextEngineService & {
    getAgentContext: ReturnType<typeof vi.fn>;
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
        streamId: "S-1",
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
