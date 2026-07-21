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
    summaryChars: 2_000,
    maximumItems: 256,
    contextItemChars: 500,
    factChars: 2_000,
    evidenceChars: 2_000,
    artifactChars: 8_192,
    nextStepChars: 1_000,
  },
  workstreamContext: {
    maximumBlockers: 4,
  },
  completion: {
    maximumResources: 256,
    maximumItems: 256,
    missingChars: 1_024,
    failureChars: 2_000,
    criterionChars: 1_000,
    evidenceChars: 2_000,
    descriptionChars: 2_000,
    maximumAliases: 32,
    aliasChars: 500,
  },
} as const;
