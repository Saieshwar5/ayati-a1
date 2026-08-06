import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(packageDirectory, "assets", "tray.png.base64");
const outputPath = resolve(packageDirectory, "dist", "assets", "tray.png");
const encoded = (await readFile(sourcePath, "utf8")).trim();
const png = Buffer.from(encoded, "base64");

if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
  throw new Error("Ayati desktop tray asset is not a valid PNG.");
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, png);
