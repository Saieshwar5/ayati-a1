import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  canonicalizeFilesystemEntryPath,
  observeFilesystemTarget,
} from "../shared/filesystem-target-state.js";
import type {
  FilesystemTargetPrecondition,
  FilesystemTargetState,
  ToolResult,
} from "../skills/types.js";
import {
  filesystemMutationTransitionProblems,
} from "./filesystem-mutation-transitions.js";

const TARGET_VERIFIED_TOOLS = new Set([
  "write_files",
  "patch_files",
  "create_directory",
  "move",
  "copy",
  "delete",
  "set_permissions",
]);

export type TargetRole =
  | "write"
  | "patch"
  | "create_directory"
  | "move_source"
  | "move_destination"
  | "copy_source"
  | "copy_destination"
  | "delete"
  | "permissions";

export interface TargetSpec {
  requestedPath: string;
  path: string;
  role: TargetRole;
  expectedSha256?: string;
  requestedMode?: number;
}

export type PathState = FilesystemTargetState;

export interface PreparedFilesystemMutationVerification {
  toolName: string;
  targets: TargetSpec[];
  beforeTargets: Map<string, PathState>;
  targetPreconditions: FilesystemTargetPrecondition[];
}

export class FilesystemMutationPreparationError extends Error {
  constructor(
    readonly code:
      | "DUPLICATE_TARGET_PATH"
      | "WRITE_TARGET_NOT_REGULAR_FILE"
      | "PATCH_TARGET_NOT_REGULAR_FILE",
    message: string,
    readonly target: string,
  ) {
    super(message);
  }
}

export interface FilesystemMutationVerification {
  strategy: "target_local";
  verified: boolean;
  toolName: string;
  toolSucceeded: boolean;
  targetCount: number;
  parentDirectoryCount: number;
  targets: Array<{
    path: string;
    role: TargetRole;
    before: PathState["kind"];
    after: PathState["kind"];
    beforeSha256?: string;
    afterSha256?: string;
  }>;
  parentChangedPathCount: number;
  parentChangedPaths: string[];
  gitChangedPathCount: number;
  gitChangedPaths: string[];
  unexpectedPathCount: number;
  unexpectedPaths: string[];
  problems: string[];
}

export function usesTargetedFilesystemVerification(toolName: string): boolean {
  return TARGET_VERIFIED_TOOLS.has(toolName);
}

export async function prepareFilesystemMutationVerification(
  toolName: string,
  value: unknown,
): Promise<PreparedFilesystemMutationVerification | undefined> {
  if (!usesTargetedFilesystemVerification(toolName)) return undefined;
  const requestedTargets = mutationTargetSpecs(toolName, value);
  if (requestedTargets.length === 0) return undefined;

  const targets: TargetSpec[] = [];
  const seenPaths = new Set<string>();
  for (const target of requestedTargets) {
    if (!isAbsolute(target.requestedPath)) return undefined;
    const path = await canonicalizeFilesystemEntryPath(target.requestedPath);
    if (seenPaths.has(path)) {
      throw new FilesystemMutationPreparationError(
        "DUPLICATE_TARGET_PATH",
        `Filesystem mutation contains duplicate canonical target path: ${path}`,
        path,
      );
    }
    seenPaths.add(path);
    targets.push({ ...target, path });
  }

  const beforeTargets = new Map<string, PathState>();
  for (const path of uniqueStrings(targets.map((target) => target.path))) {
    beforeTargets.set(path, await observeFilesystemTarget(path));
  }
  return {
    toolName,
    targets,
    beforeTargets,
    targetPreconditions: [...beforeTargets].map(([path, expected]) => ({
      path,
      expected,
    })),
  };
}

export async function verifyFilesystemMutation(
  prepared: PreparedFilesystemMutationVerification,
  result: ToolResult,
): Promise<FilesystemMutationVerification> {
  const afterTargets = new Map<string, PathState>();
  for (const path of uniqueStrings(prepared.targets.map((target) => target.path))) {
    afterTargets.set(path, await observeFilesystemTarget(path));
  }
  const problems = await filesystemMutationTransitionProblems(
    prepared,
    afterTargets,
    result,
  );
  return {
    strategy: "target_local",
    verified: problems.length === 0,
    toolName: prepared.toolName,
    toolSucceeded: result.ok,
    targetCount: afterTargets.size,
    parentDirectoryCount: 0,
    targets: prepared.targets.map((target) => {
      const before = prepared.beforeTargets.get(target.path)
        ?? { kind: "missing" as const };
      const after = afterTargets.get(target.path)
        ?? { kind: "missing" as const };
      return {
        path: target.path,
        role: target.role,
        before: before.kind,
        after: after.kind,
        ...(before.kind === "file" ? { beforeSha256: before.sha256 } : {}),
        ...(after.kind === "file" ? { afterSha256: after.sha256 } : {}),
      };
    }),
    parentChangedPathCount: 0,
    parentChangedPaths: [],
    gitChangedPathCount: 0,
    gitChangedPaths: [],
    unexpectedPathCount: 0,
    unexpectedPaths: [],
    problems,
  };
}

export function attachFilesystemMutationVerification(
  result: ToolResult,
  verification: FilesystemMutationVerification,
): ToolResult {
  const diagnostics = {
    ...result.v2?.diagnostics,
    filesystemMutationVerification: verification,
  };
  const meta = {
    ...result.meta,
    filesystemMutationVerification: verification,
  };
  if (verification.verified) {
    return {
      ...result,
      meta,
      ...(result.v2 ? { v2: { ...result.v2, diagnostics } } : {}),
    };
  }

  const message = [
    "Filesystem mutation could not be verified against its declared targets.",
    ...verification.problems,
  ].join(" ");
  return {
    ...result,
    ok: false,
    error: [result.error, message].filter(Boolean).join(" "),
    meta,
    v2: {
      transportOk: result.v2?.transportOk ?? true,
      operationStatus: "failed",
      code: "FILESYSTEM_MUTATION_VERIFICATION_FAILED",
      message,
      ...(result.v2?.structuredContent !== undefined
        ? { structuredContent: result.v2.structuredContent }
        : {}),
      ...(result.v2?.artifacts ? { artifacts: result.v2.artifacts } : {}),
      diagnostics,
      error: {
        category: "conflict",
        code: "FILESYSTEM_MUTATION_VERIFICATION_FAILED",
        message,
        retryable: false,
        recoverable: true,
        suggestedNextActions: [
          "Inspect the declared targets before making another mutation.",
        ],
      },
    },
  };
}

function mutationTargetSpecs(
  toolName: string,
  value: unknown,
): Omit<TargetSpec, "path">[] {
  if (!isRecord(value)) return [];
  if (
    toolName === "write_files"
    || toolName === "patch_files"
    || toolName === "set_permissions"
  ) {
    const files = value["files"];
    if (!Array.isArray(files)) return [];
    return files.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry["path"] !== "string") return [];
      return [{
        requestedPath: entry["path"],
        role: toolName === "write_files"
          ? "write" as const
          : toolName === "patch_files"
            ? "patch" as const
            : "permissions" as const,
        ...(toolName === "write_files" && typeof entry["content"] === "string"
          ? { expectedSha256: sha256Text(entry["content"]) }
          : {}),
        ...(toolName === "set_permissions" && typeof entry["mode"] === "string"
          ? { requestedMode: Number.parseInt(entry["mode"], 8) }
          : {}),
      }];
    });
  }
  if (toolName === "create_directory" && typeof value["path"] === "string") {
    return [{ requestedPath: value["path"], role: "create_directory" }];
  }
  if (
    (toolName === "move" || toolName === "copy")
    && typeof value["source"] === "string"
    && typeof value["destination"] === "string"
  ) {
    return [
      {
        requestedPath: value["source"],
        role: toolName === "move" ? "move_source" : "copy_source",
      },
      {
        requestedPath: value["destination"],
        role: toolName === "move" ? "move_destination" : "copy_destination",
      },
    ];
  }
  if (toolName === "delete" && typeof value["path"] === "string") {
    return [{ requestedPath: value["path"], role: "delete" }];
  }
  return [];
}

function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function filesystemPathsOverlap(left: string, right: string): boolean {
  return pathIsWithin(left, right) || pathIsWithin(right, left);
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === ""
    || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
