#!/usr/bin/env node

import { ContractOnlyGitContextService } from "./contract-only-service.js";
import { GitContextHttpServer } from "./server.js";

const socketPath = process.env["AYATI_GIT_CONTEXT_SOCKET"]?.trim()
  || "/tmp/ayati-git-context.sock";
const server = new GitContextHttpServer({
  service: new ContractOnlyGitContextService(),
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
