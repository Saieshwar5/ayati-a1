import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 16_384;

export type VoiceControlCommand = "press" | "release" | "toggle" | "send" | "cancel" | "status";

export interface VoiceControlResponse {
  ok: boolean;
  message: string;
  voice: {
    state: string;
    detail?: string;
    transcriptPreview?: string;
    queuePosition?: number;
  };
}

export interface RunVoiceCommandOptions {
  env?: NodeJS.ProcessEnv;
  uid?: number;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  request?: (
    socketPath: string,
    command: VoiceControlCommand,
  ) => Promise<VoiceControlResponse>;
}

export async function runVoiceCommand(
  args: string[],
  options: RunVoiceCommandOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  const command = parseCommand(args[0]);
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    stdout(voiceHelp());
    return 0;
  }
  if (!command) {
    stderr(`Unknown Ayati voice command: ${args[0] ?? ""}\n\n${voiceHelp()}`);
    return 2;
  }

  let socketPath: string;
  try {
    socketPath = resolveControlSocketPath(
      options.env ?? process.env,
      options.uid ?? process.getuid?.() ?? 0,
    );
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }

  try {
    const response = await (options.request ?? requestVoiceControl)(socketPath, command);
    const lines = [
      response.message,
      `State: ${response.voice.state}`,
      ...(response.voice.detail && response.voice.detail !== response.message
        ? [`Detail: ${response.voice.detail}`]
        : []),
      ...(response.voice.transcriptPreview
        ? [`Transcript: ${response.voice.transcriptPreview}`]
        : []),
    ];
    (response.ok ? stdout : stderr)(lines.join("\n"));
    return response.ok ? 0 : 1;
  } catch (error) {
    stderr([
      `Could not reach Ayati voice: ${error instanceof Error ? error.message : String(error)}`,
      "Start the Ayati daemon, then try again.",
    ].join("\n"));
    return 1;
  }
}

export function resolveControlSocketPath(
  env: NodeJS.ProcessEnv,
  uid: number,
): string {
  const configured = env["AYATI_VOICE_SOCKET_PATH"]?.trim();
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error("AYATI_VOICE_SOCKET_PATH must be an absolute path");
    }
    return configured;
  }
  const configuredRuntimeDirectory = env["XDG_RUNTIME_DIR"]?.trim();
  const runtimeBase = configuredRuntimeDirectory && isAbsolute(configuredRuntimeDirectory)
    ? configuredRuntimeDirectory
    : resolve(tmpdir(), `ayati-runtime-${uid}`);
  return resolve(runtimeBase, "ayati", "voice.sock");
}

function requestVoiceControl(
  socketPath: string,
  command: VoiceControlCommand,
): Promise<VoiceControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS);
    let response = "";
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ version: 1, command })}\n`);
    });
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) {
        fail(new Error("Voice control response was too large."));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(response.slice(0, newline)) as unknown;
        if (!isVoiceControlResponse(parsed)) {
          fail(new Error("Voice control returned an invalid response."));
          return;
        }
        settled = true;
        socket.end();
        resolve(parsed);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("timeout", () => fail(new Error("Voice control request timed out.")));
    socket.on("error", fail);
    socket.on("close", () => {
      if (!settled) {
        fail(new Error("Voice control closed without a response."));
      }
    });
  });
}

function parseCommand(value: string | undefined): VoiceControlCommand | undefined {
  const aliases: Record<string, VoiceControlCommand> = {
    press: "press",
    start: "press",
    release: "release",
    stop: "release",
    toggle: "toggle",
    send: "send",
    cancel: "cancel",
    status: "status",
  };
  return aliases[value?.trim().toLowerCase() || "status"];
}

function isVoiceControlResponse(value: unknown): value is VoiceControlResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const voice = record["voice"];
  return typeof record["ok"] === "boolean"
    && typeof record["message"] === "string"
    && Boolean(voice)
    && typeof voice === "object"
    && !Array.isArray(voice)
    && typeof (voice as Record<string, unknown>)["state"] === "string";
}

function voiceHelp(): string {
  return [
    "Usage: ayati voice [command]",
    "",
    "Commands:",
    "  press    Start push-to-talk, or send a reviewed transcript",
    "  release  Stop recording and transcribe",
    "  toggle   Start, stop, or send based on the current state",
    "  send     Send the reviewed transcript",
    "  cancel   Discard recording or reviewed transcript",
    "  status   Show voice-channel state (default)",
  ].join("\n");
}
