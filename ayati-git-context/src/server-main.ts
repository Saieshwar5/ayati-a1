#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContextDatabase } from "./database/database.js";
import { GitContextHttpServer } from "./server.js";
import { SqliteGitContextService } from "./services/sqlite-git-context-service.js";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataRoot = resolve(packageDirectory, "..", "data", "git-context-engine");
const dataRoot = process.env["AYATI_GIT_CONTEXT_DATA_DIR"]?.trim() || defaultDataRoot;
const socketPath = process.env["AYATI_GIT_CONTEXT_SOCKET"]?.trim()
  || "/tmp/ayati-git-context.sock";
const database = await ContextDatabase.open({
  path: join(dataRoot, "context.db"),
});
const service = new SqliteGitContextService({
  database,
  dataRoot,
});
const server = new GitContextHttpServer({
  service,
  listen: { socketPath },
});

const address = await server.start();
if (address.kind === "unix") {
  process.stdout.write("Git Context Engine listening on " + address.socketPath + "\n");
}

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  await server.stop();
  await service.close();
};

process.once("SIGINT", () => {
  void stop().finally(() => {
    process.exitCode = 0;
  });
});
process.once("SIGTERM", () => {
  void stop().finally(() => {
    process.exitCode = 0;
  });
});
