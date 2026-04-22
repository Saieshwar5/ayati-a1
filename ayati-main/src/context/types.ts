export interface SoulContext {
  version: number;
  identity: {
    name?: string;
    role?: string;
    responsibility?: string;
  };
  behavior: {
    traits?: string[];
    working_style?: string[];
    communication?: string[];
  };
  boundaries?: string[];
}

export interface UserProfileContext {
  name: string | null;
  nickname: string | null;
  occupation: string | null;
  location: string | null;
  timezone?: string | null;
  languages: string[];
  interests: string[];
  facts: string[];
  people: string[];
  projects: string[];
  communication: {
    formality: string;
    verbosity: string;
    humor_receptiveness: string;
    emoji_usage: string;
  };
  emotional_patterns: {
    mood_baseline: string;
    stress_triggers: string[];
    joy_triggers: string[];
  };
  active_hours: string | null;
  last_updated: string;
}

export interface ControllerPrompts {
  understand: string;
  direct: string;
  reeval: string;
  systemEvent: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

export function isSoulContext(value: unknown): value is SoulContext {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<SoulContext>;
  if (v.version !== 3) return false;
  if (!v.identity || typeof v.identity !== "object") return false;
  if (!v.behavior || typeof v.behavior !== "object") return false;

  const identity = v.identity;
  const behavior = v.behavior;

  return (
    (identity.name === undefined || typeof identity.name === "string") &&
    (identity.role === undefined || typeof identity.role === "string") &&
    (identity.responsibility === undefined || typeof identity.responsibility === "string") &&
    (behavior.traits === undefined || isStringArray(behavior.traits)) &&
    (behavior.working_style === undefined || isStringArray(behavior.working_style)) &&
    (behavior.communication === undefined || isStringArray(behavior.communication)) &&
    (v.boundaries === undefined || isStringArray(v.boundaries))
  );
}

export function isUserProfileContext(value: unknown): value is UserProfileContext {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<UserProfileContext>;

  return (
    isStringOrNull(v.name) &&
    isStringOrNull(v.nickname) &&
    isStringOrNull(v.occupation) &&
    isStringOrNull(v.location) &&
    (v.timezone === undefined || isStringOrNull(v.timezone)) &&
    isStringArray(v.languages) &&
    isStringArray(v.interests) &&
    isStringArray(v.facts) &&
    isStringArray(v.people) &&
    isStringArray(v.projects) &&
    !!v.communication &&
    typeof v.communication === "object" &&
    typeof v.communication.formality === "string" &&
    typeof v.communication.verbosity === "string" &&
    typeof v.communication.humor_receptiveness === "string" &&
    typeof v.communication.emoji_usage === "string" &&
    !!v.emotional_patterns &&
    typeof v.emotional_patterns === "object" &&
    typeof v.emotional_patterns.mood_baseline === "string" &&
    isStringArray(v.emotional_patterns.stress_triggers) &&
    isStringArray(v.emotional_patterns.joy_triggers) &&
    isStringOrNull(v.active_hours) &&
    typeof v.last_updated === "string"
  );
}

export function emptySoulContext(): SoulContext {
  return {
    version: 3,
    identity: {
      name: "",
      role: "",
      responsibility: "",
    },
    behavior: {
      traits: [],
      working_style: [],
      communication: [],
    },
    boundaries: [],
  };
}

export function emptyUserProfileContext(): UserProfileContext {
  return {
    name: null,
    nickname: null,
    occupation: null,
    location: null,
    timezone: null,
    languages: [],
    interests: [],
    facts: [],
    people: [],
    projects: [],
    communication: {
      formality: "balanced",
      verbosity: "balanced",
      humor_receptiveness: "medium",
      emoji_usage: "rare",
    },
    emotional_patterns: {
      mood_baseline: "unknown",
      stress_triggers: [],
      joy_triggers: [],
    },
    active_hours: null,
    last_updated: new Date(0).toISOString(),
  };
}
