import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextEngineService } from "ayati-context-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createResourceScopedToolExecutor } from "../../src/app/resource-scoped-tool-executor.js";
import { patchFilesTool } from "../../src/skills/builtins/filesystem/patch-files.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";

const NOW = "2026-07-31T10:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("multi-root file mutation", () => {
  it("patches two exact mutable file roots in one verified call", async () => {
    const workspace = tempDirectory();
    const site = join(workspace, "riverstone-cafe");
    mkdirSync(site, { recursive: true });
    const indexPath = join(site, "index.html");
    const stylesPath = join(site, "styles.css");
    writeFileSync(indexPath, "<main>Visit</main>\n", "utf8");
    writeFileSync(stylesPath, ".cards { display: grid; }\n", "utf8");
    const executor = executorFor(workspace);

    const result = await executor.execute("patch_files", {
      files: [
        {
          path: indexPath,
          patches: [{
            kind: "replace_text",
            find: "<main>Visit</main>",
            replace: "<main>Testimonials</main>",
          }],
        },
        {
          path: stylesPath,
          patches: [{
            kind: "replace_text",
            find: ".cards { display: grid; }",
            replace: ".cards { display: flex; }",
          }],
        },
      ],
    }, executionContext([indexPath, stylesPath]));

    expect(result.ok).toBe(true);
    expect(readFileSync(indexPath, "utf8")).toBe("<main>Testimonials</main>\n");
    expect(readFileSync(stylesPath, "utf8")).toBe(".cards { display: flex; }\n");
    expect(result.meta?.["filesystemMutationVerification"]).toMatchObject({
      strategy: "target_local",
      verified: true,
    });
  });

  it("writes two exact creation roots in one verified call", async () => {
    const workspace = tempDirectory();
    const site = join(workspace, "riverstone-cafe");
    mkdirSync(site, { recursive: true });
    const indexPath = join(site, "index.html");
    const stylesPath = join(site, "styles.css");
    const executor = executorFor(workspace);

    const result = await executor.execute("write_files", {
      files: [
        { path: indexPath, content: "<main>Riverstone</main>\n" },
        { path: stylesPath, content: "body { color: green; }\n" },
      ],
      createParents: false,
    }, executionContext([indexPath, stylesPath]));

    expect(result.ok).toBe(true);
    expect(readFileSync(indexPath, "utf8")).toBe("<main>Riverstone</main>\n");
    expect(readFileSync(stylesPath, "utf8")).toBe("body { color: green; }\n");
    expect(result.meta?.["filesystemMutationVerification"]).toMatchObject({
      strategy: "target_local",
      verified: true,
    });
  });

  it("rejects the complete batch before mutation when one target has no selected root", async () => {
    const workspace = tempDirectory();
    const site = join(workspace, "riverstone-cafe");
    mkdirSync(site, { recursive: true });
    const indexPath = join(site, "index.html");
    const stylesPath = join(site, "styles.css");
    const unauthorizedPath = join(site, "secret.txt");
    writeFileSync(indexPath, "original index\n", "utf8");
    writeFileSync(stylesPath, "original styles\n", "utf8");
    writeFileSync(unauthorizedPath, "keep secret\n", "utf8");
    const executor = executorFor(workspace);

    const result = await executor.execute("patch_files", {
      files: [
        {
          path: indexPath,
          patches: [{
            kind: "replace_text",
            find: "original index",
            replace: "changed index",
          }],
        },
        {
          path: unauthorizedPath,
          patches: [{
            kind: "replace_text",
            find: "keep secret",
            replace: "changed secret",
          }],
        },
      ],
    }, executionContext([indexPath, stylesPath]));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATH_OUTSIDE_SELECTED_MUTATION_ROOT");
    expect(readFileSync(indexPath, "utf8")).toBe("original index\n");
    expect(readFileSync(unauthorizedPath, "utf8")).toBe("keep secret\n");
  });
});

function tempDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "ayati-multi-root-mutation-"));
  temporaryDirectories.push(path);
  return path;
}

function executorFor(workspaceRoot: string) {
  return createResourceScopedToolExecutor({
    base: createToolExecutor([patchFilesTool, writeFilesTool]),
    contextEngine: contextEngine(),
    workspaceRoot,
  });
}

function executionContext(filesystemMutationRoots: string[]) {
  return {
    clientId: "client-1",
    sessionId: "S-1",
    runId: "RUN-1",
    stepNumber: 1,
    callId: "call-1",
    filesystemMutationRoots,
  };
}

function contextEngine(): ContextEngineService {
  return {
    getAgentContext: vi.fn(async () => ({
      run: {
        run: {
          runId: "RUN-1",
          streamId: "S-1",
          workstreamBinding: {
            workstreamId: "W-1",
            requestId: "R-0001",
            boundAt: NOW,
          },
        },
      },
      activeWorkstream: {
        workstream: { workstreamId: "W-1" },
        resources: [],
      },
      ingressResources: [],
    })),
  } as unknown as ContextEngineService;
}
