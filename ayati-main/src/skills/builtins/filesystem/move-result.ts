import {
  summarizeFilesystemTargetState,
} from "../../../shared/filesystem-target-state.js";
import type {
  ArtifactRef,
  FilesystemTargetState,
  ToolResult,
  ToolStructuredError,
} from "../../types.js";
import type { PathFingerprint } from "./copy-path-operation.js";
import type { FilesystemOperationIssue } from "./path-operation-helpers.js";
import type { MoveInput, MoveResult } from "./types.js";

export function moveSuccess(result: MoveResult, start: number): ToolResult {
  const durationMs = Date.now() - start;
  const artifact: ArtifactRef = {
    kind: result.kind === "directory" ? "directory" : "file",
    path: result.destination,
    label: result.destination,
    metadata: {
      source: result.source,
      status: result.status,
      strategy: result.strategy,
      ...(result.contentSha256 ? { contentSha256: result.contentSha256 } : {}),
    },
  };
  return {
    ok: true,
    output: JSON.stringify(result, null, 2),
    meta: moveDiagnostics(result, durationMs),
    v2: {
      transportOk: true,
      operationStatus: "succeeded",
      code: "PATH_MOVED",
      message: `Moved ${result.source} to ${result.destination}.`,
      structuredContent: result,
      artifacts: [artifact],
      diagnostics: moveDiagnostics(result, durationMs),
    },
  };
}

export function moveFailure(
  result: MoveResult,
  issueValue: FilesystemOperationIssue,
  start: number,
): ToolResult {
  const durationMs = Date.now() - start;
  const partial = result.status !== "failed"
    || result.createdParentPaths.length > 0;
  const error: ToolStructuredError = {
    category: issueValue.category,
    code: issueValue.code,
    message: issueValue.message,
    retryable: issueValue.retryable,
    recoverable: issueValue.recoverable,
    target: issueValue.target,
    ...(issueValue.expected !== undefined ? { expected: issueValue.expected } : {}),
    ...(issueValue.actual !== undefined ? { actual: issueValue.actual } : {}),
    suggestedNextActions: result.status === "copied_but_source_retained"
      ? ["Inspect both paths and remove the retained source only after confirming the destination."]
      : ["Inspect the current source and destination before constructing another move."],
  };
  return {
    ok: false,
    error: issueValue.message,
    meta: {
      ...moveDiagnostics(result, durationMs),
      ...(issueValue.errnoCode ? { errnoCode: issueValue.errnoCode } : {}),
    },
    v2: {
      transportOk: true,
      operationStatus: partial ? "partial" : "failed",
      code: issueValue.code,
      message: issueValue.message,
      structuredContent: result,
      artifacts: result.status === "failed"
        ? []
        : [{
            kind: result.kind === "directory" ? "directory" : "file",
            path: result.destination,
            metadata: { status: result.status },
          }],
      error,
      diagnostics: moveDiagnostics(result, durationMs),
    },
  };
}

export function moveResult(
  input: MoveInput,
  source: string,
  destination: string,
  fingerprint: PathFingerprint,
  strategy: MoveResult["strategy"],
  status: MoveResult["status"],
  createdParentPaths: string[],
  issueValue?: FilesystemOperationIssue,
): MoveResult {
  return {
    requestedSource: input.source,
    requestedDestination: input.destination,
    source,
    destination,
    kind: fingerprint.kind,
    strategy,
    status,
    overwrite: input.overwrite === true,
    moved: status === "moved",
    createdParentPaths,
    contentSha256: fingerprint.contentSha256,
    entryCount: fingerprint.entryCount,
    totalBytes: fingerprint.totalBytes,
    ...(issueValue ? {
      errorCode: issueValue.code,
      errorMessage: issueValue.message,
    } : {}),
  };
}

export function emptyMoveResult(
  input: MoveInput,
  source: string,
  destination: string,
  issueValue: FilesystemOperationIssue,
  createdParentPaths: string[] = [],
): MoveResult {
  return moveResult(
    input,
    source,
    destination,
    { kind: "file", contentSha256: "", entryCount: 0, totalBytes: 0 },
    "rename",
    "failed",
    createdParentPaths,
    issueValue,
  );
}

export function fingerprintFromState(
  state: FilesystemTargetState,
): PathFingerprint {
  return {
    kind: state.kind === "directory"
      ? "directory"
      : state.kind === "symlink"
        ? "symlink"
        : "file",
    contentSha256: state.kind === "file" ? state.sha256 : "",
    entryCount: 1,
    totalBytes: state.kind === "file" ? state.sizeBytes : 0,
  };
}

export function moveConflictIssue(
  destination: string,
  expectedSource: FilesystemTargetState,
  actualSource: FilesystemTargetState,
  expectedDestination: FilesystemTargetState,
  actualDestination: FilesystemTargetState,
): FilesystemOperationIssue {
  return {
    code: "MOVE_CONFLICT",
    message: "Move source or destination changed before execution.",
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
}

export function moveSemanticFailure(
  input: MoveInput,
  source: string,
  destination: string,
  code: string,
  message: string,
  start: number,
): ToolResult {
  const issueValue = moveIssue(code, message, "semantic", destination);
  return moveFailure(
    emptyMoveResult(input, source, destination, issueValue),
    issueValue,
    start,
  );
}

export function moveIssue(
  code: string,
  message: string,
  category: FilesystemOperationIssue["category"],
  target: string,
  retryable = false,
): FilesystemOperationIssue {
  return {
    code,
    message,
    category,
    retryable,
    recoverable: true,
    target,
  };
}

function moveDiagnostics(
  result: MoveResult,
  durationMs: number,
): Record<string, unknown> {
  return {
    durationMs,
    status: result.status,
    strategy: result.strategy,
    kind: result.kind,
    createdParentCount: result.createdParentPaths.length,
  };
}
