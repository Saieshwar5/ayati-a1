import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const packageDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(packageDirectory, "src", "renderer"),
  base: "./",
  build: {
    outDir: resolve(packageDirectory, "dist", "renderer"),
    emptyOutDir: false,
    sourcemap: true,
  },
});
