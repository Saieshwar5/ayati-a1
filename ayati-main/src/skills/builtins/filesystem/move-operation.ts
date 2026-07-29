import { rename, rm } from "node:fs/promises";
import { filesystemPathIsWithin } from "../../../shared/filesystem-paths.js";
import {
  filesystemPreconditionMap,
  observeFilesystemTarget,
  sameFilesystemTargetState,
  summarizeFilesystemTargetState,
} from "../../../shared/filesystem-target-state.js";
import type {
  FilesystemTargetState,
  ToolExecutionContext,
  ToolResult,
} from "../../types.js";
import {
  cleanupStagedPathCopy,
  commitStagedPathCopy,
  CopyPathOperationError,
  fingerprintPath,
  samePathFingerprint,
  stageVerifiedPathCopy,
  type PathFingerprint,
  type StagedPathCopy,
} from "./copy-path-operation.js";
import {
  fingerprintFromState,
  moveConflictIssue,
  moveFailure,
  moveIssue,
  moveResult,
  moveSemanticFailure,
  moveSuccess,
  emptyMoveResult,
} from "./move-result.js";
import {
  classifyFilesystemOperationError,
  ensureOperationParent,
  resolveContainedMutationPath,
  type FilesystemOperationIssue,
} from "./path-operation-helpers.js";
import type { MoveInput, MoveResult } from "./types.js";

export interface MoveOperationDependencies {
  rename: typeof rename;
  remove: typeof rm;
}

const DEFAULT_DEPENDENCIES: MoveOperationDependencies = {
  rename,
  remove: rm,
};

export async function executeMoveOperation(
  input: MoveInput,
  context?: ToolExecutionContext,
  dependencies: MoveOperationDependencies = DEFAULT_DEPENDENCIES,
): Promise<ToolResult> {
  const start = Date.now();
  const sourceResolution = await resolveContainedMutationPath(
    input.source,
    context,
    "move source",
  );
  if (!sourceResolution.ok) {
    return moveFailure(
      emptyMoveResult(input, input.source, input.destination, sourceResolution.issue),
      sourceResolution.issue,
      start,
    );
  }
  const destinationResolution = await resolveContainedMutationPath(
    input.destination,
    context,
    "move destination",
  );
  if (!destinationResolution.ok) {
    return moveFailure(
      emptyMoveResult(
        input,
        sourceResolution.path,
        input.destination,
        destinationResolution.issue,
      ),
      destinationResolution.issue,
      start,
    );
  }
  const source = sourceResolution.path;
  const destination = destinationResolution.path;
  if (source === destination) {
    return moveSemanticFailure(
      input,
      source,
      destination,
      "MOVE_INVALID_RELATIONSHIP",
      "Move source and destination resolve to the same path.",
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
  const semanticIssue = validateMoveStates(
    source,
    destination,
    expectedSource,
    expectedDestination,
    input.overwrite === true,
  );
  if (semanticIssue) {
    return moveFailure(
      emptyMoveResult(input, source, destination, semanticIssue),
      semanticIssue,
      start,
    );
  }

  const currentSource = await observeFilesystemTarget(source);
  const currentDestination = await observeFilesystemTarget(destination);
  if (
    !sameFilesystemTargetState(expectedSource, currentSource)
    || !sameFilesystemTargetState(expectedDestination, currentDestination)
  ) {
    const issue = moveConflictIssue(
      destination,
      expectedSource,
      currentSource,
      expectedDestination,
      currentDestination,
    );
    return moveFailure(
      emptyMoveResult(input, source, destination, issue),
      issue,
      start,
    );
  }

  const parent = await ensureOperationParent(
    destination,
    input.createParents !== false,
    "MOVE",
  );
  if (!parent.ok) {
    return moveFailure(
      emptyMoveResult(
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

  try {
    await dependencies.rename(source, destination);
    return await verifyCompletedMove(
      input,
      source,
      destination,
      expectedSource,
      "rename",
      parent.createdPaths,
      undefined,
      start,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      const issue = classifyFilesystemOperationError(error, source, "MOVE");
      return moveFailure(
        emptyMoveResult(
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
  }

  return await crossDeviceMove(
    input,
    source,
    destination,
    expectedSource,
    expectedDestination,
    parent.createdPaths,
    dependencies,
    start,
  );
}

async function crossDeviceMove(
  input: MoveInput,
  source: string,
  destination: string,
  expectedSource: FilesystemTargetState,
  expectedDestination: FilesystemTargetState,
  createdParentPaths: string[],
  dependencies: MoveOperationDependencies,
  start: number,
): Promise<ToolResult> {
  let staged: StagedPathCopy | undefined;
  try {
    staged = await stageVerifiedPathCopy(source, destination, "MOVE");
    const currentDestination = await observeFilesystemTarget(destination);
    if (!sameFilesystemTargetState(expectedDestination, currentDestination)) {
      const issue = moveConflictIssue(
        destination,
        expectedSource,
        await observeFilesystemTarget(source),
        expectedDestination,
        currentDestination,
      );
      await cleanupStagedPathCopy(staged);
      return moveFailure(
        moveResult(
          input,
          source,
          destination,
          staged.fingerprint,
          "copy_delete",
          "failed",
          createdParentPaths,
          issue,
        ),
        issue,
        start,
      );
    }
    await commitStagedPathCopy(staged);
    const fingerprint = staged.fingerprint;
    staged = undefined;
    let currentSourceFingerprint: PathFingerprint;
    try {
      currentSourceFingerprint = await fingerprintPath(source, "MOVE");
    } catch (error) {
      if ((await observeFilesystemTarget(source)).kind === "missing") {
        return await verifyCompletedMove(
          input,
          source,
          destination,
          expectedSource,
          "copy_delete",
          createdParentPaths,
          fingerprint,
          start,
        );
      }
      const base = error instanceof CopyPathOperationError
        ? error.issue
        : classifyFilesystemOperationError(error, source, "MOVE");
      const issue = {
        ...base,
        code: "MOVE_SOURCE_CHANGED",
        message: `Destination was copied and verified, but the source could not be safely rechecked before deletion: ${source}. ${base.message}`,
      };
      return moveFailure(
        moveResult(
          input,
          source,
          destination,
          fingerprint,
          "copy_delete",
          "copied_but_source_retained",
          createdParentPaths,
          issue,
        ),
        issue,
        start,
      );
    }
    if (!samePathFingerprint(fingerprint, currentSourceFingerprint)) {
      const issue: FilesystemOperationIssue = {
        code: "MOVE_SOURCE_CHANGED",
        message: `Destination was copied and verified, but the source changed before deletion and was retained: ${source}`,
        category: "conflict",
        retryable: true,
        recoverable: true,
        target: source,
        expected: fingerprint,
        actual: currentSourceFingerprint,
      };
      return moveFailure(
        moveResult(
          input,
          source,
          destination,
          fingerprint,
          "copy_delete",
          "copied_but_source_retained",
          createdParentPaths,
          issue,
        ),
        issue,
        start,
      );
    }
    try {
      await dependencies.remove(source, {
        recursive: expectedSource.kind === "directory",
        force: false,
      });
    } catch (error) {
      const base = classifyFilesystemOperationError(error, source, "MOVE");
      const issue = {
        ...base,
        code: "MOVE_SOURCE_REMOVE_FAILED",
        message: `Destination was copied and verified, but the source could not be removed: ${source}. ${base.message}`,
      };
      return moveFailure(
        moveResult(
          input,
          source,
          destination,
          fingerprint,
          "copy_delete",
          "copied_but_source_retained",
          createdParentPaths,
          issue,
        ),
        issue,
        start,
      );
    }
    return await verifyCompletedMove(
      input,
      source,
      destination,
      expectedSource,
      "copy_delete",
      createdParentPaths,
      fingerprint,
      start,
    );
  } catch (error) {
    await cleanupStagedPathCopy(staged);
    const issue = error instanceof CopyPathOperationError
      ? error.issue
      : classifyFilesystemOperationError(error, destination, "MOVE");
    return moveFailure(
      emptyMoveResult(
        input,
        source,
        destination,
        issue,
        createdParentPaths,
      ),
      issue,
      start,
    );
  }
}

async function verifyCompletedMove(
  input: MoveInput,
  source: string,
  destination: string,
  beforeSource: FilesystemTargetState,
  strategy: MoveResult["strategy"],
  createdParentPaths: string[],
  fingerprint: PathFingerprint | undefined,
  start: number,
): Promise<ToolResult> {
  const afterSource = await observeFilesystemTarget(source);
  const afterDestination = await observeFilesystemTarget(destination);
  const valid = afterSource.kind === "missing"
    && movedStateMatches(beforeSource, afterDestination, strategy);
  if (!valid) {
    const issue: FilesystemOperationIssue = {
      code: "MOVE_VERIFICATION_FAILED",
      message: `Move completed but its final source or destination state is not trustworthy: ${destination}`,
      category: "conflict",
      retryable: false,
      recoverable: true,
      target: destination,
      expected: {
        source: { kind: "missing" },
        destinationKind: beforeSource.kind,
      },
      actual: {
        source: summarizeFilesystemTargetState(afterSource),
        destination: summarizeFilesystemTargetState(afterDestination),
      },
    };
    return moveFailure(
      moveResult(
        input,
        source,
        destination,
        fingerprint ?? fingerprintFromState(beforeSource),
        strategy,
        "moved_unverified",
        createdParentPaths,
        issue,
      ),
      issue,
      start,
    );
  }
  return moveSuccess(
    moveResult(
      input,
      source,
      destination,
      fingerprint ?? fingerprintFromState(afterDestination),
      strategy,
      "moved",
      createdParentPaths,
    ),
    start,
  );
}

function validateMoveStates(
  source: string,
  destination: string,
  sourceState: FilesystemTargetState,
  destinationState: FilesystemTargetState,
  overwrite: boolean,
): FilesystemOperationIssue | undefined {
  if (sourceState.kind === "missing") {
    return moveIssue("MOVE_SOURCE_NOT_FOUND", `Move source does not exist: ${source}`, "missing_path", source, true);
  }
  if (sourceState.kind === "other") {
    return moveIssue("MOVE_UNSUPPORTED_SOURCE_KIND", `Move source kind is unsupported: ${source}`, "semantic", source);
  }
  if (
    sourceState.kind === "directory"
    && filesystemPathIsWithin(source, destination)
  ) {
    return moveIssue("MOVE_INVALID_RELATIONSHIP", `A directory cannot be moved inside itself: ${destination}`, "semantic", destination);
  }
  if (destinationState.kind === "missing") return undefined;
  if (!overwrite) {
    return moveIssue("MOVE_DESTINATION_EXISTS", `Move destination already exists: ${destination}`, "conflict", destination, true);
  }
  if (sourceState.kind !== "file" || destinationState.kind !== "file") {
    return moveIssue(
      "MOVE_OVERWRITE_UNSUPPORTED",
      "overwrite=true supports only a regular file replacing another regular file; delete other destinations explicitly first.",
      "semantic",
      destination,
    );
  }
  return undefined;
}

function movedStateMatches(
  before: FilesystemTargetState,
  after: FilesystemTargetState,
  strategy: MoveResult["strategy"],
): boolean {
  if (before.kind !== after.kind) return false;
  if (before.kind === "file" && after.kind === "file") {
    return before.sha256 === after.sha256 && before.mode === after.mode;
  }
  if (before.kind === "symlink" && after.kind === "symlink") {
    return before.linkTarget === after.linkTarget;
  }
  if (before.kind === "directory" && after.kind === "directory") {
    return strategy === "copy_delete"
      || (before.device === after.device && before.inode === after.inode);
  }
  return false;
}
