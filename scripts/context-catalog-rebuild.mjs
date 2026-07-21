#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContextDatabase,
  rebuildWorkstreamCatalog,
} from "../ayati-context-engine/dist/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mainRoot = join(repositoryRoot, "ayati-main");
const argumentsList = process.argv.slice(2);
const unknownArguments = argumentsList.filter((argument) => argument !== "--confirm");
if (unknownArguments.length > 0) {
  throw new Error(`Unknown catalog rebuild option: ${unknownArguments.join(", ")}`);
}
const confirm = argumentsList.includes("--confirm");
const paths = resolveRuntimePaths(process.env);

validateSafePaths(paths);
if (confirm) {
  await refuseLiveRuntime(paths);
  if (!await exists(paths.databasePath)) {
    throw new Error(
      "Catalog rebuild requires an initialized V7 database; start and stop Ayati once first.",
    );
  }
}

let database;
try {
  if (confirm) database = await ContextDatabase.open({ path: paths.databasePath });
  const result = await rebuildWorkstreamCatalog({
    workstreamRoot: paths.workstreamRoot,
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
  const rootDirectory = resolveConfiguredPath(
    env["AYATI_ROOT_DIR"],
    join(mainRoot, "ayati"),
  );
  const stateRoot = join(rootDirectory, ".ayati");
  return {
    rootDirectory,
    stateRoot,
    databasePath: resolveConfiguredPath(
      env["AYATI_CONTEXT_ENGINE_DATABASE"] ?? env["AYATI_GIT_CONTEXT_DATABASE"],
      join(stateRoot, "context.db"),
    ),
    workstreamRoot: join(rootDirectory, "workstreams"),
  };
}

function renderResult(result, paths, confirmed) {
  const lines = [
    `ayati-root: ${paths.rootDirectory}`,
    `database: ${paths.databasePath}`,
    `workstream-root: ${paths.workstreamRoot}`,
    `scanned-directories: ${result.scannedDirectories}`,
    `valid-workstream-repositories: ${result.repositories.length}`,
  ];
  for (const repository of result.repositories) {
    lines.push(
      `valid: ${repository.workstreamId} ${repository.contextRepositoryPath} resources=${repository.resources.length}`,
    );
  }
  lines.push(`invalid-workstream-repositories: ${result.failures.length}`);
  for (const failure of result.failures) {
    lines.push(`invalid: ${failure.contextRepositoryPath}: ${failure.message}`);
  }
  lines.push(confirmed && result.applied
    ? `Rebuilt ${result.repositories.length} workstream catalog entr${result.repositories.length === 1 ? "y" : "ies"}.`
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
  if (dirname(paths.stateRoot) !== paths.rootDirectory || basename(paths.stateRoot) !== ".ayati") {
    throw new Error(`Refusing unexpected state root: ${paths.stateRoot}`);
  }
  if (dirname(paths.workstreamRoot) !== paths.rootDirectory
    || basename(paths.workstreamRoot) !== "workstreams") {
    throw new Error(`Refusing unexpected workstream root: ${paths.workstreamRoot}`);
  }
  for (const [label, value] of [
    ["Ayati root", paths.rootDirectory],
    ["database parent", dirname(paths.databasePath)],
    ["workstream root", paths.workstreamRoot],
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
  const owner = await readWriterOwner(join(paths.databasePath + ".writer-lock", "owner.json"));
  const pid = Number(owner?.pid);
  if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
    throw new Error(`Refusing to rebuild while Context Engine writer PID ${pid} is live.`);
  }
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
