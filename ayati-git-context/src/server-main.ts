#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startGitContextServerRuntime } from "./server-runtime.js";
import {
  createJsonLineObservabilitySink,
  GitContextObserver,
} from "./observability.js";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataRoot = resolve(packageDirectory, "..", "data", "git-context-engine");
const dataRoot = process.env["AYATI_GIT_CONTEXT_DATA_DIR"]?.trim() || defaultDataRoot;
const workspaceRoot = process.env["AYATI_GIT_CONTEXT_WORKSPACE_DIR"]?.trim()
  || join(dataRoot, "workspace");
const databasePath = process.env["AYATI_GIT_CONTEXT_DATABASE"]?.trim()
  || join(dataRoot, "context.db");
const socketPath = process.env["AYATI_GIT_CONTEXT_SOCKET"]?.trim()
  || "/tmp/ayati-git-context.sock";
const parentPid = positiveInteger(process.env["AYATI_GIT_CONTEXT_PARENT_PID"]);
const observabilitySink = createJsonLineObservabilitySink(process.stdout);
const observer = new GitContextObserver("git-context-engine", observabilitySink);
const runtime = await startGitContextServerRuntime({
  databasePath,
  dataRoot,
  workspaceRoot,
  socketPath,
  ...(parentPid ? { parentPid } : {}),
  observabilitySink,
});

if (runtime.address.kind === "unix") {
  observer.emit({
    level: "info",
    event: "server_ready",
    outcome: "succeeded",
    data: { socketPath: runtime.address.socketPath },
  });
}

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  await runtime.stop();
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

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
