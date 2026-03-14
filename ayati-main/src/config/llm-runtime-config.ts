import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = resolve(thisDir, "..", "..");

export const SUPPORTED_LLM_PROVIDERS = ["openrouter", "openai", "anthropic", "fireworks"] as const;

export type SupportedLlmProvider = (typeof SUPPORTED_LLM_PROVIDERS)[number];

export interface LlmRuntimeConfig {
  activeProvider: SupportedLlmProvider;
  models: Record<SupportedLlmProvider, string>;
}

export const DEFAULT_LLM_MODELS: Record<SupportedLlmProvider, string> = {
  openrouter: "nvidia/nemotron-3-super-120b-a12b:free",
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5-20250929",
  fireworks: "fireworks/minimax-m2p5",
};

const DEFAULT_ACTIVE_PROVIDER: SupportedLlmProvider = "openrouter";

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
  };
}

export function getDefaultLlmRuntimeConfigPath(projectRoot: string = defaultProjectRoot): string {
  return resolve(projectRoot, "data", "runtime", "llm-config.json");
}

export function isSupportedLlmProvider(value: string): value is SupportedLlmProvider {
  return SUPPORTED_LLM_PROVIDERS.includes(value as SupportedLlmProvider);
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
  };
}

function cloneLlmRuntimeConfig(config: LlmRuntimeConfig): LlmRuntimeConfig {
  return {
    activeProvider: config.activeProvider,
    models: { ...config.models },
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
