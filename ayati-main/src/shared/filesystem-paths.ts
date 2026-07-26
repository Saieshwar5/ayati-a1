import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

declare const absoluteFilesystemPathBrand: unique symbol;
declare const canonicalFilesystemPathBrand: unique symbol;
declare const resourceRelativePathBrand: unique symbol;

/** A lexically normalized absolute host-filesystem path. */
export type AbsoluteFilesystemPath = string & {
  readonly [absoluteFilesystemPathBrand]: true;
};

/**
 * An absolute host-filesystem path whose existing prefix has been resolved
 * through the physical filesystem.
 */
export type CanonicalFilesystemPath = AbsoluteFilesystemPath & {
  readonly [canonicalFilesystemPathBrand]: true;
};

/** A portable child path whose authority comes from a separately named resource. */
export type ResourceRelativePath = string & {
  readonly [resourceRelativePathBrand]: true;
};

export type AbsoluteFilesystemPathResult =
  | {
      ok: true;
      absolutePath: AbsoluteFilesystemPath;
    }
  | {
      ok: false;
      code: "ABSOLUTE_PATH_REQUIRED";
      requestedPath: string;
      message: string;
    };

export type ResourceRelativePathResult =
  | {
      ok: true;
      relativePath: ResourceRelativePath;
    }
  | {
      ok: false;
      code: "RESOURCE_RELATIVE_PATH_REQUIRED";
      requestedPath: string;
      message: string;
    };

/**
 * Parse a host path without consulting process.cwd(). A successful `path`
 * field is therefore always safe from hidden relative-path anchoring.
 */
export function requireAbsoluteFilesystemPath(
  pathValue: string,
  field = "path",
): AbsoluteFilesystemPathResult {
  const trimmed = pathValue.trim();
  const containsUnsafeControlCharacter = /[\u0000-\u001f\u007f]/.test(trimmed);
  if (
    trimmed.length === 0
    || containsUnsafeControlCharacter
    || trimmed === "~"
    || trimmed.startsWith("~/")
    || trimmed.startsWith("~\\")
    || /^file:/i.test(trimmed)
    || !isAbsolute(trimmed)
  ) {
    return {
      ok: false,
      code: "ABSOLUTE_PATH_REQUIRED",
      requestedPath: pathValue,
      message: `${field} must be an absolute filesystem path. Relative paths, workspace aliases, ~ paths, and file URIs are not accepted.`,
    };
  }
  return {
    ok: true,
    absolutePath: resolve(trimmed) as AbsoluteFilesystemPath,
  };
}

/**
 * Resolve symlinks in the existing portion of an absolute path. Missing
 * descendants remain lexical children of the nearest canonical ancestor.
 */
export async function canonicalizeAbsoluteFilesystemPath(
  pathValue: string,
): Promise<CanonicalFilesystemPath> {
  const required = requireAbsoluteFilesystemPath(pathValue);
  if (!required.ok) throw new Error(required.message);

  const suffix: string[] = [];
  let current: string = required.absolutePath;
  while (true) {
    try {
      const existing = await realpath(current);
      return resolve(existing, ...suffix) as CanonicalFilesystemPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) {
        return required.absolutePath as CanonicalFilesystemPath;
      }
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

export function requireResourceRelativePath(
  pathValue: string,
  options: {
    allowResourceRoot?: boolean;
    field?: string;
  } = {},
): ResourceRelativePathResult {
  const field = options.field ?? "relativePath";
  const portable = pathValue.trim().replaceAll("\\", "/");
  const isResourceRoot = options.allowResourceRoot === true && portable === ".";
  const invalid = portable.length === 0
    || /[\u0000-\u001f\u007f]/.test(portable)
    || portable.startsWith("/")
    || /^[A-Za-z]:\//.test(portable)
    || isAbsolute(portable)
    || (!isResourceRoot && portable.split("/").some((part) => (
      part.length === 0 || part === "." || part === ".."
    )));

  if (invalid) {
    return {
      ok: false,
      code: "RESOURCE_RELATIVE_PATH_REQUIRED",
      requestedPath: pathValue,
      message: `${field} must be a portable path relative to its named resource and may not contain empty, '.' or '..' segments.`,
    };
  }
  return {
    ok: true,
    relativePath: portable as ResourceRelativePath,
  };
}

export function filesystemPathIsWithin(parent: string, candidate: string): boolean {
  const child = relative(resolve(parent), resolve(candidate));
  return child === ""
    || (child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child));
}
