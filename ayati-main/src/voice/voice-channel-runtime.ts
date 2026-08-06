import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, unlink } from "node:fs/promises";
import type {
  ChatIngressReceipt,
  ChatRunSettled,
} from "../ivec/index.js";
import { devLog, devWarn } from "../shared/index.js";
import type { VoiceRuntimeConfig } from "./voice-config.js";
import type { VoiceRuntimePaths } from "./voice-runtime-paths.js";
import {
  VoiceControlServer,
  type VoiceControlCommand,
  type VoiceControlResponse,
  type VoiceStatusSnapshot,
} from "./voice-control-server.js";
import type { VoiceNotifier } from "./desktop-notifier.js";
import type { VoiceTranscriber } from "./voxtype-adapter.js";

const PREVIEW_LIMIT = 500;
const REPLY_PREVIEW_LIMIT = 700;

interface RecordingSession {
  generation: number;
  transcriptPath: string;
  transcript?: string;
}

export interface SubmitVoiceChatInput {
  messageId: string;
  content: string;
  onSettled: (result: ChatRunSettled) => void;
}

export interface VoiceChannelRuntimeOptions {
  config: VoiceRuntimeConfig;
  paths: VoiceRuntimePaths;
  transcriber: VoiceTranscriber;
  notifier: VoiceNotifier;
  submitChat: (input: SubmitVoiceChatInput) => ChatIngressReceipt | null;
  now?: () => Date;
  createId?: () => string;
  controlServer?: VoiceControlServerLifecycle;
}

export interface VoiceControlServerLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class VoiceChannelRuntime {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly controlServer: VoiceControlServerLifecycle;
  private snapshotValue: VoiceStatusSnapshot;
  private recordingSession: RecordingSession | null = null;
  private activeMessageId: string | null = null;
  private generation = 0;
  private stopped = false;
  private commandTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: VoiceChannelRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.snapshotValue = {
      state: "starting",
      since: this.now().toISOString(),
      detail: "Voice channel is starting.",
    };
    this.controlServer = options.controlServer ?? new VoiceControlServer({
      socketPath: options.paths.controlSocketPath,
      execute: async (command) => await this.execute(command),
    });
  }

  get controlSocketPath(): string {
    return this.options.paths.controlSocketPath;
  }

  snapshot(): VoiceStatusSnapshot {
    return { ...this.snapshotValue };
  }

  async start(): Promise<void> {
    if (!this.options.config.enabled) {
      this.transition("disabled", "Voice input is disabled by AYATI_VOICE_ENABLED.");
      return;
    }

    await mkdir(this.options.paths.runtimeDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.options.paths.runtimeDirectory, 0o700);
    await mkdir(this.options.paths.transcriptDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.options.paths.transcriptDirectory, 0o700);
    await this.controlServer.start();

    const availability = await this.options.transcriber.checkAvailability();
    if (availability.available) {
      this.transition("idle", availability.detail);
    } else {
      this.transition("unavailable", availability.detail);
      this.notify({
        title: "Ayati voice unavailable",
        body: availability.detail,
        urgency: "critical",
      });
    }
    devLog(`Voice channel ${this.snapshotValue.state}; control=${this.controlSocketPath}`);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    const session = this.recordingSession;
    this.recordingSession = null;
    if (session && ["recording", "transcribing"].includes(this.snapshotValue.state)) {
      await this.options.transcriber.cancel().catch((error: unknown) => {
        devWarn("Unable to cancel Voxtype during shutdown:", formatError(error));
      });
    }
    if (session) {
      await removeTranscript(session.transcriptPath);
    }
    await this.controlServer.stop();
    this.transition("disabled", "Voice channel stopped with the Ayati daemon.");
  }

  execute(command: VoiceControlCommand): Promise<VoiceControlResponse> {
    const result = this.commandTail.then(async () => await this.handleCommand(command));
    this.commandTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  handleAgentMessage(data: unknown): void {
    const message = asRecord(data);
    if (!message || !this.activeMessageId) return;
    const messageId = typeof message["messageId"] === "string" ? message["messageId"] : undefined;
    if (messageId && messageId !== this.activeMessageId) return;

    const type = message["type"];
    if (type === "progress" || type === "reply_started") {
      if (this.snapshotValue.state === "queued") {
        this.transition("running", "Ayati is working on the voice request.", {
          messageId: this.activeMessageId,
        });
      }
      return;
    }
    if (!["reply", "feedback", "notification", "reply_done", "error"].includes(String(type))) {
      return;
    }

    const content = typeof message["content"] === "string"
      ? message["content"].trim()
      : "";
    const failed = type === "error";
    this.activeMessageId = null;
    this.transition(failed ? "error" : "idle", failed
      ? (content || "The voice request failed.")
      : "Voice request completed.");
    this.notify({
      title: failed ? "Ayati voice request failed" : "Ayati",
      body: this.options.config.showReplyPreview && content
        ? preview(content, REPLY_PREVIEW_LIMIT)
        : failed
          ? "The voice request failed."
          : "Voice request completed.",
      urgency: failed ? "critical" : "normal",
      expireMs: failed ? 10_000 : 12_000,
    });
  }

  private async handleCommand(command: VoiceControlCommand): Promise<VoiceControlResponse> {
    switch (command) {
      case "status":
        return this.response(true, `Ayati voice is ${this.snapshotValue.state}.`);
      case "press":
        return this.snapshotValue.state === "reviewing"
          ? await this.sendReviewedTranscript()
          : await this.beginRecording();
      case "release":
        return await this.finishRecording();
      case "toggle":
        if (this.snapshotValue.state === "recording") {
          return await this.finishRecording();
        }
        if (this.snapshotValue.state === "reviewing") {
          return await this.sendReviewedTranscript();
        }
        return await this.beginRecording();
      case "send":
        return await this.sendReviewedTranscript();
      case "cancel":
        return await this.cancelPendingInput();
    }
  }

  private async beginRecording(): Promise<VoiceControlResponse> {
    if (this.stopped || this.snapshotValue.state === "disabled") {
      return this.response(false, "Ayati voice is not running.");
    }
    if (["recording", "transcribing", "queued", "running"].includes(this.snapshotValue.state)) {
      return this.response(
        this.snapshotValue.state === "recording",
        `Ayati voice is already ${this.snapshotValue.state}.`,
      );
    }
    if (this.snapshotValue.state === "unavailable" || this.snapshotValue.state === "error") {
      const availability = await this.options.transcriber.checkAvailability();
      if (!availability.available) {
        this.transition("unavailable", availability.detail);
        return this.response(false, availability.detail);
      }
    }

    const generation = ++this.generation;
    const transcriptPath = `${this.options.paths.transcriptDirectory}/${this.createId()}.txt`;
    try {
      const handle = await open(transcriptPath, "wx", 0o600);
      await handle.close();
      this.recordingSession = { generation, transcriptPath };
      await this.options.transcriber.start(transcriptPath);
      this.transition("recording", "Listening. Release the voice key to transcribe.");
      return this.response(true, "Recording started.");
    } catch (error) {
      this.recordingSession = null;
      await removeTranscript(transcriptPath);
      const detail = formatError(error);
      this.transition("error", detail);
      this.notify({
        title: "Ayati could not start listening",
        body: detail,
        urgency: "critical",
      });
      return this.response(false, detail);
    }
  }

  private async finishRecording(): Promise<VoiceControlResponse> {
    const session = this.recordingSession;
    if (this.snapshotValue.state !== "recording" || !session) {
      return this.response(true, `Nothing to stop; Ayati voice is ${this.snapshotValue.state}.`);
    }
    this.transition("transcribing", "Transcribing speech locally with Voxtype.");
    void this.completeTranscription(session);
    return this.response(true, "Recording stopped; transcription started.");
  }

  private async completeTranscription(session: RecordingSession): Promise<void> {
    try {
      const transcript = (await this.options.transcriber.stopAndRead(session.transcriptPath)).trim();
      if (this.stopped || session.generation !== this.generation) {
        await removeTranscript(session.transcriptPath);
        return;
      }
      if (!transcript) {
        throw new Error("No speech was detected.");
      }
      if (transcript.length > this.options.config.maxTranscriptChars) {
        throw new Error("Voice transcript exceeded the configured character limit.");
      }
      session.transcript = transcript;
      const transcriptPreview = this.options.config.showTranscriptPreview
        ? preview(transcript, PREVIEW_LIMIT)
        : "Transcription ready.";
      this.transition("reviewing", "Press the Ayati voice key again to send, or cancel.", {
        transcriptPreview,
      });
      this.notify({
        title: "Ayati heard",
        body: `${transcriptPreview}\n\nPress the Ayati voice key again to send.`,
        expireMs: 15_000,
      });
      if (this.options.config.autoSend) {
        void this.execute("send");
      }
    } catch (error) {
      if (this.stopped || session.generation !== this.generation) {
        await removeTranscript(session.transcriptPath);
        return;
      }
      this.recordingSession = null;
      await removeTranscript(session.transcriptPath);
      const detail = formatError(error);
      this.transition("error", detail);
      this.notify({
        title: "Ayati transcription failed",
        body: detail,
        urgency: "critical",
      });
    }
  }

  private async sendReviewedTranscript(): Promise<VoiceControlResponse> {
    const session = this.recordingSession;
    if (this.snapshotValue.state !== "reviewing" || !session?.transcript) {
      return this.response(false, "There is no reviewed voice transcript to send.");
    }

    const messageId = this.createId();
    this.activeMessageId = messageId;
    this.transition("queued", "Submitting voice transcript to Ayati.", { messageId });
    let receipt: ChatIngressReceipt | null;
    try {
      receipt = this.options.submitChat({
        messageId,
        content: session.transcript,
        onSettled: (result) => this.handleRunSettled(result),
      });
    } catch (error) {
      receipt = null;
      devWarn("Voice chat submission failed:", formatError(error));
    }

    if (!receipt) {
      this.activeMessageId = null;
      this.transition("reviewing", "Ayati could not accept the transcript; it is still available to retry.", {
        transcriptPreview: this.options.config.showTranscriptPreview
          ? preview(session.transcript, PREVIEW_LIMIT)
          : "Transcription ready.",
      });
      return this.response(false, "Ayati could not accept the voice transcript.");
    }

    this.recordingSession = null;
    await removeTranscript(session.transcriptPath);
    this.transition(receipt.queued ? "queued" : "running", receipt.queued
      ? `Voice request queued at position ${receipt.queuePosition}.`
      : "Voice request accepted by Ayati.", {
      messageId,
      queuePosition: receipt.queuePosition,
    });
    this.notify({
      title: receipt.queued ? "Ayati voice request queued" : "Sent to Ayati",
      body: receipt.queued
        ? `Queue position: ${receipt.queuePosition}`
        : "The agent is working on your request.",
      expireMs: 4_000,
    });
    return this.response(true, receipt.queued
      ? `Voice request queued at position ${receipt.queuePosition}.`
      : "Voice transcript sent to Ayati.");
  }

  private async cancelPendingInput(): Promise<VoiceControlResponse> {
    if (["queued", "running"].includes(this.snapshotValue.state)) {
      return this.response(false, "The transcript was already accepted; agent-run cancellation is not available yet.");
    }
    const session = this.recordingSession;
    if (!session) {
      this.transition("idle", "Ready for voice input.");
      return this.response(true, "Nothing was pending.");
    }

    this.generation++;
    this.recordingSession = null;
    if (["recording", "transcribing"].includes(this.snapshotValue.state)) {
      await this.options.transcriber.cancel().catch((error: unknown) => {
        devWarn("Unable to cancel Voxtype:", formatError(error));
      });
    }
    await removeTranscript(session.transcriptPath);
    this.transition("idle", "Voice input cancelled.");
    this.notify({
      title: "Ayati voice cancelled",
      body: "The recording and transcript were discarded.",
      urgency: "low",
      expireMs: 3_000,
    });
    return this.response(true, "Voice input cancelled.");
  }

  private handleRunSettled(result: ChatRunSettled): void {
    if (result.messageId !== this.activeMessageId) return;
    if (!["queued", "running"].includes(this.snapshotValue.state)) return;

    this.activeMessageId = null;
    if (result.status === "failed") {
      const detail = result.error || "The voice request failed.";
      this.transition("error", detail);
      this.notify({
        title: "Ayati voice request failed",
        body: detail,
        urgency: "critical",
      });
      return;
    }
    this.transition("idle", "Voice request completed without a reply envelope.");
    this.notify({
      title: "Ayati",
      body: "Voice request completed.",
    });
  }

  private transition(
    state: VoiceStatusSnapshot["state"],
    detail: string,
    extra: Pick<VoiceStatusSnapshot, "transcriptPreview" | "messageId" | "queuePosition"> = {},
  ): void {
    this.snapshotValue = {
      state,
      since: this.now().toISOString(),
      detail,
      ...(extra.transcriptPreview ? { transcriptPreview: extra.transcriptPreview } : {}),
      ...(extra.messageId ? { messageId: extra.messageId } : {}),
      ...(extra.queuePosition !== undefined ? { queuePosition: extra.queuePosition } : {}),
    };
  }

  private response(ok: boolean, message: string): VoiceControlResponse {
    return {
      ok,
      message,
      voice: this.snapshot(),
    };
  }

  private notify(notification: Parameters<VoiceNotifier["notify"]>[0]): void {
    if (!this.options.config.notificationsEnabled) return;
    void this.options.notifier.notify(notification).catch((error: unknown) => {
      devWarn("Voice notification failed:", formatError(error));
    });
  }
}

function preview(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

async function removeTranscript(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (!isMissingFile(error)) {
      devWarn("Unable to remove voice transcript:", formatError(error));
    }
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
