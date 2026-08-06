import { execFile } from "node:child_process";

export interface VoiceNotification {
  title: string;
  body: string;
  urgency?: "low" | "normal" | "critical";
  expireMs?: number;
}

export interface VoiceNotifier {
  notify(notification: VoiceNotification): Promise<void>;
}

export class NotifySendVoiceNotifier implements VoiceNotifier {
  constructor(private readonly command = "notify-send") {}

  async notify(notification: VoiceNotification): Promise<void> {
    const args = [
      "--app-name=Ayati Voice",
      "--icon=audio-input-microphone",
      `--urgency=${notification.urgency ?? "normal"}`,
      `--expire-time=${notification.expireMs ?? 7_000}`,
      notification.title,
      notification.body,
    ];
    await execute(this.command, args, 5_000);
  }
}

export class NoopVoiceNotifier implements VoiceNotifier {
  async notify(_notification: VoiceNotification): Promise<void> {}
}

function execute(command: string, args: string[], timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, { timeout }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
