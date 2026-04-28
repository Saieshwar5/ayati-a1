import { writeFile } from "node:fs/promises";
import type { ManagedFileRecord } from "../types.js";

export async function prepareUnsupportedFile(input: {
  file: ManagedFileRecord;
  outputPath: string;
}): Promise<{ warnings: string[] }> {
  const warnings = [`No extractor is available for file kind: ${input.file.kind}`];
  await writeFile(input.outputPath, JSON.stringify({
    fileId: input.file.fileId,
    kind: input.file.kind,
    warnings,
  }, null, 2), "utf-8");
  return { warnings };
}
