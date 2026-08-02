/**
 * Public size limits for the compact durable projection of a finalized run.
 *
 * `assistantResponse` is intentionally absent: it is the verbatim user-facing
 * response, while the fields below are bounded search, recovery, and context
 * projections derived from that response.
 */
export const RUN_FINALIZATION_LIMITS = {
  streamSummaryChars: 2_000,
  summaryChars: 2_000,
  nextChars: 1_000,
  workState: {
    summaryChars: 1_000,
    maximumPlanItems: 12,
    planIdChars: 32,
    planTaskChars: 240,
    maximumImportantContextItems: 12,
    importantContextValueChars: 320,
    importantContextRefChars: 500,
    nextActionChars: 320,
  },
  workstreamContext: {
    maximumBlockers: 4,
  },
  completion: {
    maximumResources: 256,
    maximumResourceEffects: 512,
    maximumItems: 256,
    missingChars: 1_024,
    failureChars: 2_000,
    criterionChars: 1_000,
    evidenceChars: 2_000,
    maximumProofsPerCriterion: 12,
    outcomeRefChars: 2_000,
    proofKindChars: 120,
    proofSubjectChars: 2_000,
    proofSummaryChars: 500,
    proofToolChars: 200,
    proofSourceRefChars: 2_000,
    descriptionChars: 2_000,
    maximumAliases: 32,
    aliasChars: 500,
  },
} as const;
