import { writeFile } from "node:fs/promises";
import type { ManagedFileRecord, PreparedImageData } from "../types.js";

export async function prepareImageFile(input: {
  file: ManagedFileRecord;
  outputPath: string;
}): Promise<PreparedImageData> {
  const prepared: PreparedImageData = {
    mimeType: input.file.mimeType,
    sizeBytes: input.file.sizeBytes,
    warnings: [],
  };
  await writeFile(input.outputPath, JSON.stringify(prepared, null, 2), "utf-8");
  return prepared;
}
