import {
  DEFAULT_HOT_CONTEXT_MAX_KEYS_PER_LOAD,
  DEFAULT_HOT_CONTEXT_MAX_MOUNTED_TOKENS,
  emptyHotContextProjection,
  type HotContextCatalogEntry,
  type HotContextLoadReceipt,
  type HotContextProjection,
  type HotContextSource,
  type HotContextSourceEntry,
  type MountedHotContextEntry,
} from "./contracts.js";

interface RunHotContextState {
  mounted: Map<string, MountedHotContextEntry>;
  prepared: Map<string, HotContextSourceEntry>;
}

export interface HotContextRuntimeOptions {
  sources: HotContextSource[];
  runScopedKeys?: string[];
  maxMountedTokens?: number;
  maxKeysPerLoad?: number;
}

export interface SyncHotContextRunInput {
  clientId: string;
  runId: string;
  entries: HotContextSourceEntry[];
}

export interface LoadHotContextInput {
  clientId: string;
  runId: string;
  keys: string[];
  stepNumber: number;
}

export class HotContextRuntime {
  private readonly sources = new Map<string, HotContextSource>();
  private readonly runScopedKeys = new Set<string>();
  private readonly runs = new Map<string, RunHotContextState>();
  readonly maxMountedTokens: number;
  readonly maxKeysPerLoad: number;

  constructor(options: HotContextRuntimeOptions) {
    this.maxMountedTokens = positiveInteger(
      options.maxMountedTokens,
      DEFAULT_HOT_CONTEXT_MAX_MOUNTED_TOKENS,
    );
    this.maxKeysPerLoad = positiveInteger(
      options.maxKeysPerLoad,
      DEFAULT_HOT_CONTEXT_MAX_KEYS_PER_LOAD,
    );
    for (const source of options.sources) {
      if (this.sources.has(source.key)) {
        throw new Error(`Duplicate Hot Context source key '${source.key}'.`);
      }
      this.sources.set(source.key, source);
    }
    for (const key of normalizeKeys(options.runScopedKeys ?? [])) {
      if (this.sources.has(key) || this.runScopedKeys.has(key)) {
        throw new Error(`Duplicate Hot Context source key '${key}'.`);
      }
      this.runScopedKeys.add(key);
    }
  }

  keys(): string[] {
    return [...this.sources.keys(), ...this.runScopedKeys].sort();
  }

  syncRun(input: SyncHotContextRunInput): void {
    const state = this.runState(input.clientId, input.runId);
    state.prepared.clear();
    for (const entry of input.entries) {
      if (!this.runScopedKeys.has(entry.key)) {
        throw new Error(`Unknown run-scoped Hot Context key '${entry.key}'.`);
      }
      state.prepared.set(entry.key, copySourceEntry(entry));
    }
    this.invalidateChangedMounts(input.clientId, input.runId, state);
  }

  project(clientId: string, runId: string): HotContextProjection {
    const state = this.runState(clientId, runId);
    this.invalidateChangedMounts(clientId, runId, state);
    const loaded = [...state.mounted.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(copyMountedEntry);
    const loadedKeys = new Set(loaded.map((entry) => entry.key));
    const available = this.readAvailableEntries(clientId, runId, state)
      .filter((entry) => !loadedKeys.has(entry.key))
      .map(toCatalogEntry);
    return {
      available,
      loaded,
      budget: {
        maxMountedTokens: this.maxMountedTokens,
        mountedTokens: totalTokens(loaded),
      },
    };
  }

  load(input: LoadHotContextInput): HotContextLoadReceipt {
    const keys = normalizeKeys(input.keys).slice(0, this.maxKeysPerLoad);
    const state = this.runState(input.clientId, input.runId);
    this.invalidateChangedMounts(input.clientId, input.runId, state);
    const loaded: string[] = [];
    const alreadyLoaded: string[] = [];
    const rejected: HotContextLoadReceipt["rejected"] = [];

    for (const key of keys) {
      const sourceEntry = this.readEntry(input.clientId, input.runId, state, key);
      if (!sourceEntry) {
        rejected.push({ key, reason: "not_available" });
        continue;
      }
      const existing = state.mounted.get(key);
      if (existing?.version === sourceEntry.version) {
        alreadyLoaded.push(key);
        continue;
      }
      const tokensWithoutExisting = mountedTokens(state)
        - (existing?.estimatedTokens ?? 0);
      if (tokensWithoutExisting + sourceEntry.estimatedTokens > this.maxMountedTokens) {
        rejected.push({ key, reason: "token_budget" });
        continue;
      }
      state.mounted.set(key, {
        ...copySourceEntry(sourceEntry),
        mountedAtStep: Math.max(0, Math.trunc(input.stepNumber)),
      });
      loaded.push(key);
    }

    return {
      loaded,
      alreadyLoaded,
      rejected,
      mountedTokens: mountedTokens(state),
      maxMountedTokens: this.maxMountedTokens,
    };
  }

  clearRun(clientId: string, runId: string): void {
    this.runs.delete(runKey(clientId, runId));
  }

  private runState(clientId: string, runId: string): RunHotContextState {
    const key = runKey(clientId, runId);
    const existing = this.runs.get(key);
    if (existing) return existing;
    const created: RunHotContextState = {
      mounted: new Map(),
      prepared: new Map(),
    };
    this.runs.set(key, created);
    return created;
  }

  private invalidateChangedMounts(
    clientId: string,
    runId: string,
    state: RunHotContextState,
  ): void {
    for (const [key, mounted] of state.mounted) {
      const current = this.readEntry(clientId, runId, state, key);
      if (!current || current.version !== mounted.version) {
        state.mounted.delete(key);
      }
    }
  }

  private readAvailableEntries(
    clientId: string,
    runId: string,
    state: RunHotContextState,
  ): HotContextSourceEntry[] {
    return this.keys()
      .map((key) => this.readEntry(clientId, runId, state, key))
      .filter((entry): entry is HotContextSourceEntry => entry !== undefined)
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  private readEntry(
    clientId: string,
    _runId: string,
    state: RunHotContextState,
    key: string,
  ): HotContextSourceEntry | undefined {
    return state.prepared.get(key) ?? this.sources.get(key)?.read(clientId);
  }
}

export function createEmptyHotContextRuntime(): HotContextRuntime {
  return new HotContextRuntime({ sources: [] });
}

function toCatalogEntry(entry: HotContextSourceEntry): HotContextCatalogEntry {
  return {
    key: entry.key,
    description: entry.description,
    version: entry.version,
    estimatedTokens: entry.estimatedTokens,
    freshness: entry.freshness,
    sourceRefs: [...entry.sourceRefs],
  };
}

function copySourceEntry(entry: HotContextSourceEntry): HotContextSourceEntry {
  return {
    ...toCatalogEntry(entry),
    content: entry.content,
  };
}

function copyMountedEntry(entry: MountedHotContextEntry): MountedHotContextEntry {
  return {
    ...copySourceEntry(entry),
    mountedAtStep: entry.mountedAtStep,
  };
}

function mountedTokens(state: RunHotContextState): number {
  return totalTokens([...state.mounted.values()]);
}

function totalTokens(entries: Array<{ estimatedTokens: number }>): number {
  return entries.reduce((total, entry) => total + entry.estimatedTokens, 0);
}

function normalizeKeys(keys: string[]): string[] {
  return [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function runKey(clientId: string, runId: string): string {
  return `${clientId}\u0000${runId}`;
}

export { emptyHotContextProjection };
