import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PdfToTextCliOptions {
  filePath: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function extractTextWithPdfToText(options: PdfToTextCliOptions): Promise<string> {
  const pdfToTextBin = process.env["PDFTOTEXT_BIN"]?.trim() || "pdftotext";
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const { stdout } = await execFileAsync(
    pdfToTextBin,
    ["-layout", options.filePath, "-"],
    { maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs },
  );
  return stdout.trim();
}
