import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VoiceChannelRuntime,
  type VoiceNotification,
  type VoiceNotifier,
  type VoiceRuntimeConfig,
  type VoiceRuntimePaths,
  type VoiceTranscriber,
} from "../../src/voice/index.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

let runtime: VoiceChannelRuntime | null = null;
let tempRoot: string | null = null;

afterEach(async () => {
  await runtime?.stop();
  runtime = null;
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe("VoiceChannelRuntime", () => {
  it("records, reviews, confirms, submits, and renders the matching agent reply", async () => {
    const transcript = deferred<string>();
    const transcriber = createTranscriber({ transcript: transcript.promise });
    const notifications: VoiceNotification[] = [];
    const submitChat = vi.fn((input: { messageId: string; content: string }) => ({
      type: "chat_accepted" as const,
      messageId: input.messageId,
      queued: false,
      queuePosition: 1,
    }));
    runtime = await createRuntime({ transcriber, notifications, submitChat });

    const pressed = await runtime.execute("press");
    expect(pressed.ok).toBe(true);
    expect(runtime.snapshot().state).toBe("recording");
    const transcriptPath = vi.mocked(transcriber.start).mock.calls[0]?.[0];
    expect(transcriptPath).toBeTruthy();
    await expect(access(transcriptPath!)).resolves.toBeUndefined();

    await runtime.execute("release");
    expect(runtime.snapshot().state).toBe("transcribing");
    transcript.resolve("Create a concise project status report.");
    await vi.waitFor(() => expect(runtime?.snapshot().state).toBe("reviewing"));
    expect(runtime.snapshot().transcriptPreview).toBe("Create a concise project status report.");
    expect(submitChat).not.toHaveBeenCalled();

    const sent = await runtime.execute("press");
    expect(sent.ok).toBe(true);
    expect(submitChat).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "message-1",
      content: "Create a concise project status report.",
      onSettled: expect.any(Function),
    }));
    expect(runtime.snapshot().state).toBe("running");
    await expect(access(transcriptPath!)).rejects.toMatchObject({ code: "ENOENT" });

    runtime.handleAgentMessage({
      type: "reply",
      messageId: "message-1",
      content: "The project is on track.",
    });
    expect(runtime.snapshot().state).toBe("idle");
    expect(notifications.some((entry) => entry.body === "The project is on track.")).toBe(true);
  });

  it("discards a transcription that finishes after cancellation", async () => {
    const transcript = deferred<string>();
    const transcriber = createTranscriber({ transcript: transcript.promise });
    const submitChat = vi.fn();
    runtime = await createRuntime({ transcriber, submitChat });

    await runtime.execute("press");
    await runtime.execute("release");
    const cancelled = await runtime.execute("cancel");
    expect(cancelled.ok).toBe(true);
    expect(runtime.snapshot().state).toBe("idle");
    expect(transcriber.cancel).toHaveBeenCalledOnce();

    transcript.resolve("This must not be submitted.");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runtime.snapshot().state).toBe("idle");
    expect(submitChat).not.toHaveBeenCalled();
  });

  it("reports queued requests and returns to idle when a no-reply run settles", async () => {
    let settle: ((result: { messageId: string; status: "completed" }) => void) | undefined;
    runtime = await createRuntime({
      transcriber: createTranscriber({ transcript: Promise.resolve("Continue the queued task.") }),
      submitChat: (input) => {
        settle = input.onSettled;
        return {
          type: "chat_accepted",
          messageId: input.messageId,
          queued: true,
          queuePosition: 2,
        };
      },
    });

    await runtime.execute("press");
    await runtime.execute("release");
    await vi.waitFor(() => expect(runtime?.snapshot().state).toBe("reviewing"));
    await runtime.execute("send");
    expect(runtime.snapshot()).toEqual(expect.objectContaining({
      state: "queued",
      queuePosition: 2,
      messageId: "message-1",
    }));

    settle?.({ messageId: "message-1", status: "completed" });
    expect(runtime.snapshot().state).toBe("idle");
  });
});

async function createRuntime(input: {
  transcriber: VoiceTranscriber;
  notifications?: VoiceNotification[];
  submitChat: ConstructorParameters<typeof VoiceChannelRuntime>[0]["submitChat"];
}): Promise<VoiceChannelRuntime> {
  tempRoot = await mkdtemp(join(tmpdir(), "ayati-voice-runtime-"));
  const paths: VoiceRuntimePaths = {
    runtimeDirectory: tempRoot,
    transcriptDirectory: join(tempRoot, "transcripts"),
    controlSocketPath: join(tempRoot, "voice.sock"),
    voxtypeStatePath: join(tempRoot, "voxtype-state"),
  };
  const notifications = input.notifications ?? [];
  const notifier: VoiceNotifier = {
    notify: vi.fn(async (notification) => {
      notifications.push(notification);
    }),
  };
  const ids = ["transcript-1", "message-1", "transcript-2", "message-2"];
  const config: VoiceRuntimeConfig = {
    enabled: true,
    autoSend: false,
    notificationsEnabled: true,
    showTranscriptPreview: true,
    showReplyPreview: true,
    command: "voxtype",
    transcriptionTimeoutMs: 10_000,
    maxTranscriptChars: 32_000,
  };
  const value = new VoiceChannelRuntime({
    config,
    paths,
    transcriber: input.transcriber,
    notifier,
    submitChat: input.submitChat,
    now: () => new Date("2026-08-06T08:00:00.000Z"),
    createId: () => ids.shift() ?? "fallback-id",
    controlServer: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
  });
  await value.start();
  return value;
}

function createTranscriber(input: { transcript: Promise<string> }): VoiceTranscriber {
  return {
    checkAvailability: vi.fn(async () => ({ available: true, detail: "Voxtype ready (idle)." })),
    start: vi.fn(async () => undefined),
    stopAndRead: vi.fn(async () => await input.transcript),
    cancel: vi.fn(async () => undefined),
  };
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}
