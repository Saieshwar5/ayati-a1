import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MemoryPolicy } from "./types.js";

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
  sections: {
    userFacts: {
      maxLiveCards: 50,
      minActiveConfidence: 0.8,
      admissionMargin: 0.1,
      allowInferredFacts: false,
    },
    timeBased: {
      maxLiveCards: 50,
      minActiveConfidence: 0.75,
      admissionMargin: 0.1,
    },
    evolvingMemory: {
      maxLiveCards: 300,
      minActiveConfidence: 0.72,
      admissionMargin: 0.08,
      defaultContextThreshold: 0.45,
      defaultArchiveThreshold: 0.18,
      pressureStartsAtRatio: 0.75,
      decay: {
        stable: {
          curve: "stable",
          graceDays: 30,
          halfLifeDays: 365,
          pressureSensitivity: 0.15,
          contextThreshold: 0.45,
          archiveThreshold: 0.18,
        },
        linear: {
          curve: "linear",
          graceDays: 14,
          halfLifeDays: 120,
          pressureSensitivity: 0.5,
          contextThreshold: 0.45,
          archiveThreshold: 0.18,
        },
        exponential: {
          curve: "exponential",
          graceDays: 7,
          halfLifeDays: 90,
          pressureSensitivity: 0.65,
          contextThreshold: 0.45,
          archiveThreshold: 0.18,
        },
        delayedDrop: {
          curve: "delayed_drop",
          graceDays: 14,
          halfLifeDays: 7,
          pressureSensitivity: 0.8,
          contextThreshold: 0.45,
          archiveThreshold: 0.18,
        },
        superFast: {
          curve: "super_fast",
          graceDays: 0,
          halfLifeDays: 2,
          pressureSensitivity: 1,
          contextThreshold: 0.45,
          archiveThreshold: 0.18,
        },
      },
    },
  },
  extraction: {
    maxTurns: 40,
    maxExistingFacts: 50,
    maxExistingTimed: 50,
    maxExistingEvolving: 50,
    maxProposals: 12,
  },
};

export function loadMemoryPolicy(projectRoot: string): MemoryPolicy {
  const policyPath = resolve(projectRoot, "context", "memory-policy.json");
  if (!existsSync(policyPath)) {
    return structuredClone(DEFAULT_MEMORY_POLICY);
  }

  try {
    const parsed = JSON.parse(readFileSync(policyPath, "utf8")) as Record<string, unknown>;
    return normalizePolicy(parsed);
  } catch {
    return structuredClone(DEFAULT_MEMORY_POLICY);
  }
}

function normalizePolicy(raw: Record<string, unknown>): MemoryPolicy {
  const fallback = structuredClone(DEFAULT_MEMORY_POLICY);
  const rawSections = objectValue(raw["sections"]);
  const rawUserFacts = objectValue(rawSections?.["userFacts"]);
  const rawTimeBased = objectValue(rawSections?.["timeBased"]);
  const rawEvolvingMemory = objectValue(rawSections?.["evolvingMemory"]);
  const rawExtraction = objectValue(raw["extraction"]);

  return {
    sections: {
      userFacts: {
        maxLiveCards: normalizePositiveInt(
          rawUserFacts?.["maxLiveCards"],
          fallback.sections.userFacts.maxLiveCards,
        ),
        minActiveConfidence: normalizeUnitNumber(
          rawUserFacts?.["minActiveConfidence"],
          fallback.sections.userFacts.minActiveConfidence,
        ),
        admissionMargin: normalizeUnitNumber(
          rawUserFacts?.["admissionMargin"],
          fallback.sections.userFacts.admissionMargin,
        ),
        allowInferredFacts: typeof rawUserFacts?.["allowInferredFacts"] === "boolean"
          ? rawUserFacts["allowInferredFacts"] as boolean
          : fallback.sections.userFacts.allowInferredFacts,
      },
      timeBased: {
        maxLiveCards: normalizePositiveInt(
          rawTimeBased?.["maxLiveCards"],
          fallback.sections.timeBased.maxLiveCards,
        ),
        minActiveConfidence: normalizeUnitNumber(
          rawTimeBased?.["minActiveConfidence"],
          fallback.sections.timeBased.minActiveConfidence,
        ),
        admissionMargin: normalizeUnitNumber(
          rawTimeBased?.["admissionMargin"],
          fallback.sections.timeBased.admissionMargin,
        ),
      },
      evolvingMemory: {
        maxLiveCards: normalizePositiveInt(
          rawEvolvingMemory?.["maxLiveCards"],
          fallback.sections.evolvingMemory.maxLiveCards,
        ),
        minActiveConfidence: normalizeUnitNumber(
          rawEvolvingMemory?.["minActiveConfidence"],
          fallback.sections.evolvingMemory.minActiveConfidence,
        ),
        admissionMargin: normalizeUnitNumber(
          rawEvolvingMemory?.["admissionMargin"],
          fallback.sections.evolvingMemory.admissionMargin,
        ),
        defaultContextThreshold: normalizeUnitNumber(
          rawEvolvingMemory?.["defaultContextThreshold"],
          fallback.sections.evolvingMemory.defaultContextThreshold,
        ),
        defaultArchiveThreshold: normalizeArchiveThreshold(
          rawEvolvingMemory?.["defaultArchiveThreshold"],
          fallback.sections.evolvingMemory.defaultArchiveThreshold,
          normalizeUnitNumber(
            rawEvolvingMemory?.["defaultContextThreshold"],
            fallback.sections.evolvingMemory.defaultContextThreshold,
          ),
        ),
        pressureStartsAtRatio: normalizeUnitNumber(
          rawEvolvingMemory?.["pressureStartsAtRatio"],
          fallback.sections.evolvingMemory.pressureStartsAtRatio,
        ),
        decay: {
          stable: normalizeDecayConfig(
            objectValue(objectValue(rawEvolvingMemory?.["decay"])?.["stable"]),
            fallback.sections.evolvingMemory.decay.stable,
          ),
          linear: normalizeDecayConfig(
            objectValue(objectValue(rawEvolvingMemory?.["decay"])?.["linear"]),
            fallback.sections.evolvingMemory.decay.linear,
          ),
          exponential: normalizeDecayConfig(
            objectValue(objectValue(rawEvolvingMemory?.["decay"])?.["exponential"]),
            fallback.sections.evolvingMemory.decay.exponential,
          ),
          delayedDrop: normalizeDecayConfig(
            objectValue(objectValue(rawEvolvingMemory?.["decay"])?.["delayedDrop"]),
            fallback.sections.evolvingMemory.decay.delayedDrop,
          ),
          superFast: normalizeDecayConfig(
            objectValue(objectValue(rawEvolvingMemory?.["decay"])?.["superFast"]),
            fallback.sections.evolvingMemory.decay.superFast,
          ),
        },
      },
    },
    extraction: {
      maxTurns: normalizePositiveInt(rawExtraction?.["maxTurns"], fallback.extraction.maxTurns),
      maxExistingFacts: normalizePositiveInt(
        rawExtraction?.["maxExistingFacts"],
        fallback.extraction.maxExistingFacts,
      ),
      maxExistingTimed: normalizePositiveInt(
        rawExtraction?.["maxExistingTimed"],
        fallback.extraction.maxExistingTimed,
      ),
      maxExistingEvolving: normalizePositiveInt(
        rawExtraction?.["maxExistingEvolving"],
        fallback.extraction.maxExistingEvolving,
      ),
      maxProposals: normalizePositiveInt(rawExtraction?.["maxProposals"], fallback.extraction.maxProposals),
    },
  };
}

function normalizeDecayConfig(
  raw: Record<string, unknown> | undefined,
  fallback: MemoryPolicy["sections"]["evolvingMemory"]["decay"]["stable"],
): MemoryPolicy["sections"]["evolvingMemory"]["decay"]["stable"] {
  const contextThreshold = normalizeUnitNumber(raw?.["contextThreshold"], fallback.contextThreshold);
  return {
    curve: fallback.curve,
    graceDays: normalizeBoundedInt(raw?.["graceDays"], fallback.graceDays, 0, 180),
    halfLifeDays: normalizeBoundedInt(raw?.["halfLifeDays"], fallback.halfLifeDays, 1, 365),
    pressureSensitivity: normalizeUnitNumber(raw?.["pressureSensitivity"], fallback.pressureSensitivity),
    contextThreshold,
    archiveThreshold: normalizeArchiveThreshold(raw?.["archiveThreshold"], fallback.archiveThreshold, contextThreshold),
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeUnitNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeArchiveThreshold(value: unknown, fallback: number, contextThreshold: number): number {
  const normalized = normalizeUnitNumber(value, fallback);
  return Math.min(normalized, Math.max(0.01, contextThreshold - 0.01));
}

function normalizeBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}
