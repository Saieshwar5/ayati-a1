#!/usr/bin/env node

import {
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
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
  migrateToSharedWorkstreamRepository,
} from "../ayati-context-engine/dist/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mainRoot = join(repositoryRoot, "ayati-main");
const argumentsList = process.argv.slice(2);
const unknownArguments = argumentsList.filter((argument) => argument !== "--confirm");
if (unknownArguments.length > 0) {
  throw new Error(`Unknown workstream migration option: ${unknownArguments.join(", ")}`);
}
const confirm = argumentsList.includes("--confirm");
const paths = resolveRuntimePaths(process.env);
const now = new Date().toISOString();
validateSafePaths(paths);
if (confirm) await refuseLiveRuntime(paths.databasePath);

if (!confirm) {
  const result = await migrateToSharedWorkstreamRepository({
    workstreamRoot: paths.workstreamRoot,
    now,
    confirm: false,
  });
  process.stdout.write(renderResult(result, paths, await readSchemaVersion(paths.databasePath)));
  process.exit(result.failures.length > 0 ? 1 : 0);
}

const stamp = now.replaceAll(":", "").replaceAll(".", "-");
const archiveRoot = join(paths.rootDirectory, "workstreams-migration-archive-" + stamp);
const temporaryDatabase = paths.databasePath + ".v9-migration";
if (await exists(temporaryDatabase)) {
  throw new Error(`Migration database already exists: ${temporaryDatabase}`);
}

let database;
let result;
try {
  database = await ContextDatabase.open({ path: temporaryDatabase });
  result = await migrateToSharedWorkstreamRepository({
    workstreamRoot: paths.workstreamRoot,
    archiveRoot,
    database,
    now,
    confirm: true,
  });
} finally {
  database?.close();
}

const archivedEntries = [];
let newDatabaseInstalled = false;
try {
  const databaseArchive = join(archiveRoot, "database");
  await mkdir(databaseArchive);
  for (const source of [
    paths.databasePath,
    paths.databasePath + "-wal",
    paths.databasePath + "-shm",
  ]) {
    if (!await exists(source)) continue;
    const destination = join(databaseArchive, basename(source));
    await rename(source, destination);
    archivedEntries.push({ source, destination });
  }
  await mkdir(dirname(paths.databasePath), { recursive: true });
  await rename(temporaryDatabase, paths.databasePath);
  newDatabaseInstalled = true;
  await writeFile(
    join(archiveRoot, "database-migration.json"),
    JSON.stringify({
      version: 1,
      status: "completed",
      completedAt: now,
      priorSchemaVersion: await readArchivedSchemaVersion(archivedEntries),
      currentSchemaVersion: 9,
      database: paths.databasePath,
      archivedEntries,
    }, null, 2) + "\n",
    "utf8",
  );
} catch (error) {
  if (newDatabaseInstalled && await exists(paths.databasePath)) {
    await rename(
      paths.databasePath,
      join(archiveRoot, "failed-v9-database"),
    ).catch(() => undefined);
  }
  for (const entry of [...archivedEntries].reverse()) {
    if (!await exists(entry.source) && await exists(entry.destination)) {
      await rename(entry.destination, entry.source).catch(() => undefined);
    }
  }
  await rollbackFilesystemSwitch(paths.workstreamRoot, archiveRoot);
  await recordDatabaseSwitchRollback(archiveRoot, now, error);
  throw error;
}

process.stdout.write(renderResult(result, paths, 9));

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

function renderResult(result, paths, schemaVersion) {
  const lines = [
    `ayati-root: ${paths.rootDirectory}`,
    `database: ${paths.databasePath}`,
    `database-schema: ${schemaVersion ?? "unknown or absent"}`,
    `workstream-root: ${paths.workstreamRoot}`,
    `scanned-nested-repositories: ${result.scannedDirectories}`,
    `valid-workstreams: ${result.workstreams.length}`,
  ];
  for (const workstream of result.workstreams) {
    lines.push(
      `valid: ${workstream.workstreamId} requests=${workstream.requestCount}`
        + ` progress=${workstream.progressCount} resources=${workstream.resourceCount}`
        + ` converted-files=${workstream.convertedFiles}`,
    );
  }
  lines.push(`migration-failures: ${result.failures.length}`);
  for (const failure of result.failures) {
    lines.push(`invalid: ${failure.sourcePath}: ${failure.message}`);
  }
  lines.push(result.applied
    ? `Migrated ${result.workstreams.length} workstream(s) to ${result.sharedRepositoryHead}.`
    : "No files were changed. Re-run with --confirm after reviewing this inventory.");
  if (result.archiveRoot) lines.push(`archive: ${result.archiveRoot}`);
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

async function refuseLiveRuntime(databasePath) {
  const owner = await readWriterOwner(join(databasePath + ".writer-lock", "owner.json"));
  const pid = Number(owner?.pid);
  if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
    throw new Error(`Refusing to migrate while Context Engine writer PID ${pid} is live.`);
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
  return JSON.parse(contents);
}

async function readSchemaVersion(path) {
  if (!await exists(path)) return undefined;
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const row = database.prepare(
      "SELECT version FROM schema_metadata WHERE singleton = 1",
    ).get();
    return Number.isInteger(Number(row?.version)) ? Number(row.version) : undefined;
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

async function readArchivedSchemaVersion(entries) {
  const database = entries.find((entry) => !entry.source.endsWith("-wal")
    && !entry.source.endsWith("-shm"));
  return database ? await readSchemaVersion(database.destination) : undefined;
}

async function rollbackFilesystemSwitch(workstreamRoot, archiveRoot) {
  const archived = join(archiveRoot, "workstreams");
  if (!await exists(archived) || !await exists(workstreamRoot)) return;
  const failed = join(archiveRoot, "failed-shared-repository-after-database-switch");
  await rename(workstreamRoot, failed).catch(() => undefined);
  await rename(archived, workstreamRoot).catch(() => undefined);
}

async function recordDatabaseSwitchRollback(archiveRoot, at, error) {
  const path = join(archiveRoot, "manifest.json");
  const content = await readFile(path, "utf8").catch((readError) => {
    if (readError?.code === "ENOENT") return undefined;
    throw readError;
  });
  if (content === undefined) return;
  const manifest = JSON.parse(content);
  await writeFile(path, JSON.stringify({
    ...manifest,
    status: "rolled_back_after_database_failure",
    rolledBackAt: at,
    databaseError: error instanceof Error ? error.message : String(error),
  }, null, 2) + "\n", "utf8");
}

async function exists(path) {
  return await lstat(path).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}
