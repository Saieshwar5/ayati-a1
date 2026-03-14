import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PandocCliOptions {
  filePath: string;
  to?: "gfm" | "plain";
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export async function extractTextWithPandoc(options: PandocCliOptions): Promise<string> {
  const pandocBin = process.env["PANDOC_BIN"]?.trim() || "pandoc";
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const target = options.to ?? "gfm";

  const { stdout } = await execFileAsync(
    pandocBin,
    ["--to", target, "--wrap=none", options.filePath],
    { maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs },
  );

  return stdout.trim();
}
