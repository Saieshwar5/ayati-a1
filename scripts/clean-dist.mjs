import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const packageDir = process.argv[2];

if (!packageDir || packageDir.trim().length === 0) {
  console.error("usage: node ../scripts/clean-dist.mjs <package-dir>");
  process.exitCode = 1;
} else {
  await rm(resolve(packageDir, "dist"), { recursive: true, force: true });
}
