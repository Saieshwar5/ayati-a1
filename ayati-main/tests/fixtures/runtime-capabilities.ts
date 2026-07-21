import { spawnSync } from "node:child_process";

export function canCaptureNodeSubprocessOutput(): boolean {
  const result = spawnSync(process.execPath, [
    "-e",
    "process.stdout.write('ayati-subprocess-ok')",
  ], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return result.status === 0 && result.stdout === "ayati-subprocess-ok";
}

export function canBindTcpSocket(): boolean {
  const script = [
    "const net = require('node:net');",
    "const server = net.createServer();",
    "server.on('error', () => process.exit(1));",
    "server.listen(0, '127.0.0.1', () => server.close(() => process.stdout.write('ayati-socket-ok')));",
  ].join("");
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return result.status === 0 && result.stdout === "ayati-socket-ok";
}
