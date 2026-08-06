import { describe, expect, it, vi } from "vitest";
import {
  resolveControlSocketPath,
  runVoiceCommand,
} from "../../src/voice/voice-control-client.js";

describe("runVoiceCommand", () => {
  it("sends a normalized command to the daemon control socket", async () => {
    const socketPath = "/tmp/ayati-voice-test.sock";
    const request = vi.fn(async () => ({
      ok: true,
      message: "Recording started.",
      voice: { state: "recording", detail: "Listening." },
    }));
    const stdout: string[] = [];

    const exitCode = await runVoiceCommand(["start"], {
      env: { AYATI_VOICE_SOCKET_PATH: socketPath },
      stdout: (message) => stdout.push(message),
      stderr: (message) => stdout.push(`error:${message}`),
      request,
    });

    expect(exitCode).toBe(0);
    expect(request).toHaveBeenCalledWith(socketPath, "press");
    expect(stdout.join("\n")).toContain("State: recording");
    expect(stdout.join("\n")).toContain("Detail: Listening.");
  });

  it("derives the same default runtime socket used by the daemon", () => {
    expect(resolveControlSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" }, 1000))
      .toBe("/run/user/1000/ayati/voice.sock");
  });
});
