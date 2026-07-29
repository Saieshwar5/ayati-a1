import { rename } from "node:fs/promises";
import type {
  FilesystemTargetState,
  ToolErrorCategory,
  ToolExecutionContext,
} from "../../types.js";
import {
  classifyPatchFilesystemError,
  cleanupPatchTemporaryFiles,
  MAX_PATCH_TARGET_BYTES,
  MAX_PATCH_TOTAL_TARGET_BYTES,
  observePatchTargetState,
  observePatchTextFile,
  patchPreconditionMap,
  requirePatchTempPath,
  resolvePatchTargets,
  sameFilesystemTargetState,
  sha256PatchContent,
  stagePatchTarget,
  summarizeFilesystemTargetState,
  targetsForPatchFailure,
  type ObservedTextFile,
  type PatchOperationIssue,
  type PreparedPatchTarget,
  type ResolvedPatchTarget,
} from "./patch-file-io.js";
import {
  applyPatches,
  type PatchApplicationFailure,
} from "./patch-text.js";
import type {
  PatchFileResult,
  PatchFilesInput,
  PatchFilesResult,
} from "./types.js";

export {
  classifyPatchFilesystemError,
  MAX_PATCH_TARGET_BYTES,
  MAX_PATCH_TOTAL_TARGET_BYTES,
} from "./patch-file-io.js";

export interface PatchFilesOperationSuccess {
  ok: true;
  result: PatchFilesResult;
}

export interface PatchFilesOperationFailure {
  ok: false;
  code: string;
  message: string;
  category: ToolErrorCategory;
  retryable: boolean;
  recoverable: boolean;
  target?: string;
  expected?: unknown;
  actual?: unknown;
  patchIndex?: number;
  patchKind?: PatchFilesInput["files"][number]["patches"][number]["kind"];
  diagnostic?: unknown;
  suggestedNextActions: string[];
  errnoCode?: string;
  result: PatchFilesResult;
}

export type PatchFilesOperationResult =
  | PatchFilesOperationSuccess
  | PatchFilesOperationFailure;

export async function executePatchFilesOperation(
  input: PatchFilesInput,
  context?: ToolExecutionContext,
): Promise<PatchFilesOperationResult> {
  const resolution = await resolvePatchTargets(input, context);
  if (!resolution.ok) {
    return issueFailure(
      targetsForPatchFailure(input),
      [],
      resolution.issue,
    );
  }

  const targets = resolution.targets;
  const preconditions = patchPreconditionMap(
    context?.filesystemTargetPreconditions,
  );
  const prepared: PreparedPatchTarget[] = [];
  let totalSourceBytes = 0;
  let totalOutputBytes = 0;

  for (const target of targets) {
    let observed: ObservedTextFile;
    try {
      const observation = await observePatchTextFile(target.path);
      if (!observation.ok) {
        return issueFailure(targets, prepared, observation.issue);
      }
      observed = observation.value;
    } catch (error) {
      return issueFailure(
        targets,
        prepared,
        classifyPatchFilesystemError(error, target.path),
      );
    }

    totalSourceBytes += observed.state.sizeBytes;
    if (totalSourceBytes > MAX_PATCH_TOTAL_TARGET_BYTES) {
      return operationFailure({
        targets,
        prepared,
        code: "PATCH_TOTAL_TARGET_BYTES_EXCEEDED",
        message: `Patch targets contain more than ${MAX_PATCH_TOTAL_TARGET_BYTES} bytes in total.`,
        category: "validation",
        target: target.path,
        retryable: false,
        actual: {
          totalSourceBytes,
          maximumBytes: MAX_PATCH_TOTAL_TARGET_BYTES,
        },
        suggestedNextActions: [
          "Split the patch into smaller calls or use a specialized large-file transformation tool.",
        ],
      });
    }

    const expected = preconditions.get(target.path) ?? observed.state;
    if (!sameFilesystemTargetState(expected, observed.state)) {
      return operationFailure({
        targets,
        prepared,
        code: "PATCH_CONFLICT",
        message: `Target changed before patch_files could apply its patch: ${target.path}`,
        category: "conflict",
        target: target.path,
        retryable: true,
        expected: summarizeFilesystemTargetState(expected),
        actual: summarizeFilesystemTargetState(observed.state),
        suggestedNextActions: [
          "Read the latest file content and build a new exact patch.",
        ],
      });
    }
    if (expected.kind !== "file") {
      return operationFailure({
        targets,
        prepared,
        code: expected.kind === "missing"
          ? "PATCH_FILE_NOT_FOUND"
          : "PATCH_TARGET_NOT_REGULAR_FILE",
        message: expected.kind === "missing"
          ? `Patch target does not exist: ${target.path}`
          : `Patch target must be a regular file; observed ${expected.kind}: ${target.path}`,
        category: expected.kind === "missing"
          ? "missing_path"
          : "semantic",
        target: target.path,
        retryable: expected.kind === "missing",
        actual: expected.kind,
        suggestedNextActions: [
          "Read or create the intended regular text file before retrying patch_files.",
        ],
      });
    }
    if (expected.linkCount > 1) {
      return operationFailure({
        targets,
        prepared,
        code: "PATCH_HARDLINK_UNSUPPORTED",
        message: `patch_files will not atomically replace a file with ${expected.linkCount} hard links: ${target.path}`,
        category: "semantic",
        target: target.path,
        retryable: false,
        actual: { linkCount: expected.linkCount },
        suggestedNextActions: [
          "Choose the canonical file to replace explicitly or use a hard-link-aware operation.",
        ],
      });
    }

    const applied = applyPatches(observed.content, target.patches);
    if (!applied.ok) {
      return patchApplicationFailure(
        targets,
        prepared,
        target,
        observed,
        applied,
      );
    }

    const sizeBytes = Buffer.byteLength(applied.content, "utf-8");
    if (sizeBytes > MAX_PATCH_TARGET_BYTES) {
      return operationFailure({
        targets,
        prepared,
        code: "PATCH_OUTPUT_TOO_LARGE",
        message: `Patched content exceeds the ${MAX_PATCH_TARGET_BYTES}-byte per-file limit: ${target.path}`,
        category: "validation",
        target: target.path,
        retryable: false,
        actual: { sizeBytes, maximumBytes: MAX_PATCH_TARGET_BYTES },
        suggestedNextActions: [
          "Split the edit or use a specialized large-file transformation tool.",
        ],
      });
    }
    totalOutputBytes += sizeBytes;
    if (totalOutputBytes > MAX_PATCH_TOTAL_TARGET_BYTES) {
      return operationFailure({
        targets,
        prepared,
        code: "PATCH_TOTAL_OUTPUT_BYTES_EXCEEDED",
        message: `Patched content exceeds the ${MAX_PATCH_TOTAL_TARGET_BYTES}-byte combined output limit.`,
        category: "validation",
        target: target.path,
        retryable: false,
        actual: {
          totalOutputBytes,
          maximumBytes: MAX_PATCH_TOTAL_TARGET_BYTES,
        },
        suggestedNextActions: ["Split the patch into smaller calls."],
      });
    }

    prepared.push({
      ...target,
      expected,
      content: applied.content,
      sizeBytes,
      sha256: sha256PatchContent(applied.content),
      patchesApplied: applied.patchesApplied,
      changesApplied: applied.changesApplied,
      checks: applied.checks,
    });
  }

  for (const target of prepared) {
    try {
      target.tempPath = await stagePatchTarget(target);
    } catch (error) {
      await cleanupPatchTemporaryFiles(prepared);
      return issueFailure(
        targets,
        prepared,
        classifyPatchFilesystemError(error, target.path),
      );
    }
  }

  for (const target of prepared) {
    let current: FilesystemTargetState;
    try {
      current = await observePatchTargetState(target.path);
    } catch (error) {
      await cleanupPatchTemporaryFiles(prepared);
      return issueFailure(
        targets,
        prepared,
        classifyPatchFilesystemError(error, target.path),
      );
    }
    if (!sameFilesystemTargetState(target.expected, current)) {
      await cleanupPatchTemporaryFiles(prepared);
      return operationFailure({
        targets,
        prepared,
        code: "PATCH_CONFLICT",
        message: `Target changed while patch_files was preparing its replacement: ${target.path}`,
        category: "conflict",
        target: target.path,
        retryable: true,
        expected: summarizeFilesystemTargetState(target.expected),
        actual: summarizeFilesystemTargetState(current),
        suggestedNextActions: [
          "Read the latest file content and build a new exact patch.",
        ],
      });
    }
  }

  const committed = new Map<string, PatchFileResult>();
  for (const target of prepared) {
    try {
      await rename(requirePatchTempPath(target), target.path);
      target.tempPath = undefined;
      committed.set(target.path, patchedFileResult(target));
    } catch (error) {
      await cleanupPatchTemporaryFiles(prepared);
      const issue = classifyPatchFilesystemError(error, target.path);
      return operationFailure({
        targets,
        prepared,
        committed,
        code: committed.size > 0 ? "PATCH_PARTIAL" : issue.code,
        message: committed.size > 0
          ? `${issue.message} (${committed.size}/${prepared.length} files were already committed)`
          : issue.message,
        category: committed.size > 0 ? "conflict" : issue.category,
        target: issue.target,
        retryable: committed.size > 0 ? false : issue.retryable,
        errnoCode: issue.errnoCode,
        suggestedNextActions: committed.size > 0
          ? [
              "Do not repeat the same multi-file patch automatically.",
              "Read the reported files, keep committed changes, and create a new patch only for remaining work.",
            ]
          : issue.suggestedNextActions,
      });
    }
  }

  return {
    ok: true,
    result: summarizeResults(
      targets.length,
      prepared.map(patchedFileResult),
    ),
  };
}

function patchApplicationFailure(
  targets: ResolvedPatchTarget[],
  prepared: PreparedPatchTarget[],
  target: ResolvedPatchTarget,
  observed: ObservedTextFile,
  failure: PatchApplicationFailure,
): PatchFilesOperationFailure {
  const failedTarget: PreparedPatchTarget = {
    ...target,
    expected: observed.state,
    content: observed.content,
    sizeBytes: observed.state.sizeBytes,
    sha256: observed.state.sha256,
    patchesApplied: 0,
    changesApplied: 0,
    checks: [],
  };
  return operationFailure({
    targets,
    prepared: [...prepared, failedTarget],
    code: failure.code,
    message: failure.message,
    category: "semantic",
    target: target.path,
    retryable: true,
    expected: failure.expected,
    actual: failure.actual,
    patchIndex: failure.patchIndex,
    patchKind: failure.kind,
    diagnostic: failure.diagnostic,
    suggestedNextActions: [
      failure.suggestedFix,
      "Use write_files when replacing the complete file is clearer.",
    ],
  });
}

function issueFailure(
  targets: ResolvedPatchTarget[],
  prepared: PreparedPatchTarget[],
  issue: PatchOperationIssue,
): PatchFilesOperationFailure {
  return operationFailure({
    targets,
    prepared,
    code: issue.code,
    message: issue.message,
    category: issue.category,
    target: issue.target,
    retryable: issue.retryable,
    actual: issue.actual,
    errnoCode: issue.errnoCode,
    suggestedNextActions: issue.suggestedNextActions,
  });
}

function operationFailure(input: {
  targets: ResolvedPatchTarget[];
  prepared: PreparedPatchTarget[];
  committed?: Map<string, PatchFileResult>;
  code: string;
  message: string;
  category: ToolErrorCategory;
  target?: string;
  retryable: boolean;
  expected?: unknown;
  actual?: unknown;
  patchIndex?: number;
  patchKind?: PatchFilesOperationFailure["patchKind"];
  diagnostic?: unknown;
  suggestedNextActions: string[];
  errnoCode?: string;
}): PatchFilesOperationFailure {
  const committed = input.committed ?? new Map<string, PatchFileResult>();
  const preparedByPath = new Map(
    input.prepared.map((target) => [target.path, target]),
  );
  const files = input.targets.map((target) => (
    committed.get(target.path)
    ?? failedFileResult(
      target,
      preparedByPath.get(target.path),
      input.code,
      input.message,
    )
  ));
  return {
    ok: false,
    code: input.code,
    message: input.message,
    category: input.category,
    retryable: input.retryable,
    recoverable: true,
    ...(input.target ? { target: input.target } : {}),
    ...(input.expected !== undefined ? { expected: input.expected } : {}),
    ...(input.actual !== undefined ? { actual: input.actual } : {}),
    ...(input.patchIndex !== undefined
      ? { patchIndex: input.patchIndex }
      : {}),
    ...(input.patchKind ? { patchKind: input.patchKind } : {}),
    ...(input.diagnostic !== undefined
      ? { diagnostic: input.diagnostic }
      : {}),
    suggestedNextActions: input.suggestedNextActions,
    ...(input.errnoCode ? { errnoCode: input.errnoCode } : {}),
    result: summarizeResults(input.targets.length, files),
  };
}

function patchedFileResult(
  target: PreparedPatchTarget,
): PatchFileResult {
  return {
    requestedPath: target.requestedPath,
    filePath: target.path,
    status: "patched",
    patchesApplied: target.patchesApplied,
    changesApplied: target.changesApplied,
    bytesWritten: target.sizeBytes,
    sha256: target.sha256,
    checks: target.checks,
  };
}

function failedFileResult(
  target: ResolvedPatchTarget,
  prepared: PreparedPatchTarget | undefined,
  code: string,
  message: string,
): PatchFileResult {
  return {
    requestedPath: target.requestedPath,
    filePath: target.path,
    status: "failed",
    patchesApplied: 0,
    changesApplied: 0,
    bytesWritten: 0,
    ...(prepared ? { sha256: prepared.sha256 } : {}),
    checks: [],
    errorCode: code,
    errorMessage: message,
  };
}

function summarizeResults(
  filesRequested: number,
  files: PatchFileResult[],
): PatchFilesResult {
  const patched = files.filter((file) => file.status === "patched");
  return {
    filesRequested,
    filesPatched: patched.length,
    filesFailed: files.filter((file) => file.status === "failed").length,
    patchesApplied: patched.reduce(
      (sum, file) => sum + file.patchesApplied,
      0,
    ),
    changesApplied: patched.reduce(
      (sum, file) => sum + file.changesApplied,
      0,
    ),
    totalBytes: patched.reduce(
      (sum, file) => sum + file.bytesWritten,
      0,
    ),
    files,
  };
}
