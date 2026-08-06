import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoxtypeAdapter } from "../../src/voice/index.js";

let tempRoot: string | null = null;

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe("VoxtypeAdapter", () => {
  it("uses file output and returns the completed local transcript", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "ayati-voxtype-"));
    const statePath = join(tempRoot, "state");
    const outputPath = join(tempRoot, "transcript.txt");
    await writeFile(statePath, "idle", "utf8");
    await writeFile(outputPath, "", "utf8");
    const execute = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "record" && args[1] === "stop") {
        await writeFile(outputPath, "Inspect the daemon logs.", "utf8");
      }
    });
    const adapter = new VoxtypeAdapter({
      command: "voxtype",
      statePath,
      transcriptionTimeoutMs: 5_000,
      maxTranscriptChars: 1_000,
      execute,
    });

    await expect(adapter.checkAvailability()).resolves.toEqual({
      available: true,
      detail: "Voxtype ready (idle).",
    });
    await adapter.start(outputPath);
    expect(execute).toHaveBeenCalledWith("voxtype", [
      "record",
      "start",
      `--file=${outputPath}`,
      "--no-auto-submit",
      "--no-smart-auto-submit",
    ], 5_000);
    await expect(adapter.stopAndRead(outputPath)).resolves.toBe("Inspect the daemon logs.");
  });

  it("does not take over Voxtype while ordinary dictation is recording", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "ayati-voxtype-"));
    const statePath = join(tempRoot, "state");
    await writeFile(statePath, "recording", "utf8");
    const execute = vi.fn(async () => undefined);
    const adapter = new VoxtypeAdapter({
      statePath,
      transcriptionTimeoutMs: 5_000,
      maxTranscriptChars: 1_000,
      execute,
    });

    await expect(adapter.start(join(tempRoot, "transcript.txt")))
      .rejects.toThrow("Voxtype is already recording.");
    expect(execute).not.toHaveBeenCalled();
  });
});
