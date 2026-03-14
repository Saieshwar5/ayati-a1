import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TikaCliOptions {
  filePath: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function extractTextWithTika(options: TikaCliOptions): Promise<string> {
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const jarPath = process.env["TIKA_JAR_PATH"]?.trim();

  if (jarPath) {
    const { stdout } = await execFileAsync(
      "java",
      ["-jar", jarPath, "--text", options.filePath],
      { maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs },
    );
    return stdout.trim();
  }

  const tikaBin = process.env["TIKA_BIN"]?.trim() || "tika";
  const { stdout } = await execFileAsync(
    tikaBin,
    ["--text", options.filePath],
    { maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs },
  );
  return stdout.trim();
}
