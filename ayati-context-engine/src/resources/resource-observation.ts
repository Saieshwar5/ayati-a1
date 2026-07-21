import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import type {
  ResourceKind,
  ResourcePublicLocator,
  ResourceVersion,
} from "../contracts.js";
import { ContextEngineServiceError } from "../errors.js";
import { runGit, runGitRaw } from "../git/git-process.js";

const MAX_DIRECTORY_ENTRIES = 20_000;

export interface ObservedResource {
  locator: ResourcePublicLocator;
  kind: ResourceKind;
  displayName: string;
  version: ResourceVersion;
  mediaType?: string;
  mutationEligible: boolean;
  warnings: string[];
}

export async function observeResource(
  locator: ResourcePublicLocator,
  input: { at: string; kind?: ResourceKind; managedBlobPath?: string },
): Promise<ObservedResource> {
  if (locator.kind === "filesystem") {
    return await observeFilesystem(locator.path, input.at, input.kind);
  }
  if (locator.kind === "managed_blob") {
    if (!input.managedBlobPath) {
      return {
        locator,
        kind: input.kind ?? "file",
        displayName: locator.resourceId,
        version: unversioned(locator.resourceId, input.at, false),
        mutationEligible: false,
        warnings: ["Managed upload bytes are not available in this process."],
      };
    }
    const observed = await observeFilesystem(input.managedBlobPath, input.at, input.kind ?? "file");
    return {
      ...observed,
      locator,
      mutationEligible: false,
    };
  }
  if (locator.kind === "url") {
    let url: URL;
    try {
      url = new URL(locator.url);
    } catch {
      throw invalidLocator("URL resource locator is invalid.", { url: locator.url });
    }
    url.hash = "";
    const normalized = url.toString();
    return {
      locator: { kind: "url", url: normalized },
      kind: input.kind ?? "url",
      displayName: url.hostname + (url.pathname === "/" ? "" : url.pathname),
      version: {
        key: "url:" + sha256(normalized),
        observedAt: input.at,
        exists: true,
        kind: "url",
      },
      mutationEligible: false,
      warnings: ["URL availability and remote version were not fetched during local inspection."],
    };
  }
  const key = [locator.provider, locator.externalId, locator.uri ?? ""].join("\u0000");
  return {
    locator: {
      kind: "external",
      provider: locator.provider.trim().toLowerCase(),
      externalId: locator.externalId.trim(),
      ...(locator.uri ? { uri: locator.uri.trim() } : {}),
    },
    kind: input.kind ?? "external_object",
    displayName: locator.externalId,
    version: {
      key: "external:" + sha256(key),
      observedAt: input.at,
      exists: true,
      kind: "external",
    },
    mutationEligible: false,
    warnings: ["External object version was not fetched during local inspection."],
  };
}

async function observeFilesystem(
  inputPath: string,
  at: string,
  kindHint?: ResourceKind,
): Promise<ObservedResource> {
  const path = resolve(inputPath);
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) {
    const kind = kindHint ?? "file";
    return {
      locator: { kind: "filesystem", path },
      kind,
      displayName: basename(path) || path,
      version: unversioned(path, at, false),
      mutationEligible: kind !== "url" && kind !== "external_object",
      warnings: ["Filesystem resource does not currently exist."],
    };
  }
  if (stat.isSymbolicLink()) {
    throw invalidLocator("Filesystem resource may not be a symbolic link.", { path });
  }
  const canonicalPath = await realpath(path);
  if (stat.isFile()) {
    const hash = await hashFile(canonicalPath);
    const mediaType = mediaTypeFor(canonicalPath);
    const kind = kindHint ?? kindForFile(canonicalPath, mediaType);
    return {
      locator: { kind: "filesystem", path: canonicalPath },
      kind,
      displayName: basename(canonicalPath),
      version: {
        key: "file:sha256:" + hash,
        observedAt: at,
        exists: true,
        kind: "file",
        sha256: hash,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      },
      ...(mediaType ? { mediaType } : {}),
      mutationEligible: true,
      warnings: [],
    };
  }
  if (!stat.isDirectory()) {
    throw invalidLocator("Filesystem resource must be a normal file or directory.", { path });
  }
  const git = await observeGitRepository(canonicalPath, at);
  if (git && (kindHint === undefined || kindHint === "git_repository" || kindHint === "directory")) {
    return {
      locator: { kind: "filesystem", path: canonicalPath },
      kind: kindHint ?? "git_repository",
      displayName: basename(canonicalPath),
      version: git,
      mutationEligible: true,
      warnings: git.dirty ? ["Git resource currently has uncommitted changes."] : [],
    };
  }
  const tree = await fingerprintDirectory(canonicalPath, at);
  return {
    locator: { kind: "filesystem", path: canonicalPath },
    kind: kindHint ?? "directory",
    displayName: basename(canonicalPath),
    version: tree.version,
    mutationEligible: true,
    warnings: tree.truncated
      ? ["Directory observation reached the entry limit; mutation verification will fail closed."]
      : [],
  };
}

async function observeGitRepository(path: string, at: string): Promise<ResourceVersion | undefined> {
  try {
    const top = resolve(await runGit(["rev-parse", "--show-toplevel"], { cwd: path }));
    if (top !== resolve(path)) return undefined;
    const head = await runGit(["rev-parse", "HEAD"], { cwd: path });
    const status = await runGitRaw(["status", "--porcelain", "--untracked-files=all"], { cwd: path });
    const dirty = status.trim().length > 0;
    const fingerprint = sha256(head + "\u0000" + status.replaceAll("\r\n", "\n"));
    return {
      key: "git:" + head + ":" + fingerprint,
      observedAt: at,
      exists: true,
      kind: "git",
      head,
      dirty,
      fingerprint,
    };
  } catch {
    return undefined;
  }
}

async function fingerprintDirectory(
  root: string,
  at: string,
): Promise<{ version: ResourceVersion; truncated: boolean }> {
  const entries: string[] = [];
  let totalBytes = 0;
  let truncated = false;
  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) {
        truncated = true;
        return;
      }
      const path = join(directory, child.name);
      const relativePath = relative(root, path).replaceAll("\\", "/");
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        entries.push("l\u0000" + relativePath);
      } else if (stat.isDirectory()) {
        entries.push("d\u0000" + relativePath + "\u0000" + stat.mtimeMs);
        await visit(path);
        if (truncated) return;
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        entries.push([
          "f",
          relativePath,
          String(stat.size),
          String(stat.mtimeMs),
        ].join("\u0000"));
      } else {
        entries.push("o\u0000" + relativePath);
      }
    }
  }
  await visit(root);
  const fingerprint = sha256(entries.join("\n") + (truncated ? "\nTRUNCATED" : ""));
  return {
    version: {
      key: "directory:" + fingerprint + (truncated ? ":truncated" : ""),
      observedAt: at,
      exists: true,
      kind: "directory",
      fingerprint,
      entryCount: entries.length,
      sizeBytes: totalBytes,
    },
    truncated,
  };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function kindForFile(path: string, mediaType?: string): ResourceKind {
  if (mediaType?.startsWith("image/")) return "image";
  if (mediaType?.startsWith("audio/")) return "audio";
  if (mediaType?.startsWith("video/")) return "video";
  const extension = extname(path).toLowerCase();
  if ([".md", ".txt", ".pdf", ".doc", ".docx", ".odt", ".rtf"].includes(extension)) {
    return "document";
  }
  if ([".csv", ".tsv", ".parquet", ".arrow", ".jsonl"].includes(extension)) {
    return "dataset";
  }
  if ([".db", ".sqlite", ".sqlite3"].includes(extension)) return "database";
  return "file";
}

function mediaTypeFor(path: string): string | undefined {
  const extension = extname(path).toLowerCase();
  return new Map<string, string>([
    [".md", "text/markdown"], [".txt", "text/plain"], [".html", "text/html"],
    [".css", "text/css"], [".json", "application/json"], [".csv", "text/csv"],
    [".pdf", "application/pdf"], [".png", "image/png"], [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"],
    [".svg", "image/svg+xml"], [".mp3", "audio/mpeg"], [".wav", "audio/wav"],
    [".mp4", "video/mp4"], [".webm", "video/webm"],
  ]).get(extension);
}

function unversioned(identity: string, at: string, exists: boolean): ResourceVersion {
  return {
    key: (exists ? "unversioned:" : "missing:") + sha256(identity),
    observedAt: at,
    exists,
    kind: "unversioned",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalidLocator(message: string, details: Record<string, unknown>): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "RESOURCE_LOCATOR_INVALID",
    message,
    details,
  });
}
