import { resolve } from "node:path";
import type { LlmProvider } from "../core/contracts/provider.js";
import type { ConversationTurn } from "../memory/types.js";
import type { UserProfileContext } from "./types.js";
import { isUserProfileContext } from "./types.js";
import type { EvolutionResponse } from "./evolution-types.js";
import { buildExtractionMessages } from "./evolution-prompt.js";
import { validateProfilePatch, mergeProfilePatch } from "./evolution-merge.js";
import { writeJsonFileAtomic, backupFile } from "./loaders/io.js";
import { devLog, devWarn } from "../shared/index.js";

const MIN_TURNS = 4;
const RATE_LIMIT_MS = 60_000;

export interface ContextEvolverOptions {
  provider: LlmProvider;
  contextDir: string;
  historyDir: string;
  currentProfile: UserProfileContext;
  onContextUpdated?: (updated: { userProfile: UserProfileContext }) => void;
}

export class ContextEvolver {
  private readonly provider: LlmProvider;
  private readonly contextDir: string;
  private readonly historyDir: string;
  private currentProfile: UserProfileContext;
  private readonly onContextUpdated?: (updated: {
    userProfile: UserProfileContext;
  }) => void;
  private lastEvolvedAt = 0;

  constructor(options: ContextEvolverOptions) {
    this.provider = options.provider;
    this.contextDir = options.contextDir;
    this.historyDir = options.historyDir;
    this.currentProfile = options.currentProfile;
    this.onContextUpdated = options.onContextUpdated;
  }

  async evolveFromSession(turns: ConversationTurn[]): Promise<void> {
    try {
      if (turns.length < MIN_TURNS) {
        devLog(`Context evolution skipped: only ${turns.length} turns (need ${MIN_TURNS})`);
        return;
      }

      const now = Date.now();
      if (now - this.lastEvolvedAt < RATE_LIMIT_MS) {
        devLog("Context evolution skipped: rate limited");
        return;
      }

      const messages = buildExtractionMessages(turns, this.currentProfile);
      const output = await this.provider.generateTurn({ messages });

      if (output.type !== "assistant" || !output.content) {
        devWarn("Context evolution: unexpected LLM output type");
        return;
      }

      const parsed = this.parseResponse(output.content);
      if (!parsed) return;

      if (parsed.confidence === "none" || parsed.confidence === "low") {
        devLog(`Context evolution skipped: confidence is "${parsed.confidence}"`);
        return;
      }

      const profilePatch = validateProfilePatch(parsed.user_profile_patch);

      const mergedProfile = profilePatch
        ? mergeProfilePatch(this.currentProfile, profilePatch)
        : this.currentProfile;

      if (!isUserProfileContext(mergedProfile)) {
        devWarn("Context evolution: merged profile failed validation, aborting");
        return;
      }

      const profilePath = resolve(this.contextDir, "user_profile.json");

      await backupFile(profilePath, this.historyDir, "user_profile");
      await writeJsonFileAtomic(profilePath, mergedProfile);

      this.currentProfile = mergedProfile;
      this.lastEvolvedAt = Date.now();

      devLog(`Context evolution complete: ${parsed.reasoning}`);

      this.onContextUpdated?.({ userProfile: mergedProfile });
    } catch (err) {
      devWarn("Context evolution failed:", err instanceof Error ? err.message : String(err));
    }
  }

  private parseResponse(raw: string): EvolutionResponse | null {
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }

    try {
      const parsed = JSON.parse(cleaned) as EvolutionResponse;
      if (!parsed.confidence || !parsed.user_profile_patch) {
        devWarn("Context evolution: response missing required fields");
        return null;
      }
      return parsed;
    } catch {
      devWarn("Context evolution: failed to parse LLM JSON response");
      return null;
    }
  }
}
