import { EpisodicMemoryJobStore } from "./job-store.js";
import { EpisodicMemorySettingsStore } from "./settings-store.js";
import type { EpisodicMemoryStatus } from "./types.js";

export interface EpisodicMemoryControllerOptions {
  settingsStore: EpisodicMemorySettingsStore;
  jobStore: EpisodicMemoryJobStore;
  embeddingAvailable: () => boolean;
  embeddingModel: () => string;
}

export class EpisodicMemoryController {
  private readonly settingsStore: EpisodicMemorySettingsStore;
  private readonly jobStore: EpisodicMemoryJobStore;
  private readonly embeddingAvailable: () => boolean;
  private readonly embeddingModel: () => string;

  constructor(options: EpisodicMemoryControllerOptions) {
    this.settingsStore = options.settingsStore;
    this.jobStore = options.jobStore;
    this.embeddingAvailable = options.embeddingAvailable;
    this.embeddingModel = options.embeddingModel;
  }

  getStatus(clientId: string): EpisodicMemoryStatus {
    const settings = this.settingsStore.get(clientId);
    const counts = this.jobStore.counts();
    return {
      clientId: settings.clientId,
      episodicEnabled: settings.episodicEnabled,
      embeddingProvider: settings.embeddingProvider,
      embeddingModel: this.embeddingModel() || settings.embeddingModel,
      embeddingAvailable: this.embeddingAvailable(),
      pendingJobs: counts.pending,
      runningJobs: counts.running,
      failedJobs: counts.failed,
      doneJobs: counts.done,
    };
  }

  setEnabled(clientId: string, enabled: boolean): EpisodicMemoryStatus {
    this.settingsStore.setEnabled(clientId, enabled);
    return this.getStatus(clientId);
  }
}
