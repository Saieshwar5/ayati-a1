import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import type { ContextEngineService } from "ayati-context-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareFilesystemMutationVerification,
  verifyFilesystemMutation,
} from "../../src/app/filesystem-mutation-verifier.js";
import { createResourceScopedToolExecutor } from "../../src/app/resource-scoped-tool-executor.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { processRunTool } from "../../src/skills/builtins/process/index.js";
import { createToolExecutor, type ToolExecutor } from "../../src/skills/tool-executor.js";
import type { ToolResult } from "../../src/skills/types.js";

const NOW = "2026-07-31T10:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("same-run process validation", () => {
  it("validates a newly created file inside the exact current-run scope", async () => {
    const workspace = temporaryDirectory("ayati-process-workspace-");
    const site = join(workspace, "riverstone-cafe");
    const script = join(site, "script.js");
    const service = contextEngineForEmptyWorkstream();
    const executor = createResourceScopedToolExecutor({
      base: createToolExecutor([writeFilesTool, processRunTool]),
      contextEngine: service,
      workspaceRoot: workspace,
    });
    const context = executionContext([site]);

    const written = await executor.execute("write_files", {
      files: [{ path: script, content: "console.log(\"ready\");\n" }],
      createParents: true,
    }, context);

    const result = await executor.execute("process_run", {
      executable: execPath,
      args: ["--check", script],
      cwd: site,
      targets: [{ path: script, kind: "file" }],
    }, {
      ...context,
      callId: "call-2",
      stepNumber: 2,
    });

    expect(written.ok).toBe(true);
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      v2: {
        code: "COMMAND_SUCCEEDED",
        structuredContent: {
          cwd: site,
          exitCode: 0,
        },
      },
      meta: {
        filesystemMutationVerification: {
          strategy: "target_local",
          verified: true,
          toolName: "process_run",
          targetCount: 1,
          targets: [{
            path: script,
            role: "process_target",
            before: "file",
            after: "file",
          }],
        },
      },
    });
    expect(service.prepareResourceMutation).not.toHaveBeenCalled();
    expect(service.verifyResourceMutation).not.toHaveBeenCalled();
  });

  it("does not run a current-scope process without exact targets", async () => {
    const workspace = temporaryDirectory("ayati-process-workspace-");
    const site = join(workspace, "riverstone-cafe");
    mkdirSync(site);
    const execute = vi.fn(async (): Promise<ToolResult> => ({
      ok: true,
      output: "must not run",
    }));
    const executor = createResourceScopedToolExecutor({
      base: stubExecutor(execute),
      contextEngine: contextEngineForEmptyWorkstream(),
      workspaceRoot: workspace,
    });

    const result = await executor.execute("process_run", {
      executable: execPath,
      args: ["--version"],
      cwd: site,
    }, executionContext([site]));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("WORKSTREAM_RESOURCE_SCOPE_VIOLATION");
    expect(result.v2?.message).toContain("must declare exact");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a process target outside the selected current-run scope", async () => {
    const workspace = temporaryDirectory("ayati-process-workspace-");
    const site = join(workspace, "riverstone-cafe");
    const sibling = join(workspace, "other-project");
    mkdirSync(site);
    mkdirSync(sibling);
    const execute = vi.fn(async (): Promise<ToolResult> => ({
      ok: true,
      output: "must not run",
    }));
    const executor = createResourceScopedToolExecutor({
      base: stubExecutor(execute),
      contextEngine: contextEngineForEmptyWorkstream(),
      workspaceRoot: workspace,
    });

    const result = await executor.execute("process_run", {
      executable: execPath,
      args: ["--check", join(sibling, "script.js")],
      cwd: site,
      targets: [{ path: join(sibling, "script.js"), kind: "file" }],
    }, executionContext([site]));

    expect(result.ok).toBe(false);
    expect(result.v2?.code).toBe("PATH_OUTSIDE_SELECTED_MUTATION_ROOT");
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts successful no-change validation of a declared target", async () => {
    const project = temporaryDirectory("ayati-process-verifier-");
    const script = join(project, "script.js");
    writeFileSync(script, "console.log(\"valid\");\n", "utf8");
    const prepared = await prepareFilesystemMutationVerification("process_run", {
      targets: [{ path: script, kind: "file" }],
    });

    const verification = await verifyFilesystemMutation(
      prepared!,
      successfulProcessResult(),
    );

    expect(verification).toMatchObject({
      verified: true,
      toolSucceeded: true,
      targets: [{
        path: script,
        role: "process_target",
        before: "file",
        after: "file",
      }],
    });
  });

  it("rejects target changes left behind by a failed process", async () => {
    const project = temporaryDirectory("ayati-process-verifier-");
    const script = join(project, "script.js");
    writeFileSync(script, "console.log(\"before\");\n", "utf8");
    const prepared = await prepareFilesystemMutationVerification("process_run", {
      targets: [{ path: script, kind: "file" }],
    });
    writeFileSync(script, "console.log(\"changed before failure\");\n", "utf8");

    const verification = await verifyFilesystemMutation(
      prepared!,
      failedProcessResult(),
    );

    expect(verification.verified).toBe(false);
    expect(verification.problems).toEqual([
      `Failed process changed target state: ${script}.`,
    ]);
  });
});

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
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

function stubExecutor(
  execute: ReturnType<typeof vi.fn>,
): ToolExecutor {
  return {
    list: () => ["process_run"],
    definitions: () => [processRunTool],
    validate: () => ({ valid: true }),
    execute,
  };
}

function contextEngineForEmptyWorkstream() {
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
    prepareResourceMutation: vi.fn(),
    verifyResourceMutation: vi.fn(),
  } as unknown as ContextEngineService & {
    prepareResourceMutation: ReturnType<typeof vi.fn>;
    verifyResourceMutation: ReturnType<typeof vi.fn>;
  };
}

function successfulProcessResult(): ToolResult {
  return {
    ok: true,
    v2: {
      transportOk: true,
      operationStatus: "succeeded",
      code: "COMMAND_SUCCEEDED",
      message: "Command exited with code 0.",
    },
  };
}

function failedProcessResult(): ToolResult {
  return {
    ok: false,
    error: "Process exited with code 1.",
    v2: {
      transportOk: true,
      operationStatus: "failed",
      code: "COMMAND_FAILED",
      message: "Process exited with code 1.",
    },
  };
}
