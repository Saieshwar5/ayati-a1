import type { UserProfileContext } from "./types.js";
import type { UserProfilePatch } from "./evolution-types.js";

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
