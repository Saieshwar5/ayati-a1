#!/usr/bin/env node

import { createConnection } from "node:net";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mainRoot = join(repositoryRoot, "ayati-main");
const argumentsList = process.argv.slice(2);
const unknownArguments = argumentsList.filter((argument) => argument !== "--confirm");
if (unknownArguments.length > 0) {
  throw new Error(`Unknown context archive reset option: ${unknownArguments.join(", ")}`);
}
const confirmed = argumentsList.includes("--confirm");
const paths = resolveRuntimePaths(process.env);

if (!confirmed) {
  process.stdout.write([
    `ayati-root: ${paths.rootDirectory}`,
    `database: ${paths.databasePath}`,
    `session-data: ${paths.sessionRoot}`,
    `resource-root: ${paths.resourceRoot}`,
    `workstream-root: ${paths.workstreamRoot}`,
    `workspace: ${paths.workspaceRoot} (preserved)`,
    "No files were changed. Re-run with --confirm to archive this state.",
    "",
  ].join("\n"));
  process.exit(0);
}

validateSafePaths(paths);
await refuseLiveRuntime(paths);

const archiveRoot = await createArchiveRoot(paths.rootDirectory);
const entries = [
  {
    label: "database",
    source: paths.databasePath,
    destination: join(archiveRoot, "database", basename(paths.databasePath)),
  },
  {
    label: "database-wal",
    source: paths.databasePath + "-wal",
    destination: join(archiveRoot, "database", basename(paths.databasePath) + "-wal"),
  },
  {
    label: "database-shm",
    source: paths.databasePath + "-shm",
    destination: join(archiveRoot, "database", basename(paths.databasePath) + "-shm"),
  },
  {
    label: "session-data",
    source: paths.sessionRoot,
    destination: join(archiveRoot, "sessions"),
  },
  {
    label: "resource-root",
    source: paths.resourceRoot,
    destination: join(archiveRoot, "resources"),
  },
  {
    label: "workstream-root",
    source: paths.workstreamRoot,
    destination: join(archiveRoot, "workstreams"),
  },
];
const manifest = {
  version: 2,
  operation: "context_archive_reset",
  createdAt: new Date().toISOString(),
  ayatiRoot: paths.rootDirectory,
  archiveRoot,
  socketPath: paths.socketPath,
  preservedPaths: [paths.workspaceRoot],
  status: "in_progress",
  entries: entries.map((entry) => ({
    ...entry,
    action: "archive",
    archived: false,
  })),
};
await writeManifest(archiveRoot, manifest);

try {
  for (const entry of manifest.entries) {
    entry.archived = await moveIfPresent(entry.source, entry.destination);
    await writeManifest(archiveRoot, manifest);
  }
  manifest.status = "completed";
  manifest.completedAt = new Date().toISOString();
  await writeManifest(archiveRoot, manifest);
} catch (error) {
  manifest.status = "failed";
  manifest.failedAt = new Date().toISOString();
  manifest.error = error instanceof Error ? error.message : String(error);
  await writeManifest(archiveRoot, manifest);
  throw error;
}

process.stdout.write(`Archived Git Context state to ${archiveRoot}\n`);

function resolveRuntimePaths(env) {
  const rootDirectory = resolveConfiguredPath(
    env["AYATI_ROOT_DIR"],
    join(mainRoot, "ayati"),
  );
  const stateRoot = join(rootDirectory, ".ayati");
  return {
    rootDirectory,
    stateRoot,
    databasePath: resolveConfiguredPath(
      env["AYATI_GIT_CONTEXT_DATABASE"],
      join(stateRoot, "context.db"),
    ),
    socketPath: resolveConfiguredPath(
      env["AYATI_GIT_CONTEXT_SOCKET"],
      join(stateRoot, "git-context.sock"),
    ),
    sessionRoot: join(stateRoot, "sessions"),
    resourceRoot: join(stateRoot, "resources"),
    workstreamRoot: join(rootDirectory, "workstreams"),
    workspaceRoot: join(rootDirectory, "workspace"),
  };
}

function resolveConfiguredPath(rawValue, fallback) {
  const normalized = normalizeSpecialPath(rawValue ?? "");
  if (!normalized) return resolve(fallback);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(mainRoot, normalized);
}

function normalizeSpecialPath(value) {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

function validateSafePaths(paths) {
  requireExactChild(paths.stateRoot, paths.rootDirectory, ".ayati", "state root");
  requireExactChild(paths.sessionRoot, paths.stateRoot, "sessions", "session data root");
  requireExactChild(paths.resourceRoot, paths.stateRoot, "resources", "resource root");
  requireExactChild(paths.workstreamRoot, paths.rootDirectory, "workstreams", "workstream root");
  requireExactChild(paths.workspaceRoot, paths.rootDirectory, "workspace", "workspace root");
  for (const [label, value] of [
    ["Ayati root", paths.rootDirectory],
    ["database parent", dirname(paths.databasePath)],
    ["session data root", paths.sessionRoot],
    ["resource root", paths.resourceRoot],
    ["workstream root", paths.workstreamRoot],
  ]) {
    if (isBroadDirectory(value)) {
      throw new Error(`Refusing to archive unsafe ${label}: ${value}`);
    }
  }
  if (pathsOverlap(paths.sessionRoot, paths.resourceRoot)
    || pathsOverlap(paths.sessionRoot, paths.workstreamRoot)
    || pathsOverlap(paths.resourceRoot, paths.workstreamRoot)
    || isWithin(paths.databasePath, paths.sessionRoot)
    || isWithin(paths.databasePath, paths.resourceRoot)
    || isWithin(paths.databasePath, paths.workstreamRoot)) {
    throw new Error("Refusing to archive overlapping Git Context paths.");
  }
}

function requireExactChild(value, parent, name, label) {
  if (dirname(value) !== parent || basename(value) !== name) {
    throw new Error(`Refusing unexpected ${label}: ${value}`);
  }
}

function isBroadDirectory(value) {
  const normalized = resolve(value);
  return normalized === parse(normalized).root
    || normalized === resolve(homedir())
    || normalized === repositoryRoot
    || normalized === mainRoot;
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(value, parent) {
  const child = resolve(value);
  const root = resolve(parent);
  const path = relative(root, child);
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}

async function refuseLiveRuntime(paths) {
  if (await socketAcceptsConnections(paths.socketPath)) {
    throw new Error(`Refusing to archive while the Git Context socket is live: ${paths.socketPath}`);
  }
  const lockPath = paths.databasePath + ".writer-lock";
  const owner = await readWriterOwner(join(lockPath, "owner.json"));
  const pid = Number(owner?.pid);
  if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
    throw new Error(`Refusing to archive while Git Context writer PID ${pid} is live.`);
  }
}

function socketAcceptsConnections(socketPath) {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveConnection(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function createArchiveRoot(rootDirectory) {
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
  const archiveRoot = join(
    dirname(rootDirectory),
    `${basename(rootDirectory)}-archive-${stamp}`,
  );
  if (isBroadDirectory(archiveRoot)) {
    throw new Error(`Refusing unsafe archive destination: ${archiveRoot}`);
  }
  await mkdir(dirname(rootDirectory), { recursive: true });
  await mkdir(archiveRoot, { recursive: false });
  return archiveRoot;
}

async function moveIfPresent(source, destination) {
  const stat = await lstat(source).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return false;
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await cp(source, destination, {
      recursive: stat.isDirectory(),
      errorOnExist: true,
      preserveTimestamps: true,
    });
    await rm(source, { recursive: stat.isDirectory(), force: false });
  }
  return true;
}

async function readWriterOwner(path) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`Refusing to archive with an unreadable writer lock: ${path}`);
  }
}

async function writeManifest(archiveRoot, manifest) {
  await writeFile(
    join(archiveRoot, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
}
