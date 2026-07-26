export const PERSONAL_MEMORY_HOT_CONTEXT_KEY = "personal.memory";
export const DEFAULT_HOT_CONTEXT_MAX_MOUNTED_TOKENS = 8_000;
export const DEFAULT_HOT_CONTEXT_MAX_KEYS_PER_LOAD = 8;

export type HotContextFreshness = "current";

export interface HotContextCatalogEntry {
  key: string;
  description: string;
  version: string;
  estimatedTokens: number;
  freshness: HotContextFreshness;
  sourceRefs: string[];
}

export interface HotContextSourceEntry extends HotContextCatalogEntry {
  content: string;
}

export interface MountedHotContextEntry extends HotContextSourceEntry {
  mountedAtStep: number;
}

export interface HotContextProjection {
  available: HotContextCatalogEntry[];
  loaded: MountedHotContextEntry[];
  budget: {
    maxMountedTokens: number;
    mountedTokens: number;
  };
}

export type HotContextLoadRejectionReason =
  | "not_available"
  | "token_budget";

export interface HotContextLoadReceipt {
  loaded: string[];
  alreadyLoaded: string[];
  rejected: Array<{
    key: string;
    reason: HotContextLoadRejectionReason;
  }>;
  mountedTokens: number;
  maxMountedTokens: number;
}

export interface HotContextSource {
  readonly key: string;
  read(clientId: string): HotContextSourceEntry | undefined;
}

export function emptyHotContextProjection(
  maxMountedTokens = DEFAULT_HOT_CONTEXT_MAX_MOUNTED_TOKENS,
): HotContextProjection {
  return {
    available: [],
    loaded: [],
    budget: {
      maxMountedTokens,
      mountedTokens: 0,
    },
  };
}
