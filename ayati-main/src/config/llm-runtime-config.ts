import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIN_SUPPORTED_LLM_CONTEXT_WINDOW_TOKENS,
  resolveLlmContextPressureThresholds,
} from "./llm-context-profile.js";
import type { LlmModelContextLimitConfig } from "./llm-context-profile.js";

export {
  DEFAULT_LLM_OUTPUT_RESERVE_TOKENS,
  MIN_SUPPORTED_LLM_CONTEXT_WINDOW_TOKENS,
} from "./llm-context-profile.js";
export type { LlmModelContextLimitConfig } from "./llm-context-profile.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = resolve(thisDir, "..", "..");

export const SUPPORTED_LLM_PROVIDERS = ["openrouter", "openai", "anthropic", "fireworks"] as const;
export const SUPPORTED_EMBEDDING_PROVIDERS = ["openai"] as const;
export const SUPPORTED_IMAGE_GENERATION_PROVIDERS = ["openai"] as const;

export type SupportedLlmProvider = (typeof SUPPORTED_LLM_PROVIDERS)[number];
export type SupportedEmbeddingProvider = (typeof SUPPORTED_EMBEDDING_PROVIDERS)[number];
export type SupportedImageGenerationProvider = (typeof SUPPORTED_IMAGE_GENERATION_PROVIDERS)[number];

export interface EmbeddingRuntimeConfig {
  activeProvider: SupportedEmbeddingProvider;
  models: Record<SupportedEmbeddingProvider, string>;
  dimensions: Record<SupportedEmbeddingProvider, number | null>;
}

export interface ImageGenerationRuntimeConfig {
  activeProvider: SupportedImageGenerationProvider;
  models: Record<SupportedImageGenerationProvider, string>;
}

export interface LlmRuntimeConfig {
  activeProvider: SupportedLlmProvider;
  models: Record<SupportedLlmProvider, string>;
  modelContextLimits: Record<string, LlmModelContextLimitConfig>;
  embeddings: EmbeddingRuntimeConfig;
  imageGeneration: ImageGenerationRuntimeConfig;
}

export const DEFAULT_LLM_MODELS: Record<SupportedLlmProvider, string> = {
  openrouter: "nvidia/nemotron-3-super-120b-a12b:free",
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5-20250929",
  fireworks: "fireworks/minimax-m2p5",
};

export const DEFAULT_EMBEDDING_MODELS: Record<SupportedEmbeddingProvider, string> = {
  openai: "text-embedding-3-small",
};

export const DEFAULT_IMAGE_GENERATION_MODELS: Record<SupportedImageGenerationProvider, string> = {
  openai: "gpt-image-2",
};

const DEFAULT_ACTIVE_PROVIDER: SupportedLlmProvider = "openrouter";
const DEFAULT_ACTIVE_EMBEDDING_PROVIDER: SupportedEmbeddingProvider = "openai";
const DEFAULT_ACTIVE_IMAGE_GENERATION_PROVIDER: SupportedImageGenerationProvider = "openai";

interface LlmRuntimeConfigState {
  config: LlmRuntimeConfig;
  configPath: string;
  initialized: boolean;
}

const state: LlmRuntimeConfigState = {
  config: createDefaultLlmRuntimeConfig(),
  configPath: getDefaultLlmRuntimeConfigPath(),
  initialized: false,
};

export function createDefaultLlmRuntimeConfig(): LlmRuntimeConfig {
  return {
    activeProvider: DEFAULT_ACTIVE_PROVIDER,
    models: { ...DEFAULT_LLM_MODELS },
    modelContextLimits: {},
    embeddings: createDefaultEmbeddingRuntimeConfig(),
    imageGeneration: createDefaultImageGenerationRuntimeConfig(),
  };
}

export function createDefaultEmbeddingRuntimeConfig(): EmbeddingRuntimeConfig {
  return {
    activeProvider: DEFAULT_ACTIVE_EMBEDDING_PROVIDER,
    models: { ...DEFAULT_EMBEDDING_MODELS },
    dimensions: {
      openai: null,
    },
  };
}

export function createDefaultImageGenerationRuntimeConfig(): ImageGenerationRuntimeConfig {
  return {
    activeProvider: DEFAULT_ACTIVE_IMAGE_GENERATION_PROVIDER,
    models: { ...DEFAULT_IMAGE_GENERATION_MODELS },
  };
}

export function getDefaultLlmRuntimeConfigPath(projectRoot: string = defaultProjectRoot): string {
  return resolve(projectRoot, "data", "runtime", "llm-config.json");
}

export function isSupportedLlmProvider(value: string): value is SupportedLlmProvider {
  return SUPPORTED_LLM_PROVIDERS.includes(value as SupportedLlmProvider);
}

export function isSupportedEmbeddingProvider(value: string): value is SupportedEmbeddingProvider {
  return SUPPORTED_EMBEDDING_PROVIDERS.includes(value as SupportedEmbeddingProvider);
}

export function isSupportedImageGenerationProvider(value: string): value is SupportedImageGenerationProvider {
  return SUPPORTED_IMAGE_GENERATION_PROVIDERS.includes(value as SupportedImageGenerationProvider);
}

export async function initializeLlmRuntimeConfig(options?: {
  configPath?: string;
  projectRoot?: string;
}): Promise<LlmRuntimeConfig> {
  const configPath = options?.configPath ?? getDefaultLlmRuntimeConfigPath(options?.projectRoot);
  const config = await loadOrCreateLlmRuntimeConfig(configPath);

  state.config = config;
  state.configPath = configPath;
  state.initialized = true;

  return cloneLlmRuntimeConfig(config);
}

export function getLlmRuntimeConfig(): LlmRuntimeConfig {
  return cloneLlmRuntimeConfig(state.config);
}

export function getActiveProvider(): SupportedLlmProvider {
  return state.config.activeProvider;
}

export function getModelForProvider(provider: SupportedLlmProvider): string {
  return state.config.models[provider];
}

export function getConfiguredModelContextLimits(
  provider: SupportedLlmProvider,
  model: string = getModelForProvider(provider),
): LlmModelContextLimitConfig | undefined {
  const limits = state.config.modelContextLimits[modelContextLimitKey(provider, model)];
  return limits ? { ...limits } : undefined;
}

export function getActiveEmbeddingProvider(): SupportedEmbeddingProvider {
  return state.config.embeddings.activeProvider;
}

export function getEmbeddingModelForProvider(provider: SupportedEmbeddingProvider): string {
  return state.config.embeddings.models[provider];
}

export function getEmbeddingDimensionsForProvider(provider: SupportedEmbeddingProvider): number | undefined {
  return state.config.embeddings.dimensions[provider] ?? undefined;
}

export function getActiveImageGenerationProvider(): SupportedImageGenerationProvider {
  return state.config.imageGeneration.activeProvider;
}

export function getImageGenerationModelForProvider(provider: SupportedImageGenerationProvider): string {
  return state.config.imageGeneration.models[provider];
}

export async function setActiveProvider(provider: SupportedLlmProvider): Promise<LlmRuntimeConfig> {
  return updateLlmRuntimeConfig((current) => ({
    ...current,
    activeProvider: provider,
  }));
}

export async function setModelForProvider(
  provider: SupportedLlmProvider,
  model: string,
): Promise<LlmRuntimeConfig> {
  const normalizedModel = model.trim();
  if (normalizedModel.length === 0) {
    throw new Error(`Model for provider "${provider}" must not be empty.`);
  }

  return updateLlmRuntimeConfig((current) => ({
    ...current,
    models: {
      ...current.models,
      [provider]: normalizedModel,
    },
  }));
}

export async function setModelContextLimitsForProvider(
  provider: SupportedLlmProvider,
  limits: LlmModelContextLimitConfig,
): Promise<LlmRuntimeConfig> {
  const normalizedLimits = normalizeModelContextLimit(limits, `modelContextLimits.${provider}`);
  return updateLlmRuntimeConfig((current) => ({
    ...current,
    modelContextLimits: {
      ...current.modelContextLimits,
      [modelContextLimitKey(provider, current.models[provider])]: normalizedLimits,
    },
  }));
}

export async function setActiveEmbeddingProvider(
  provider: SupportedEmbeddingProvider,
): Promise<LlmRuntimeConfig> {
  return updateLlmRuntimeConfig((current) => ({
    ...current,
    embeddings: {
      ...current.embeddings,
      activeProvider: provider,
    },
  }));
}

export async function setEmbeddingModelForProvider(
  provider: SupportedEmbeddingProvider,
  model: string,
): Promise<LlmRuntimeConfig> {
  const normalizedModel = model.trim();
  if (normalizedModel.length === 0) {
    throw new Error(`Embedding model for provider "${provider}" must not be empty.`);
  }

  return updateLlmRuntimeConfig((current) => ({
    ...current,
    embeddings: {
      ...current.embeddings,
      models: {
        ...current.embeddings.models,
        [provider]: normalizedModel,
      },
    },
  }));
}

export async function setEmbeddingDimensionsForProvider(
  provider: SupportedEmbeddingProvider,
  dimensions: number | null,
): Promise<LlmRuntimeConfig> {
  if (dimensions !== null && (!Number.isInteger(dimensions) || dimensions <= 0)) {
    throw new Error(`Embedding dimensions for provider "${provider}" must be a positive integer or null.`);
  }

  return updateLlmRuntimeConfig((current) => ({
    ...current,
    embeddings: {
      ...current.embeddings,
      dimensions: {
        ...current.embeddings.dimensions,
        [provider]: dimensions,
      },
    },
  }));
}

export async function setActiveImageGenerationProvider(
  provider: SupportedImageGenerationProvider,
): Promise<LlmRuntimeConfig> {
  return updateLlmRuntimeConfig((current) => ({
    ...current,
    imageGeneration: {
      ...current.imageGeneration,
      activeProvider: provider,
    },
  }));
}

export async function setImageGenerationModelForProvider(
  provider: SupportedImageGenerationProvider,
  model: string,
): Promise<LlmRuntimeConfig> {
  const normalizedModel = model.trim();
  if (normalizedModel.length === 0) {
    throw new Error(`Image generation model for provider "${provider}" must not be empty.`);
  }

  return updateLlmRuntimeConfig((current) => ({
    ...current,
    imageGeneration: {
      ...current.imageGeneration,
      models: {
        ...current.imageGeneration.models,
        [provider]: normalizedModel,
      },
    },
  }));
}

export function resetLlmRuntimeConfigForTests(): void {
  state.config = createDefaultLlmRuntimeConfig();
  state.configPath = getDefaultLlmRuntimeConfigPath();
  state.initialized = false;
}

async function updateLlmRuntimeConfig(
  updater: (current: LlmRuntimeConfig) => LlmRuntimeConfig,
): Promise<LlmRuntimeConfig> {
  if (!state.initialized) {
    await initializeLlmRuntimeConfig();
  }

  const nextConfig = normalizeLlmRuntimeConfig(updater(cloneLlmRuntimeConfig(state.config)));
  await writeLlmRuntimeConfigFile(state.configPath, nextConfig);
  state.config = nextConfig;

  return cloneLlmRuntimeConfig(nextConfig);
}

async function loadOrCreateLlmRuntimeConfig(configPath: string): Promise<LlmRuntimeConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeLlmRuntimeConfig(parsed);
    const normalizedJson = serializeLlmRuntimeConfig(normalized);

    if (raw !== normalizedJson) {
      await writeLlmRuntimeConfigFile(configPath, normalized);
    }

    return normalized;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in LLM runtime config at "${configPath}".`);
      }
      throw error;
    }
  }

  const config = createDefaultLlmRuntimeConfig();
  await writeLlmRuntimeConfigFile(configPath, config);
  return config;
}

function normalizeLlmRuntimeConfig(input: unknown): LlmRuntimeConfig {
  if (!isPlainObject(input)) {
    throw new Error("Invalid LLM runtime config: expected an object.");
  }

  const rawActiveProvider = input["activeProvider"];
  if (typeof rawActiveProvider !== "string" || !isSupportedLlmProvider(rawActiveProvider)) {
    throw new Error(
      `Invalid LLM runtime config: unsupported activeProvider "${String(rawActiveProvider)}".`,
    );
  }

  const rawModels = input["models"];
  if (!isPlainObject(rawModels)) {
    throw new Error("Invalid LLM runtime config: expected models to be an object.");
  }

  const models = {} as Record<SupportedLlmProvider, string>;
  for (const provider of SUPPORTED_LLM_PROVIDERS) {
    const configuredModel = rawModels[provider];
    if (typeof configuredModel === "string" && configuredModel.trim().length > 0) {
      models[provider] = configuredModel.trim();
      continue;
    }
    models[provider] = DEFAULT_LLM_MODELS[provider];
  }

  return {
    activeProvider: rawActiveProvider,
    models,
    modelContextLimits: normalizeModelContextLimits(input["modelContextLimits"]),
    embeddings: normalizeEmbeddingRuntimeConfig(input["embeddings"]),
    imageGeneration: normalizeImageGenerationRuntimeConfig(input["imageGeneration"]),
  };
}

function normalizeModelContextLimits(input: unknown): Record<string, LlmModelContextLimitConfig> {
  if (input === undefined) {
    return {};
  }
  if (!isPlainObject(input)) {
    throw new Error("Invalid LLM runtime config: expected modelContextLimits to be an object.");
  }
  const limits: Record<string, LlmModelContextLimitConfig> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!key.trim()) {
      throw new Error("Invalid LLM runtime config: modelContextLimits keys must not be empty.");
    }
    limits[key] = normalizeModelContextLimit(value, `modelContextLimits.${key}`);
  }
  return limits;
}

function normalizeModelContextLimit(input: unknown, path: string): LlmModelContextLimitConfig {
  if (!isPlainObject(input)) {
    throw new Error(`Invalid LLM runtime config: expected ${path} to be an object.`);
  }
  const contextWindowTokens = readPositiveInteger(input["contextWindowTokens"], `${path}.contextWindowTokens`);
  if (contextWindowTokens < MIN_SUPPORTED_LLM_CONTEXT_WINDOW_TOKENS) {
    throw new Error(
      `Invalid LLM runtime config: ${path}.contextWindowTokens must be at least ${MIN_SUPPORTED_LLM_CONTEXT_WINDOW_TOKENS}.`,
    );
  }
  const maxInputTokens = readOptionalPositiveInteger(input["maxInputTokens"], `${path}.maxInputTokens`);
  const outputReserveTokens = readOptionalPositiveInteger(input["outputReserveTokens"], `${path}.outputReserveTokens`);
  const softInputTokens = readOptionalPositiveInteger(input["softInputTokens"], `${path}.softInputTokens`);
  const recoveryTargetTokens = readOptionalPositiveInteger(input["recoveryTargetTokens"], `${path}.recoveryTargetTokens`);
  const hardInputTokens = readOptionalPositiveInteger(input["hardInputTokens"], `${path}.hardInputTokens`);
  if (maxInputTokens !== undefined && maxInputTokens > contextWindowTokens) {
    throw new Error(`Invalid LLM runtime config: ${path}.maxInputTokens must not exceed contextWindowTokens.`);
  }
  if (outputReserveTokens !== undefined && outputReserveTokens >= contextWindowTokens) {
    throw new Error(`Invalid LLM runtime config: ${path}.outputReserveTokens must be smaller than contextWindowTokens.`);
  }
  const normalized = {
    contextWindowTokens,
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    ...(outputReserveTokens !== undefined ? { outputReserveTokens } : {}),
    ...(softInputTokens !== undefined ? { softInputTokens } : {}),
    ...(recoveryTargetTokens !== undefined ? { recoveryTargetTokens } : {}),
    ...(hardInputTokens !== undefined ? { hardInputTokens } : {}),
  };
  try {
    resolveLlmContextPressureThresholds(normalized);
  } catch (error) {
    throw new Error(`Invalid LLM runtime config: ${path}.${error instanceof Error ? error.message : String(error)}.`);
  }
  return normalized;
}

function normalizeEmbeddingRuntimeConfig(input: unknown): EmbeddingRuntimeConfig {
  if (input === undefined) {
    return createDefaultEmbeddingRuntimeConfig();
  }
  if (!isPlainObject(input)) {
    throw new Error("Invalid LLM runtime config: expected embeddings to be an object.");
  }

  const rawActiveProvider = input["activeProvider"];
  if (typeof rawActiveProvider !== "string" || !isSupportedEmbeddingProvider(rawActiveProvider)) {
    throw new Error(
      `Invalid LLM runtime config: unsupported embeddings.activeProvider "${String(rawActiveProvider)}".`,
    );
  }

  const rawModels = input["models"];
  if (!isPlainObject(rawModels)) {
    throw new Error("Invalid LLM runtime config: expected embeddings.models to be an object.");
  }

  const rawDimensions = input["dimensions"];
  if (rawDimensions !== undefined && !isPlainObject(rawDimensions)) {
    throw new Error("Invalid LLM runtime config: expected embeddings.dimensions to be an object.");
  }

  const models = {} as Record<SupportedEmbeddingProvider, string>;
  const dimensions = {} as Record<SupportedEmbeddingProvider, number | null>;
  for (const provider of SUPPORTED_EMBEDDING_PROVIDERS) {
    const configuredModel = rawModels[provider];
    models[provider] = typeof configuredModel === "string" && configuredModel.trim().length > 0
      ? configuredModel.trim()
      : DEFAULT_EMBEDDING_MODELS[provider];

    const configuredDimensions = rawDimensions?.[provider];
    dimensions[provider] = typeof configuredDimensions === "number"
      && Number.isInteger(configuredDimensions)
      && configuredDimensions > 0
      ? configuredDimensions
      : null;
  }

  return {
    activeProvider: rawActiveProvider,
    models,
    dimensions,
  };
}

function normalizeImageGenerationRuntimeConfig(input: unknown): ImageGenerationRuntimeConfig {
  if (input === undefined) {
    return createDefaultImageGenerationRuntimeConfig();
  }
  if (!isPlainObject(input)) {
    throw new Error("Invalid LLM runtime config: expected imageGeneration to be an object.");
  }

  const rawActiveProvider = input["activeProvider"];
  if (typeof rawActiveProvider !== "string" || !isSupportedImageGenerationProvider(rawActiveProvider)) {
    throw new Error(
      `Invalid LLM runtime config: unsupported imageGeneration.activeProvider "${String(rawActiveProvider)}".`,
    );
  }

  const rawModels = input["models"];
  if (!isPlainObject(rawModels)) {
    throw new Error("Invalid LLM runtime config: expected imageGeneration.models to be an object.");
  }

  const models = {} as Record<SupportedImageGenerationProvider, string>;
  for (const provider of SUPPORTED_IMAGE_GENERATION_PROVIDERS) {
    const configuredModel = rawModels[provider];
    models[provider] = typeof configuredModel === "string" && configuredModel.trim().length > 0
      ? configuredModel.trim()
      : DEFAULT_IMAGE_GENERATION_MODELS[provider];
  }

  return {
    activeProvider: rawActiveProvider,
    models,
  };
}

function cloneLlmRuntimeConfig(config: LlmRuntimeConfig): LlmRuntimeConfig {
  return {
    activeProvider: config.activeProvider,
    models: { ...config.models },
    modelContextLimits: Object.fromEntries(
      Object.entries(config.modelContextLimits).map(([key, limits]) => [key, { ...limits }]),
    ),
    embeddings: {
      activeProvider: config.embeddings.activeProvider,
      models: { ...config.embeddings.models },
      dimensions: { ...config.embeddings.dimensions },
    },
    imageGeneration: {
      activeProvider: config.imageGeneration.activeProvider,
      models: { ...config.imageGeneration.models },
    },
  };
}

function serializeLlmRuntimeConfig(config: LlmRuntimeConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function writeLlmRuntimeConfigFile(configPath: string, config: LlmRuntimeConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.tmp`;
  await writeFile(tempPath, serializeLlmRuntimeConfig(config), "utf8");
  await rename(tempPath, configPath);
}

function modelContextLimitKey(provider: SupportedLlmProvider, model: string): string {
  return `${provider}:${model.trim()}`;
}

function readPositiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`Invalid LLM runtime config: ${path} must be a positive integer.`);
  }
  return value;
}

function readOptionalPositiveInteger(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : readPositiveInteger(value, path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
