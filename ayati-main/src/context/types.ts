export interface SoulContext {
  version: number;
  soul: {
    name?: string;
    identity?: string;
    personality?: string[];
    values?: string[];
  };
  voice: {
    tone?: string[];
    style?: string[];
    quirks?: string[];
    never_do?: string[];
  };
}

export interface UserProfileContext {
  name: string | null;
  nickname: string | null;
  occupation: string | null;
  location: string | null;
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

export function isSoulContext(value: unknown): value is SoulContext {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<SoulContext>;
  if (typeof v.version !== "number") return false;
  if (!v.soul || typeof v.soul !== "object") return false;
  if (!v.voice || typeof v.voice !== "object") return false;

  const soul = v.soul;
  const voice = v.voice;

  return (
    (soul.name === undefined || typeof soul.name === "string") &&
    (soul.identity === undefined || typeof soul.identity === "string") &&
    (soul.personality === undefined || isStringArray(soul.personality)) &&
    (soul.values === undefined || isStringArray(soul.values)) &&
    (voice.tone === undefined || isStringArray(voice.tone)) &&
    (voice.style === undefined || isStringArray(voice.style)) &&
    (voice.quirks === undefined || isStringArray(voice.quirks)) &&
    (voice.never_do === undefined || isStringArray(voice.never_do))
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
    version: 1,
    soul: {
      name: "",
      identity: "",
      personality: [],
      values: [],
    },
    voice: {
      tone: [],
      style: [],
      quirks: [],
      never_do: [],
    },
  };
}

export function emptyUserProfileContext(): UserProfileContext {
  return {
    name: null,
    nickname: null,
    occupation: null,
    location: null,
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
