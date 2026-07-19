#!/usr/bin/env node

import { createConnection } from "node:net";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContextDatabase,
  rebuildTaskCatalog,
} from "../ayati-git-context/dist/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mainRoot = join(repositoryRoot, "ayati-main");
const confirm = process.argv.slice(2).includes("--confirm");
const paths = resolveRuntimePaths(process.env);

validateSafePaths(paths);
if (confirm) {
  await refuseLiveRuntime(paths);
  if (!await exists(paths.databasePath)) {
    throw new Error(
      "Catalog rebuild requires an initialized V3 database; start and stop Ayati once first.",
    );
  }
}

let database;
try {
  if (confirm) database = await ContextDatabase.open({ path: paths.databasePath });
  const result = await rebuildTaskCatalog({
    taskRoot: paths.taskRoot,
    trustedRoots: paths.trustedRoots,
    now: new Date().toISOString(),
    ...(database ? { database } : {}),
    confirm,
  });
  process.stdout.write(renderResult(result, paths, confirm));
  if (result.failures.length > 0) process.exitCode = 1;
} finally {
  database?.close();
}

function resolveRuntimePaths(env) {
  const workspaceRoot = resolveConfiguredPath(
    env["AYATI_WORKSPACE_DIR"],
    join(mainRoot, "work_space"),
  );
  const storeDir = resolveConfiguredPath(
    env["AYATI_GIT_CONTEXT_STORE_DIR"],
    join(mainRoot, "data", "context-engine"),
  );
  const databasePath = resolveConfiguredPath(
    env["AYATI_GIT_CONTEXT_DATABASE"],
    join(storeDir, "context.sqlite"),
  );
  const socketPath = resolveConfiguredPath(
    env["AYATI_GIT_CONTEXT_SOCKET"],
    join(storeDir, "git-context.sock"),
  );
  const trustedRoots = [...new Set((env["AYATI_GIT_CONTEXT_TRUSTED_ROOTS"] ?? "")
    .split(delimiter)
    .map((entry) => normalizeSpecialPath(entry))
    .filter(Boolean)
    .map((entry) => isAbsolute(entry) ? resolve(entry) : resolve(workspaceRoot, entry)))];
  return {
    databasePath,
    socketPath,
    workspaceRoot,
    taskRoot: join(workspaceRoot, "tasks"),
    trustedRoots,
  };
}

function renderResult(result, paths, confirmed) {
  const lines = [
    `database: ${paths.databasePath}`,
    `task-root: ${paths.taskRoot}`,
    `trusted-roots: ${paths.trustedRoots.length > 0 ? paths.trustedRoots.join(", ") : "(workspace only)"}`,
    `scanned-directories: ${result.scannedDirectories}`,
    `valid-task-repositories: ${result.repositories.length}`,
  ];
  for (const repository of result.repositories) {
    lines.push(
      `valid: ${repository.taskId} ${repository.placement} ${repository.repositoryPath}`,
    );
  }
  lines.push(`invalid-task-repositories: ${result.failures.length}`);
  for (const failure of result.failures) {
    lines.push(`invalid: ${failure.repositoryPath}: ${failure.message}`);
  }
  lines.push(confirmed && result.applied
    ? `Rebuilt ${result.repositories.length} task catalog entr${result.repositories.length === 1 ? "y" : "ies"}.`
    : "No catalog changes were made. Re-run with --confirm after reviewing this inventory.");
  return lines.join("\n") + "\n";
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
  if (dirname(paths.taskRoot) !== paths.workspaceRoot || basename(paths.taskRoot) !== "tasks") {
    throw new Error(`Refusing unexpected task root: ${paths.taskRoot}`);
  }
  for (const [label, value] of [
    ["database parent", dirname(paths.databasePath)],
    ["workspace root", paths.workspaceRoot],
    ...paths.trustedRoots.map((root) => ["trusted root", root]),
  ]) {
    if (isBroadDirectory(value)) throw new Error(`Refusing unsafe ${label}: ${value}`);
  }
}

function isBroadDirectory(value) {
  const normalized = resolve(value);
  return normalized === parse(normalized).root
    || normalized === resolve(homedir())
    || normalized === repositoryRoot
    || normalized === mainRoot;
}

async function refuseLiveRuntime(paths) {
  if (await socketAcceptsConnections(paths.socketPath)) {
    throw new Error(`Refusing to rebuild while the Git Context socket is live: ${paths.socketPath}`);
  }
  const owner = await readWriterOwner(paths.databasePath + ".writer-lock");
  const pid = Number(owner?.pid);
  if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
    throw new Error(`Refusing to rebuild while Git Context writer PID ${pid} is live.`);
  }
}

function socketAcceptsConnections(socketPath) {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ path: socketPath });
    const finish = (connected) => {
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

async function readWriterOwner(path) {
  const contents = await readFile(path, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (contents === undefined) return undefined;
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`Refusing to rebuild with an unreadable writer lock: ${path}`);
  }
}

async function exists(path) {
  return await lstat(path).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}
