export interface UserProfilePatch {
  name?: string;
  nickname?: string;
  occupation?: string;
  location?: string;
  languages?: string[];
  interests?: string[];
  facts?: string[];
  people?: string[];
  projects?: string[];
  communication?: Partial<{
    formality: string;
    verbosity: string;
    humor_receptiveness: string;
    emoji_usage: string;
  }>;
  emotional_patterns?: Partial<{
    mood_baseline: string;
    stress_triggers: string[];
    joy_triggers: string[];
  }>;
  active_hours?: string;
}

export type EvolutionConfidence = "none" | "low" | "medium" | "high";

export interface EvolutionResponse {
  user_profile_patch: UserProfilePatch;
  confidence: EvolutionConfidence;
  reasoning: string;
}
