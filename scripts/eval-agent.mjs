import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const command = process.argv.slice(2).find((value) => value !== "--");
const compiledCli = resolve(root, "ayati-main", "dist", "evaluation", "cli.js");

if (command === "live") {
  run("pnpm", ["--filter", "ayati-context-engine", "build"]);
  run("pnpm", ["--filter", "ayati-main", "build"]);
} else if (!existsSync(compiledCli)) {
  run("pnpm", ["--filter", "ayati-main", "build"]);
}
const envPath = resolve(root, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);
await import(pathToFileURL(compiledCli).href);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
