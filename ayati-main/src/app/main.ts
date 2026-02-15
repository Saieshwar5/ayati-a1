import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IVecEngine } from "../ivec/index.js";
import { WsServer } from "../server/index.js";
import pluginFactories from "../config/plugins.js";
import providerFactory from "../config/provider.js";
import { PluginRegistry, loadPlugins, loadProvider } from "../core/index.js";
import { loadStaticContext } from "../context/static-context-cache.js";
import { ContextEvolver } from "../context/context-evolver.js";
import { SessionManager } from "../memory/session-manager.js";
import { createToolExecutor } from "../skills/tool-executor.js";
import { builtInSkillsProvider } from "../skills/provider.js";
import { loadToolAccessConfig, startConfigWatcher, stopConfigWatcher } from "../skills/tool-access-config.js";
import { createIdentitySkill } from "../skills/builtins/identity/index.js";
import { startStoreWatcher } from "../ayati-store/watcher.js";
import { devLog } from "../shared/index.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");

const CLIENT_ID = "local";

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function buildContextRecallConfig(): {
  enabled?: boolean;
  limits?: {
    maxMatchedSessions?: number;
    recursionDepth?: number;
    maxTurnsPerSession?: number;
    evidenceTokenBudget?: number;
    totalRecallMs?: number;
    maxEvidenceItems?: number;
    maxModelCalls?: number;
    maxChunkSelections?: number;
    maxChunkBranches?: number;
    maxLeafTurns?: number;
    maxEvidencePerLeaf?: number;
    decisionContextTurns?: number;
  };
} {
  return {
    enabled: process.env["AUTO_CONTEXT_RECALL_ENABLED"] !== "0",
    limits: {
      maxMatchedSessions: readPositiveIntEnv("AUTO_CONTEXT_RECALL_MAX_MATCHED_SESSIONS"),
      recursionDepth: readPositiveIntEnv("AUTO_CONTEXT_RECALL_RECURSION_DEPTH"),
      maxTurnsPerSession: readPositiveIntEnv("AUTO_CONTEXT_RECALL_MAX_TURNS_PER_SESSION"),
      evidenceTokenBudget: readPositiveIntEnv("AUTO_CONTEXT_RECALL_EVIDENCE_TOKEN_BUDGET"),
      totalRecallMs: readPositiveIntEnv("AUTO_CONTEXT_RECALL_TOTAL_MS"),
      maxEvidenceItems: readPositiveIntEnv("AUTO_CONTEXT_RECALL_MAX_EVIDENCE_ITEMS"),
      maxModelCalls: readPositiveIntEnv("AUTO_CONTEXT_RECALL_MAX_MODEL_CALLS"),
      maxChunkSelections: readPositiveIntEnv("AUTO_CONTEXT_RECALL_MAX_CHUNK_SELECTIONS"),
      maxChunkBranches: readPositiveIntEnv("AUTO_CONTEXT_RECALL_MAX_CHUNK_BRANCHES"),
      maxLeafTurns: readPositiveIntEnv("AUTO_CONTEXT_RECALL_MAX_LEAF_TURNS"),
      maxEvidencePerLeaf: readPositiveIntEnv("AUTO_CONTEXT_RECALL_MAX_EVIDENCE_PER_LEAF"),
      decisionContextTurns: readPositiveIntEnv("AUTO_CONTEXT_RECALL_DECISION_CONTEXT_TURNS"),
    },
  };
}

export async function main(): Promise<void> {
  const provider = await loadProvider(providerFactory);
  await loadToolAccessConfig();
  startConfigWatcher();
  const storeWatcher = await startStoreWatcher(resolve(projectRoot, "src", "ayati-store"));
  storeWatcher.on("skill-added", (meta) => devLog(`Skill detected: ${meta.id} v${meta.version}`));
  storeWatcher.on("skill-removed", (meta) => devLog(`Skill removed: ${meta.id}`));
  const enabledTools = await builtInSkillsProvider.getAllTools();
  let engine: IVecEngine | null = null;

  const identitySkill = createIdentitySkill({
    onSoulUpdated: (updatedSoul) => {
      staticContext.soul = updatedSoul;
      engine?.invalidateStaticTokenCache();
    },
  });

  const allToolDefs = [...enabledTools, ...identitySkill.tools];
  const toolExecutor = createToolExecutor(allToolDefs);

  const staticContext = await loadStaticContext({ toolDefinitions: allToolDefs });
  staticContext.skillBlocks.push({ id: identitySkill.id, content: identitySkill.promptBlock });

  const contextEvolver = new ContextEvolver({
    provider,
    contextDir: resolve(projectRoot, "context"),
    historyDir: resolve(projectRoot, "data", "context-history"),
    currentProfile: staticContext.userProfile,
    onContextUpdated: (updated) => {
      staticContext.userProfile = updated.userProfile;
      engine?.invalidateStaticTokenCache();
    },
  });

  const sessionMemory = new SessionManager({
    provider,
    onSessionClose: (data) => {
      void contextEvolver.evolveFromSession(data.turns);
    },
  });
  sessionMemory.initialize(CLIENT_ID);

  const wsServer = new WsServer({
    onMessage: (clientId, data) => engine?.handleMessage(clientId, data),
  });
  engine = new IVecEngine({
    onReply: wsServer.send.bind(wsServer),
    provider,
    staticContext,
    toolExecutor,
    sessionMemory,
    contextRecall: buildContextRecallConfig(),
  });
  const registry = new PluginRegistry();

  const plugins = await loadPlugins(pluginFactories);
  for (const plugin of plugins) {
    registry.register(plugin);
  }

  await engine.start();
  await wsServer.start();
  await registry.startAll();

  console.log(`Ayati i-vec ready — plugins: [${registry.list().join(", ")}]`);

  const shutdown = async (): Promise<void> => {
    storeWatcher.stop();
    stopConfigWatcher();
    await registry.stopAll();
    await wsServer.stop();
    await engine.stop();
    await sessionMemory.shutdown();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
