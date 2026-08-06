import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";

const COMMAND_TIMEOUT_MS = 5_000;
const EMPTY_TRANSCRIPT_GRACE_MS = 1_000;
const POLL_INTERVAL_MS = 100;

export interface VoiceTranscriberAvailability {
  available: boolean;
  detail: string;
}

export interface VoiceTranscriber {
  checkAvailability(): Promise<VoiceTranscriberAvailability>;
  start(outputPath: string): Promise<void>;
  stopAndRead(outputPath: string): Promise<string>;
  cancel(): Promise<void>;
}

export interface VoxtypeAdapterOptions {
  command?: string;
  statePath: string;
  transcriptionTimeoutMs: number;
  maxTranscriptChars: number;
  execute?: (command: string, args: string[], timeoutMs: number) => Promise<void>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class VoxtypeAdapter implements VoiceTranscriber {
  private readonly command: string;
  private readonly execute: NonNullable<VoxtypeAdapterOptions["execute"]>;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: VoxtypeAdapterOptions) {
    this.command = options.command ?? "voxtype";
    this.execute = options.execute ?? executeCommand;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
  }

  async checkAvailability(): Promise<VoiceTranscriberAvailability> {
    try {
      await this.execute(this.command, ["--version"], COMMAND_TIMEOUT_MS);
    } catch (error) {
      return {
        available: false,
        detail: `Voxtype is unavailable: ${formatError(error)}`,
      };
    }

    const state = await this.readState();
    if (!state) {
      return {
        available: false,
        detail: "Voxtype is installed, but its user daemon is not running.",
      };
    }
    return {
      available: true,
      detail: `Voxtype ready (${state}).`,
    };
  }

  async start(outputPath: string): Promise<void> {
    const state = await this.readState();
    if (state !== "idle") {
      throw new Error(state
        ? `Voxtype is already ${state}.`
        : "The Voxtype daemon is not running.");
    }
    await this.execute(this.command, [
      "record",
      "start",
      `--file=${outputPath}`,
      "--no-auto-submit",
      "--no-smart-auto-submit",
    ], COMMAND_TIMEOUT_MS);
  }

  async stopAndRead(outputPath: string): Promise<string> {
    await this.execute(this.command, ["record", "stop"], COMMAND_TIMEOUT_MS);
    const deadline = this.now() + this.options.transcriptionTimeoutMs;
    let idleSince: number | undefined;

    while (this.now() < deadline) {
      const transcript = await this.readTranscript(outputPath);
      if (transcript) {
        return transcript;
      }

      const state = await this.readState();
      if (state?.startsWith("error")) {
        throw new Error(`Voxtype transcription failed: ${state}`);
      }
      if (state === "idle") {
        idleSince ??= this.now();
        if (this.now() - idleSince >= EMPTY_TRANSCRIPT_GRACE_MS) {
          throw new Error("No speech was detected.");
        }
      } else {
        idleSince = undefined;
      }
      await this.sleep(POLL_INTERVAL_MS);
    }

    throw new Error("Voxtype transcription timed out.");
  }

  async cancel(): Promise<void> {
    await this.execute(this.command, ["record", "cancel"], COMMAND_TIMEOUT_MS);
  }

  private async readState(): Promise<string | undefined> {
    try {
      const value = (await readFile(this.options.statePath, "utf8")).trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  private async readTranscript(path: string): Promise<string | undefined> {
    try {
      const metadata = await stat(path);
      if (metadata.size > this.options.maxTranscriptChars * 4) {
        throw new Error("Voice transcript exceeded the configured size limit.");
      }
      const value = (await readFile(path, "utf8")).trim();
      if (value.length > this.options.maxTranscriptChars) {
        throw new Error("Voice transcript exceeded the configured character limit.");
      }
      return value || undefined;
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }
  }
}

function executeCommand(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (error) {
        const detail = stderr.trim();
        reject(new Error(detail || error.message));
        return;
      }
      resolve();
    });
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
