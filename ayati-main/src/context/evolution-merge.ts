import type { UserProfileContext } from "./types.js";
import type {
  EvolutionConfidence,
  ProfileFieldSource,
  UserProfilePatch,
  UserProfilePatchSources,
} from "./evolution-types.js";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function appendUnique(existing: string[], additions: string[]): string[] {
  const lowerSet = new Set(existing.map((s) => s.toLowerCase()));
  const result = [...existing];
  for (const item of additions) {
    const lower = item.toLowerCase();
    if (!lowerSet.has(lower)) {
      lowerSet.add(lower);
      result.push(item);
    }
  }
  return result;
}

function isProfileFieldSource(value: unknown): value is ProfileFieldSource {
  return value === "explicit" || value === "inferred";
}

function shouldPersistAutoField(
  source: ProfileFieldSource | undefined,
  confidence: EvolutionConfidence,
): boolean {
  if (source === "explicit") {
    return confidence === "medium" || confidence === "high";
  }
  if (source === "inferred") {
    return confidence === "high";
  }
  return false;
}

function shouldPersistConservativeField(
  source: ProfileFieldSource | undefined,
  confidence: EvolutionConfidence,
): boolean {
  return source === "explicit" && confidence === "high";
}

function hasKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

export function validateProfilePatch(raw: unknown): UserProfilePatch | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const patch: UserProfilePatch = {};

  const stringFields = [
    "name", "nickname", "occupation", "location", "active_hours",
  ] as const;

  for (const field of stringFields) {
    if (typeof obj[field] === "string") {
      (patch as Record<string, unknown>)[field] = obj[field];
    }
  }

  const arrayFields = [
    "languages", "interests", "facts", "people", "projects",
  ] as const;

  for (const field of arrayFields) {
    if (isStringArray(obj[field])) {
      (patch as Record<string, unknown>)[field] = obj[field];
    }
  }

  if (obj["communication"] && typeof obj["communication"] === "object") {
    const comm = obj["communication"] as Record<string, unknown>;
    const commPatch: Record<string, string> = {};
    for (const key of ["formality", "verbosity", "humor_receptiveness", "emoji_usage"]) {
      if (typeof comm[key] === "string") {
        commPatch[key] = comm[key] as string;
      }
    }
    if (Object.keys(commPatch).length > 0) {
      patch.communication = commPatch as UserProfilePatch["communication"];
    }
  }

  if (obj["emotional_patterns"] && typeof obj["emotional_patterns"] === "object") {
    const emo = obj["emotional_patterns"] as Record<string, unknown>;
    const emoPatch: Record<string, unknown> = {};
    if (typeof emo["mood_baseline"] === "string") {
      emoPatch["mood_baseline"] = emo["mood_baseline"];
    }
    if (isStringArray(emo["stress_triggers"])) {
      emoPatch["stress_triggers"] = emo["stress_triggers"];
    }
    if (isStringArray(emo["joy_triggers"])) {
      emoPatch["joy_triggers"] = emo["joy_triggers"];
    }
    if (Object.keys(emoPatch).length > 0) {
      patch.emotional_patterns = emoPatch as UserProfilePatch["emotional_patterns"];
    }
  }

  return patch;
}

export function validateProfilePatchSources(raw: unknown): UserProfilePatchSources | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const sources: UserProfilePatchSources = {};

  const scalarFields = [
    "name", "nickname", "occupation", "location", "languages", "interests", "facts", "people", "projects", "active_hours",
  ] as const;

  for (const field of scalarFields) {
    if (isProfileFieldSource(obj[field])) {
      (sources as Record<string, unknown>)[field] = obj[field];
    }
  }

  if (obj["communication"] && typeof obj["communication"] === "object") {
    const comm = obj["communication"] as Record<string, unknown>;
    const commSources: Record<string, ProfileFieldSource> = {};
    for (const key of ["formality", "verbosity", "humor_receptiveness", "emoji_usage"] as const) {
      if (isProfileFieldSource(comm[key])) {
        commSources[key] = comm[key];
      }
    }
    if (hasKeys(commSources)) {
      sources.communication = commSources as UserProfilePatchSources["communication"];
    }
  }

  if (obj["emotional_patterns"] && typeof obj["emotional_patterns"] === "object") {
    const emotional = obj["emotional_patterns"] as Record<string, unknown>;
    const emotionalSources: Record<string, ProfileFieldSource> = {};
    for (const key of ["mood_baseline", "stress_triggers", "joy_triggers"] as const) {
      if (isProfileFieldSource(emotional[key])) {
        emotionalSources[key] = emotional[key];
      }
    }
    if (hasKeys(emotionalSources)) {
      sources.emotional_patterns = emotionalSources as UserProfilePatchSources["emotional_patterns"];
    }
  }

  return sources;
}

export function filterProfilePatchByPolicy(
  patch: UserProfilePatch,
  sources: UserProfilePatchSources | null,
  confidence: EvolutionConfidence,
): UserProfilePatch {
  const filtered: UserProfilePatch = {};

  const autoStringFields = ["name", "nickname", "occupation", "active_hours"] as const;
  for (const field of autoStringFields) {
    const value = patch[field];
    if (typeof value === "string" && shouldPersistAutoField(sources?.[field], confidence)) {
      filtered[field] = value;
    }
  }

  const autoArrayFields = ["languages", "interests", "projects"] as const;
  for (const field of autoArrayFields) {
    const value = patch[field];
    if (value && value.length > 0 && shouldPersistAutoField(sources?.[field], confidence)) {
      filtered[field] = value;
    }
  }

  const conservativeStringFields = ["location"] as const;
  for (const field of conservativeStringFields) {
    const value = patch[field];
    if (typeof value === "string" && shouldPersistConservativeField(sources?.[field], confidence)) {
      filtered[field] = value;
    }
  }

  const conservativeArrayFields = ["facts", "people"] as const;
  for (const field of conservativeArrayFields) {
    const value = patch[field];
    if (value && value.length > 0 && shouldPersistConservativeField(sources?.[field], confidence)) {
      filtered[field] = value;
    }
  }

  if (patch.communication) {
    const communication: NonNullable<UserProfilePatch["communication"]> = {};
    for (const key of ["formality", "verbosity", "humor_receptiveness", "emoji_usage"] as const) {
      const value = patch.communication[key];
      if (typeof value === "string" && shouldPersistAutoField(sources?.communication?.[key], confidence)) {
        communication[key] = value;
      }
    }
    if (hasKeys(communication as Record<string, unknown>)) {
      filtered.communication = communication;
    }
  }

  if (patch.emotional_patterns) {
    const emotionalPatterns: NonNullable<UserProfilePatch["emotional_patterns"]> = {};
    if (
      typeof patch.emotional_patterns.mood_baseline === "string" &&
      shouldPersistConservativeField(sources?.emotional_patterns?.mood_baseline, confidence)
    ) {
      emotionalPatterns.mood_baseline = patch.emotional_patterns.mood_baseline;
    }
    if (
      patch.emotional_patterns.stress_triggers &&
      patch.emotional_patterns.stress_triggers.length > 0 &&
      shouldPersistConservativeField(sources?.emotional_patterns?.stress_triggers, confidence)
    ) {
      emotionalPatterns.stress_triggers = patch.emotional_patterns.stress_triggers;
    }
    if (
      patch.emotional_patterns.joy_triggers &&
      patch.emotional_patterns.joy_triggers.length > 0 &&
      shouldPersistConservativeField(sources?.emotional_patterns?.joy_triggers, confidence)
    ) {
      emotionalPatterns.joy_triggers = patch.emotional_patterns.joy_triggers;
    }
    if (hasKeys(emotionalPatterns as Record<string, unknown>)) {
      filtered.emotional_patterns = emotionalPatterns;
    }
  }

  return filtered;
}

export function mergeProfilePatch(
  current: UserProfileContext,
  patch: UserProfilePatch,
): UserProfileContext {
  const merged = structuredClone(current);
  let changed = false;

  const stringFields = [
    "name", "nickname", "occupation", "location", "active_hours",
  ] as const;

  for (const field of stringFields) {
    const value = patch[field];
    if (typeof value === "string" && value.length > 0) {
      (merged as unknown as Record<string, unknown>)[field] = value;
      changed = true;
    }
  }

  const arrayFields = [
    "languages", "interests", "facts", "people", "projects",
  ] as const;

  for (const field of arrayFields) {
    const additions = patch[field];
    if (additions && additions.length > 0) {
      const before = merged[field].length;
      merged[field] = appendUnique(merged[field], additions);
      if (merged[field].length > before) changed = true;
    }
  }

  if (patch.communication) {
    for (const [key, value] of Object.entries(patch.communication)) {
      if (typeof value === "string" && value.length > 0) {
        (merged.communication as Record<string, string>)[key] = value;
        changed = true;
      }
    }
  }

  if (patch.emotional_patterns) {
    const ep = patch.emotional_patterns;
    if (typeof ep.mood_baseline === "string" && ep.mood_baseline.length > 0) {
      merged.emotional_patterns.mood_baseline = ep.mood_baseline;
      changed = true;
    }
    if (ep.stress_triggers && ep.stress_triggers.length > 0) {
      const before = merged.emotional_patterns.stress_triggers.length;
      merged.emotional_patterns.stress_triggers = appendUnique(
        merged.emotional_patterns.stress_triggers,
        ep.stress_triggers,
      );
      if (merged.emotional_patterns.stress_triggers.length > before) changed = true;
    }
    if (ep.joy_triggers && ep.joy_triggers.length > 0) {
      const before = merged.emotional_patterns.joy_triggers.length;
      merged.emotional_patterns.joy_triggers = appendUnique(
        merged.emotional_patterns.joy_triggers,
        ep.joy_triggers,
      );
      if (merged.emotional_patterns.joy_triggers.length > before) changed = true;
    }
  }

  if (changed) {
    merged.last_updated = new Date().toISOString();
  }

  return merged;
}
