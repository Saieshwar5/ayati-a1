import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_REQUEST_BYTES = 8_192;
const CLIENT_TIMEOUT_MS = 5_000;

export type VoiceControlCommand =
  | "press"
  | "release"
  | "toggle"
  | "send"
  | "cancel"
  | "status";

export interface VoiceStatusSnapshot {
  state:
    | "starting"
    | "idle"
    | "recording"
    | "transcribing"
    | "reviewing"
    | "queued"
    | "running"
    | "unavailable"
    | "error"
    | "disabled";
  since: string;
  detail?: string;
  transcriptPreview?: string;
  messageId?: string;
  queuePosition?: number;
}

export interface VoiceControlResponse {
  ok: boolean;
  message: string;
  voice: VoiceStatusSnapshot;
}

export interface VoiceControlServerOptions {
  socketPath: string;
  execute: (command: VoiceControlCommand) => Promise<VoiceControlResponse>;
}

export class VoiceControlServer {
  private server: Server | null = null;
  private ownsSocket = false;

  constructor(private readonly options: VoiceControlServerOptions) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    await removeStaleSocket(this.options.socketPath);

    const server = createServer((socket) => this.handleClient(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        this.server = null;
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        this.ownsSocket = true;
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.socketPath);
    });
    await chmod(this.options.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.server;
    const ownsSocket = this.ownsSocket;
    this.server = null;
    this.ownsSocket = false;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (!ownsSocket) {
      return;
    }
    await unlink(this.options.socketPath).catch((error: unknown) => {
      if (!isMissingFile(error)) {
        throw error;
      }
    });
  }

  private handleClient(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.setTimeout(CLIENT_TIMEOUT_MS);
    let input = "";
    let handled = false;

    const finish = (response: VoiceControlResponse): void => {
      if (handled) return;
      handled = true;
      socket.end(`${JSON.stringify(response)}\n`);
    };
    const fail = (message: string): void => finish({
      ok: false,
      message,
      voice: {
        state: "error",
        since: new Date().toISOString(),
        detail: message,
      },
    });

    socket.on("data", (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) {
        fail("Voice control request is too large.");
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const command = parseCommand(input.slice(0, newline));
      if (!command) {
        fail("Unknown voice command.");
        return;
      }
      void this.options.execute(command).then(finish, (error: unknown) => {
        fail(error instanceof Error ? error.message : String(error));
      });
    });
    socket.on("timeout", () => fail("Voice control request timed out."));
    socket.on("error", () => {
      handled = true;
    });
  }
}

function parseCommand(input: string): VoiceControlCommand | undefined {
  const trimmed = input.trim();
  let value: unknown = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    value = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)["command"]
      : parsed;
  } catch {
    // Plain command strings are accepted for simple local scripts.
  }
  return ["press", "release", "toggle", "send", "cancel", "status"].includes(String(value))
    ? value as VoiceControlCommand
    : undefined;
}

async function removeStaleSocket(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isSocket()) {
      throw new Error(`Refusing to replace non-socket voice control path: ${path}`);
    }
    if (await socketIsActive(path)) {
      throw new Error(`Ayati voice control is already active at ${path}`);
    }
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

function socketIsActive(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (active: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(active);
    };
    socket.setTimeout(300, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        resolve(false);
        return;
      }
      reject(error);
    });
  });
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}
