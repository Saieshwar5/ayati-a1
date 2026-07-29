import { filesystemPathIsWithin } from "../../../shared/filesystem-paths.js";
import {
  filesystemPreconditionMap,
  observeFilesystemTarget,
  sameFilesystemTargetState,
  summarizeFilesystemTargetState,
} from "../../../shared/filesystem-target-state.js";
import type {
  ArtifactRef,
  ToolExecutionContext,
  ToolResult,
  ToolStructuredError,
} from "../../types.js";
import {
  cleanupStagedPathCopy,
  commitStagedPathCopy,
  CopyPathOperationError,
  fingerprintPath,
  stageVerifiedPathCopy,
  type PathFingerprint,
  type StagedPathCopy,
} from "./copy-path-operation.js";
import {
  classifyFilesystemOperationError,
  ensureOperationParent,
  resolveContainedMutationPath,
  resolveReadableSourcePath,
  type FilesystemOperationIssue,
} from "./path-operation-helpers.js";
import type { CopyInput, CopyResult } from "./types.js";

export async function executeCopyOperation(
  input: CopyInput,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  const start = Date.now();
  const source = await resolveReadableSourcePath(input.source);
  const destinationResolution = await resolveContainedMutationPath(
    input.destination,
    context,
    "copy",
  );
  if (!destinationResolution.ok) {
    return failureResult(
      emptyCopyResult(input, source, input.destination, destinationResolution.issue),
      destinationResolution.issue,
      start,
    );
  }
  const destination = destinationResolution.path;
  if (source === destination) {
    return semanticFailure(
      input,
      source,
      destination,
      "COPY_INVALID_RELATIONSHIP",
      "Copy source and destination resolve to the same path.",
      start,
    );
  }

  const preconditions = filesystemPreconditionMap(
    context?.filesystemTargetPreconditions,
  );
  const expectedSource = preconditions.get(source)
    ?? await observeFilesystemTarget(source);
  const expectedDestination = preconditions.get(destination)
    ?? await observeFilesystemTarget(destination);
  if (expectedSource.kind === "missing") {
    return semanticFailure(
      input,
      source,
      destination,
      "COPY_SOURCE_NOT_FOUND",
      `Copy source does not exist: ${source}`,
      start,
      "missing_path",
      true,
    );
  }
  if (expectedSource.kind === "other") {
    return semanticFailure(
      input,
      source,
      destination,
      "COPY_UNSUPPORTED_SOURCE_KIND",
      `Copy source must be a file, directory, or symbolic link: ${source}`,
      start,
    );
  }
  if (expectedDestination.kind !== "missing") {
    return semanticFailure(
      input,
      source,
      destination,
      "COPY_DESTINATION_EXISTS",
      `Copy destination already exists: ${destination}`,
      start,
      "conflict",
      true,
    );
  }
  if (
    expectedSource.kind === "directory"
    && filesystemPathIsWithin(source, destination)
  ) {
    return semanticFailure(
      input,
      source,
      destination,
      "COPY_INVALID_RELATIONSHIP",
      `A directory cannot be copied inside itself: ${destination}`,
      start,
    );
  }

  const currentSource = await observeFilesystemTarget(source);
  const currentDestination = await observeFilesystemTarget(destination);
  if (
    !sameFilesystemTargetState(expectedSource, currentSource)
    || !sameFilesystemTargetState(expectedDestination, currentDestination)
  ) {
    return conflictFailure(
      input,
      source,
      destination,
      expectedSource,
      currentSource,
      expectedDestination,
      currentDestination,
      start,
    );
  }

  const parent = await ensureOperationParent(
    destination,
    input.createParents !== false,
    "COPY",
  );
  if (!parent.ok) {
    return failureResult(
      emptyCopyResult(
        input,
        source,
        destination,
        parent.issue,
        parent.createdPaths,
      ),
      parent.issue,
      start,
    );
  }

  let staged: StagedPathCopy | undefined;
  let committedFingerprint: PathFingerprint | undefined;
  try {
    staged = await stageVerifiedPathCopy(source, destination, "COPY");
    const beforeCommit = await observeFilesystemTarget(destination);
    if (!sameFilesystemTargetState(expectedDestination, beforeCommit)) {
      const issue = conflictIssue(
        destination,
        expectedDestination,
        beforeCommit,
      );
      await cleanupStagedPathCopy(staged);
      return failureResult(
        copyResult(
          input,
          source,
          destination,
          staged.fingerprint,
          "failed",
          parent.createdPaths,
          issue,
        ),
        issue,
        start,
      );
    }
    await commitStagedPathCopy(staged);
    committedFingerprint = staged.fingerprint;
    staged = undefined;
  } catch (error) {
    await cleanupStagedPathCopy(staged);
    const issue = error instanceof CopyPathOperationError
      ? error.issue
      : classifyFilesystemOperationError(error, destination, "COPY");
    return failureResult(
      emptyCopyResult(
        input,
        source,
        destination,
        issue,
        parent.createdPaths,
      ),
      issue,
      start,
    );
  }

  let finalFingerprint: PathFingerprint;
  try {
    finalFingerprint = await fingerprintPath(destination, "COPY");
  } catch (error) {
    const issue = error instanceof CopyPathOperationError
      ? error.issue
      : classifyFilesystemOperationError(error, destination, "COPY");
    return failureResult(
      copyResult(
        input,
        source,
        destination,
        {
          kind: committedFingerprint?.kind ?? fingerprintKind(expectedSource),
          contentSha256: "",
          entryCount: 0,
          totalBytes: 0,
        },
        "copied_unverified",
        parent.createdPaths,
        issue,
      ),
      issue,
      start,
    );
  }
  if (
    !committedFingerprint
    || finalFingerprint.kind !== committedFingerprint.kind
    || finalFingerprint.contentSha256 !== committedFingerprint.contentSha256
    || finalFingerprint.entryCount !== committedFingerprint.entryCount
    || finalFingerprint.totalBytes !== committedFingerprint.totalBytes
  ) {
    const issue: FilesystemOperationIssue = {
      code: "COPY_VERIFICATION_FAILED",
      message: `Final copy does not match the staged source: ${destination}`,
      category: "conflict",
      retryable: false,
      recoverable: true,
      target: destination,
      expected: committedFingerprint,
      actual: finalFingerprint,
    };
    return failureResult(
      copyResult(
        input,
        source,
        destination,
        finalFingerprint,
        "copied_unverified",
        parent.createdPaths,
        issue,
      ),
      issue,
      start,
    );
  }

  return successResult(
    copyResult(
      input,
      source,
      destination,
      finalFingerprint,
      "copied",
      parent.createdPaths,
    ),
    start,
  );
}

function successResult(result: CopyResult, start: number): ToolResult {
  const durationMs = Date.now() - start;
  const artifact: ArtifactRef = {
    kind: result.kind === "directory" ? "directory" : "file",
    path: result.destination,
    label: result.destination,
    metadata: {
      source: result.source,
      kind: result.kind,
      contentSha256: result.contentSha256,
      entryCount: result.entryCount,
      totalBytes: result.totalBytes,
    },
  };
  return {
    ok: true,
    output: JSON.stringify(result, null, 2),
    meta: diagnostics(result, durationMs),
    v2: {
      transportOk: true,
      operationStatus: "succeeded",
      code: "PATH_COPIED",
      message: `Copied ${result.source} to ${result.destination}.`,
      structuredContent: result,
      artifacts: [artifact],
      diagnostics: diagnostics(result, durationMs),
    },
  };
}

function failureResult(
  result: CopyResult,
  issue: FilesystemOperationIssue,
  start: number,
): ToolResult {
  const durationMs = Date.now() - start;
  const partial = result.status === "copied_unverified"
    || result.createdParentPaths.length > 0;
  const error: ToolStructuredError = {
    category: issue.category,
    code: issue.code,
    message: issue.message,
    retryable: issue.retryable,
    recoverable: issue.recoverable,
    target: issue.target,
    ...(issue.expected !== undefined ? { expected: issue.expected } : {}),
    ...(issue.actual !== undefined ? { actual: issue.actual } : {}),
    suggestedNextActions: [
      issue.code === "COPY_CONFLICT" || issue.code === "COPY_SOURCE_CHANGED"
        ? "Inspect the current source and destination, then retry the copy."
        : "Resolve the reported filesystem condition before retrying.",
    ],
  };
  return {
    ok: false,
    error: issue.message,
    meta: {
      ...diagnostics(result, durationMs),
      ...(issue.errnoCode ? { errnoCode: issue.errnoCode } : {}),
    },
    v2: {
      transportOk: true,
      operationStatus: partial ? "partial" : "failed",
      code: issue.code,
      message: issue.message,
      structuredContent: result,
      artifacts: result.status === "copied_unverified"
        ? [{
            kind: result.kind === "directory" ? "directory" : "file",
            path: result.destination,
            metadata: { unverified: true },
          }]
        : [],
      error,
      diagnostics: diagnostics(result, durationMs),
    },
  };
}

function copyResult(
  input: CopyInput,
  source: string,
  destination: string,
  fingerprint: PathFingerprint,
  status: CopyResult["status"],
  createdParentPaths: string[],
  issue?: FilesystemOperationIssue,
): CopyResult {
  return {
    requestedSource: input.source,
    requestedDestination: input.destination,
    source,
    destination,
    kind: fingerprint.kind,
    status,
    createdParentPaths,
    contentSha256: fingerprint.contentSha256,
    entryCount: fingerprint.entryCount,
    totalBytes: fingerprint.totalBytes,
    ...(issue ? {
      errorCode: issue.code,
      errorMessage: issue.message,
    } : {}),
  };
}

function emptyCopyResult(
  input: CopyInput,
  source: string,
  destination: string,
  issue: FilesystemOperationIssue,
  createdParentPaths: string[] = [],
): CopyResult {
  return {
    requestedSource: input.source,
    requestedDestination: input.destination,
    source,
    destination,
    kind: "file",
    status: "failed",
    createdParentPaths,
    contentSha256: "",
    entryCount: 0,
    totalBytes: 0,
    errorCode: issue.code,
    errorMessage: issue.message,
  };
}

function conflictFailure(
  input: CopyInput,
  source: string,
  destination: string,
  expectedSource: Parameters<typeof summarizeFilesystemTargetState>[0],
  actualSource: Parameters<typeof summarizeFilesystemTargetState>[0],
  expectedDestination: Parameters<typeof summarizeFilesystemTargetState>[0],
  actualDestination: Parameters<typeof summarizeFilesystemTargetState>[0],
  start: number,
): ToolResult {
  const issue: FilesystemOperationIssue = {
    code: "COPY_CONFLICT",
    message: "Copy source or destination changed before execution.",
    category: "conflict",
    retryable: true,
    recoverable: true,
    target: destination,
    expected: {
      source: summarizeFilesystemTargetState(expectedSource),
      destination: summarizeFilesystemTargetState(expectedDestination),
    },
    actual: {
      source: summarizeFilesystemTargetState(actualSource),
      destination: summarizeFilesystemTargetState(actualDestination),
    },
  };
  return failureResult(
    emptyCopyResult(input, source, destination, issue),
    issue,
    start,
  );
}

function conflictIssue(
  destination: string,
  expected: Parameters<typeof summarizeFilesystemTargetState>[0],
  actual: Parameters<typeof summarizeFilesystemTargetState>[0],
): FilesystemOperationIssue {
  return {
    code: "COPY_CONFLICT",
    message: `Copy destination changed while the copy was being staged: ${destination}`,
    category: "conflict",
    retryable: true,
    recoverable: true,
    target: destination,
    expected: summarizeFilesystemTargetState(expected),
    actual: summarizeFilesystemTargetState(actual),
  };
}

function semanticFailure(
  input: CopyInput,
  source: string,
  destination: string,
  code: string,
  message: string,
  start: number,
  category: FilesystemOperationIssue["category"] = "semantic",
  retryable = false,
): ToolResult {
  const issue: FilesystemOperationIssue = {
    code,
    message,
    category,
    retryable,
    recoverable: true,
    target: code === "COPY_DESTINATION_EXISTS" ? destination : source,
  };
  return failureResult(
    emptyCopyResult(input, source, destination, issue),
    issue,
    start,
  );
}

function fingerprintKind(
  state: Parameters<typeof summarizeFilesystemTargetState>[0],
): CopyResult["kind"] {
  return state.kind === "directory"
    ? "directory"
    : state.kind === "symlink"
      ? "symlink"
      : "file";
}

function diagnostics(
  result: CopyResult,
  durationMs: number,
): Record<string, unknown> {
  return {
    durationMs,
    status: result.status,
    kind: result.kind,
    entryCount: result.entryCount,
    totalBytes: result.totalBytes,
    createdParentCount: result.createdParentPaths.length,
  };
}
