#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startGitContextServerRuntime } from "./server-runtime.js";
import {
  createJsonLineObservabilitySink,
  GitContextObserver,
} from "./observability.js";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultRootDirectory = resolve(packageDirectory, "..", "data", "ayati");
const rootDirectory = process.env["AYATI_ROOT_DIR"]?.trim() || defaultRootDirectory;
const databasePath = process.env["AYATI_GIT_CONTEXT_DATABASE"]?.trim()
  || join(rootDirectory, ".ayati", "context.db");
const socketPath = process.env["AYATI_GIT_CONTEXT_SOCKET"]?.trim()
  || join(rootDirectory, ".ayati", "git-context.sock");
const timezone = process.env["AYATI_GIT_CONTEXT_TIMEZONE"]?.trim() || "UTC";
const agentId = process.env["AYATI_GIT_CONTEXT_AGENT_ID"]?.trim() || "local";
const parentPid = positiveInteger(process.env["AYATI_GIT_CONTEXT_PARENT_PID"]);
const observabilitySink = createJsonLineObservabilitySink(process.stdout);
const observer = new GitContextObserver("git-context-engine", observabilitySink);
const runtime = await startGitContextServerRuntime({
  databasePath,
  rootDirectory,
  socketPath,
  timezone,
  agentId,
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
