import { BackgroundFinalizationCoordinator } from "./background-finalization-coordinator.js";

export type FinalTaskRunCommitStatus = "committed" | "skipped" | "failed";

export interface ScheduleChatTaskRunFinalizationInput {
  key: string;
  persistAssistant: () => Promise<boolean>;
  finalize: () => Promise<FinalTaskRunCommitStatus>;
  recover: (error: unknown) => Promise<void>;
  onScheduled?: () => void;
  onStatus: (status: FinalTaskRunCommitStatus) => void;
  onError?: (error: unknown) => void;
}

export class ChatTaskRunFinalizationScheduler {
  private readonly coordinator = new BackgroundFinalizationCoordinator();

  isPending(key: string): boolean {
    return this.coordinator.isPending(key);
  }

  async schedule(input: ScheduleChatTaskRunFinalizationInput): Promise<boolean> {
    if (!await input.persistAssistant()) {
      return false;
    }
    input.onScheduled?.();
    this.coordinator.start(input.key, async () => {
      input.onStatus(await input.finalize());
    }, {
      onError: async (error) => {
        try {
          await input.recover(error);
        } catch (recoveryError) {
          input.onError?.(recoveryError);
        }
        input.onStatus("failed");
        input.onError?.(error);
      },
    });
    return true;
  }

  async wait(key: string): Promise<void> {
    await this.coordinator.wait(key);
  }

  async drain(): Promise<void> {
    await this.coordinator.drain();
  }
}
