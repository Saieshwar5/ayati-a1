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

export type ProfileFieldSource = "explicit" | "inferred";

export interface UserProfilePatchSources {
  name?: ProfileFieldSource;
  nickname?: ProfileFieldSource;
  occupation?: ProfileFieldSource;
  location?: ProfileFieldSource;
  languages?: ProfileFieldSource;
  interests?: ProfileFieldSource;
  facts?: ProfileFieldSource;
  people?: ProfileFieldSource;
  projects?: ProfileFieldSource;
  communication?: Partial<{
    formality: ProfileFieldSource;
    verbosity: ProfileFieldSource;
    humor_receptiveness: ProfileFieldSource;
    emoji_usage: ProfileFieldSource;
  }>;
  emotional_patterns?: Partial<{
    mood_baseline: ProfileFieldSource;
    stress_triggers: ProfileFieldSource;
    joy_triggers: ProfileFieldSource;
  }>;
  active_hours?: ProfileFieldSource;
}

export type EvolutionConfidence = "none" | "low" | "medium" | "high";

export interface EvolutionResponse {
  user_profile_patch: UserProfilePatch;
  field_sources?: UserProfilePatchSources;
  confidence: EvolutionConfidence;
  reasoning: string;
}
