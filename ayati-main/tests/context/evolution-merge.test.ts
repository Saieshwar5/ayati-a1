import { describe, it, expect } from "vitest";
import {
  filterProfilePatchByPolicy,
  mergeProfilePatch,
  validateProfilePatch,
  validateProfilePatchSources,
} from "../../src/context/evolution-merge.js";
import { emptyUserProfileContext } from "../../src/context/types.js";
import type { UserProfileContext } from "../../src/context/types.js";

function baseProfile(): UserProfileContext {
  return {
    ...emptyUserProfileContext(),
    name: "Alice",
    interests: ["TypeScript", "music"],
    facts: ["Has a cat"],
  };
}

describe("validateProfilePatch", () => {
  it("returns null for non-object input", () => {
    expect(validateProfilePatch(null)).toBeNull();
    expect(validateProfilePatch("string")).toBeNull();
    expect(validateProfilePatch(42)).toBeNull();
  });

  it("extracts valid string and array fields", () => {
    const patch = validateProfilePatch({
      name: "Bob",
      interests: ["Rust", "Go"],
      garbage: 123,
    });
    expect(patch).not.toBeNull();
    expect(patch!.name).toBe("Bob");
    expect(patch!.interests).toEqual(["Rust", "Go"]);
  });

  it("extracts communication sub-fields", () => {
    const patch = validateProfilePatch({
      communication: { formality: "casual", bad: 99 },
    });
    expect(patch!.communication).toEqual({ formality: "casual" });
  });

  it("extracts emotional_patterns sub-fields", () => {
    const patch = validateProfilePatch({
      emotional_patterns: { mood_baseline: "happy", stress_triggers: ["deadlines"] },
    });
    expect(patch!.emotional_patterns!.mood_baseline).toBe("happy");
    expect(patch!.emotional_patterns!.stress_triggers).toEqual(["deadlines"]);
  });

  it("returns empty patch for object with no valid fields", () => {
    const patch = validateProfilePatch({ foo: "bar" });
    expect(patch).not.toBeNull();
    expect(Object.keys(patch!).length).toBe(0);
  });
});

describe("validateProfilePatchSources", () => {
  it("extracts valid field source values", () => {
    const sources = validateProfilePatchSources({
      name: "explicit",
      interests: "inferred",
      communication: { verbosity: "explicit", bad: "unknown" },
      garbage: 123,
    });

    expect(sources).toEqual({
      name: "explicit",
      interests: "inferred",
      communication: { verbosity: "explicit" },
    });
  });

  it("returns null for non-object input", () => {
    expect(validateProfilePatchSources(null)).toBeNull();
    expect(validateProfilePatchSources("nope")).toBeNull();
  });
});

describe("filterProfilePatchByPolicy", () => {
  it("keeps explicit medium-confidence auto-save fields", () => {
    const filtered = filterProfilePatchByPolicy(
      {
        name: "Alice",
        communication: { verbosity: "brief" },
      },
      {
        name: "explicit",
        communication: { verbosity: "explicit" },
      },
      "medium",
    );

    expect(filtered).toEqual({
      name: "Alice",
      communication: { verbosity: "brief" },
    });
  });

  it("drops inferred fields unless confidence is high", () => {
    const filtered = filterProfilePatchByPolicy(
      {
        interests: ["Rust"],
      },
      {
        interests: "inferred",
      },
      "medium",
    );

    expect(filtered).toEqual({});
  });

  it("keeps inferred auto-save fields at high confidence", () => {
    const filtered = filterProfilePatchByPolicy(
      {
        interests: ["Rust"],
      },
      {
        interests: "inferred",
      },
      "high",
    );

    expect(filtered).toEqual({ interests: ["Rust"] });
  });

  it("requires explicit high confidence for conservative fields", () => {
    const mediumConfidence = filterProfilePatchByPolicy(
      {
        location: "Bengaluru",
        emotional_patterns: { joy_triggers: ["shipping code"] },
      },
      {
        location: "explicit",
        emotional_patterns: { joy_triggers: "explicit" },
      },
      "medium",
    );

    expect(mediumConfidence).toEqual({});

    const highConfidence = filterProfilePatchByPolicy(
      {
        location: "Bengaluru",
        emotional_patterns: { joy_triggers: ["shipping code"] },
      },
      {
        location: "explicit",
        emotional_patterns: { joy_triggers: "explicit" },
      },
      "high",
    );

    expect(highConfidence).toEqual({
      location: "Bengaluru",
      emotional_patterns: { joy_triggers: ["shipping code"] },
    });
  });

  it("drops fields without source metadata", () => {
    const filtered = filterProfilePatchByPolicy(
      {
        occupation: "Developer",
      },
      null,
      "high",
    );

    expect(filtered).toEqual({});
  });
});

describe("mergeProfilePatch", () => {
  it("overwrites scalar string fields with non-empty values", () => {
    const result = mergeProfilePatch(baseProfile(), { name: "Bob" });
    expect(result.name).toBe("Bob");
  });

  it("does not downgrade populated fields to empty string", () => {
    const result = mergeProfilePatch(baseProfile(), { name: "" });
    expect(result.name).toBe("Alice");
  });

  it("appends new unique items to arrays (case-insensitive dedup)", () => {
    const result = mergeProfilePatch(baseProfile(), {
      interests: ["Rust", "typescript", "Go"],
    });
    expect(result.interests).toEqual(["TypeScript", "music", "Rust", "Go"]);
  });

  it("preserves original casing when deduplicating", () => {
    const result = mergeProfilePatch(baseProfile(), {
      interests: ["TYPESCRIPT"],
    });
    expect(result.interests).toEqual(["TypeScript", "music"]);
  });

  it("returns unchanged output for empty patch", () => {
    const original = baseProfile();
    const result = mergeProfilePatch(original, {});
    expect(result.interests).toEqual(original.interests);
    expect(result.name).toEqual(original.name);
    expect(result.last_updated).toEqual(original.last_updated);
  });

  it("sets last_updated when any field changes", () => {
    const original = baseProfile();
    const result = mergeProfilePatch(original, { occupation: "Developer" });
    expect(result.last_updated).not.toBe(original.last_updated);
    expect(new Date(result.last_updated).getTime()).toBeGreaterThan(0);
  });

  it("does not update last_updated when nothing changes", () => {
    const original = baseProfile();
    const result = mergeProfilePatch(original, {});
    expect(result.last_updated).toBe(original.last_updated);
  });

  it("merges nested communication sub-fields", () => {
    const result = mergeProfilePatch(baseProfile(), {
      communication: { formality: "casual" },
    });
    expect(result.communication.formality).toBe("casual");
    expect(result.communication.verbosity).toBe("balanced");
  });

  it("merges emotional_patterns sub-fields", () => {
    const result = mergeProfilePatch(baseProfile(), {
      emotional_patterns: {
        mood_baseline: "upbeat",
        joy_triggers: ["coding"],
      },
    });
    expect(result.emotional_patterns.mood_baseline).toBe("upbeat");
    expect(result.emotional_patterns.joy_triggers).toEqual(["coding"]);
  });

  it("does not mutate the original object", () => {
    const original = baseProfile();
    const originalInterests = [...original.interests];
    mergeProfilePatch(original, { interests: ["Rust"] });
    expect(original.interests).toEqual(originalInterests);
  });
});
