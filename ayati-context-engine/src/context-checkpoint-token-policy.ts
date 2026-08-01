export const CONTEXT_CHECKPOINT_HARD_MAX_TOKENS = 4_000;
export const CONTEXT_CHECKPOINT_MINIMUM_CEILING_TOKENS = 1_600;

/**
 * The requested checkpoint size is a compactness target, not a validity
 * boundary. Generation and persistence share this ceiling so they cannot
 * disagree about whether the same candidate is valid.
 */
export function contextCheckpointMaximumTokens(targetTokens: number): number {
  const target = Math.max(1, Math.trunc(targetTokens));
  return Math.min(
    CONTEXT_CHECKPOINT_HARD_MAX_TOKENS,
    Math.max(target * 2, CONTEXT_CHECKPOINT_MINIMUM_CEILING_TOKENS),
  );
}
