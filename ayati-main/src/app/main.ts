import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IVecEngine } from "../ivec/index.js";
import { loadTelegramRuntimeConfig, TelegramServer, UploadServer, WsServer } from "../server/index.js";
import pluginFactories from "../config/plugins.js";
import providerFactory from "../config/provider.js";
import { initializeLlmRuntimeConfig } from "../config/llm-runtime-config.js";
import {
  AdapterRegistry,
  InboundQueueStore,
  PluginRegistry,
  SystemEventWorker,
  SystemIngressService,
  loadPlugins,
  loadProvider,
  normalizeSystemEvent,
  type PluginRuntimeContext,
} from "../core/index.js";
import { loadStaticContext, type StaticContext } from "../context/static-context-cache.js";
import { devLog } from "../shared/index.js";
import { PulseScheduler, PulseStore } from "../pulse/index.js";
import { pulseTool } from "../skills/builtins/pulse/index.js";
import { loadSystemEventPolicy } from "../ivec/system-event-policy.js";
import { createMemoryRuntime } from "./memory-runtime.js";
import { createContentRuntime } from "./content-runtime.js";
import { appendSkillBlocks, createSkillRuntime } from "./skill-runtime.js";
import { loadAyatiRuntimeConfig } from "../config/runtime-config.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");

const CLIENT_ID = "local";
const TELEGRAM_CLIENT_ID = "telegram-shared";

export async function main(): Promise<void> {
  await initializeLlmRuntimeConfig({ projectRoot });
  const runtimeConfig = loadAyatiRuntimeConfig(process.env);
  const provider = await loadProvider(providerFactory);
  const systemEventPolicy = loadSystemEventPolicy(projectRoot);
  let engine: IVecEngine | null = null;
  let staticContext: StaticContext | null = null;

  const memory = await createMemoryRuntime({
    projectRoot,
    clientId: CLIENT_ID,
    provider,
  });

  const adapterRegistry = new AdapterRegistry();
  const inboundQueueStore = new InboundQueueStore({
    dataDir: resolve(projectRoot, "data", "memory"),
  });
  inboundQueueStore.start();
  const systemIngress = new SystemIngressService({
    adapterRegistry,
    queueStore: inboundQueueStore,
  });

  const pulseStore = new PulseStore();
  const registry = new PluginRegistry();

  const wsServer = new WsServer({
    onMessage: (_transportClientId, data) => engine?.handleMessage(CLIENT_ID, data),
  });

  const pulseScheduler = new PulseScheduler({
    clientId: CLIENT_ID,
    store: pulseStore,
    onReminderDue: async (event) => {
      await systemIngress.ingestInternalEvent(CLIENT_ID, event);
    },
  });

  const content = createContentRuntime({
    projectRoot,
    provider,
    sessionMemory: memory.sessionMemory,
    config: runtimeConfig,
  });

  const skills = await createSkillRuntime({
    projectRoot,
    clientId: CLIENT_ID,
    personalMemoryStore: memory.personalMemoryStore,
    memoryRetriever: memory.memoryRetriever,
    episodicMemoryController: memory.episodicMemoryController,
    sessionAttachmentService: content.sessionAttachmentService,
    preparedAttachmentService: content.preparedAttachmentService,
    fileLibrary: content.fileLibrary,
    directoryLibrary: content.directoryLibrary,
    courseStore: content.courseStore,
    learningWorkspace: content.learningWorkspace,
    config: runtimeConfig,
    onSoulUpdated: (updatedSoul) => {
      if (!staticContext) {
        return;
      }
      staticContext.soul = updatedSoul;
      engine?.invalidateStaticTokenCache();
    },
  });

  staticContext = await loadStaticContext({ toolDefinitions: skills.runtimeToolDefs });
  appendSkillBlocks(staticContext, skills.additionalSkills);

  const uploadServer = new UploadServer({
    uploadsDir: content.documentStore.uploadsDir,
    runsDir: resolve(projectRoot, "data", "runs"),
    host: content.httpHost,
    port: content.httpPort,
    maxUploadBytes: runtimeConfig.http.maxUploadBytes,
    allowOrigin: runtimeConfig.http.allowOrigin,
    pulseTool,
    pulseClientId: CLIENT_ID,
    pulseApiToken: runtimeConfig.http.apiToken,
    fileLibrary: content.fileLibrary,
    courseStore: content.courseStore,
    learningWorkspace: content.learningWorkspace,
    learningClientId: CLIENT_ID,
  });
  const telegramConfig = loadTelegramRuntimeConfig(process.env);
  const telegramServer = telegramConfig
    ? new TelegramServer({
      ...telegramConfig,
      clientId: telegramConfig.clientId || TELEGRAM_CLIENT_ID,
      uploadsDir: content.documentStore.uploadsDir,
      stateDir: resolve(projectRoot, "data", "telegram"),
      onMessage: (clientId, data) => engine?.handleMessage(clientId, data),
      fileLibrary: content.fileLibrary,
    })
    : null;

  engine = new IVecEngine({
    onReply: (clientId, data) => {
      if (telegramServer && clientId === telegramServer.clientId) {
        telegramServer.send(clientId, data);
        return;
      }
      wsServer.send(clientId, data);
    },
    provider,
    staticContext,
    toolExecutor: skills.toolExecutor,
    externalSkillBroker: skills.externalSkillBroker,
    externalSkillRegistry: skills.externalSkillRegistry,
    sessionMemory: memory.sessionMemory,
    dataDir: resolve(projectRoot, "data"),
    documentStore: content.documentStore,
    preparedAttachmentRegistry: content.preparedAttachmentRegistry,
    documentContextBackend: content.documentContextBackend,
    fileLibrary: content.fileLibrary,
    directoryLibrary: content.directoryLibrary,
    systemEventPolicy,
  });
  const systemEventWorker = new SystemEventWorker({
    queueStore: inboundQueueStore,
    processEvent: async (clientId, event) => {
      if (!engine) {
        throw new Error("Engine is not initialized");
      }
      await engine.handleSystemEvent(clientId, event);
    },
  });
  const publishSystemEvent: PluginRuntimeContext["publishSystemEvent"] = async (event) => {
    devLog(
      `System event ingress received: source=${event.source} eventName=${event.eventName} eventId=${event.eventId ?? "generated"} summary=${event.summary}`,
    );
    const normalized = normalizeSystemEvent(event);
    devLog(
      `System event normalized: source=${normalized.source} eventName=${normalized.eventName} eventId=${normalized.eventId} receivedAt=${normalized.receivedAt}`,
    );
    const result = await systemIngress.ingestInternalEvent(CLIENT_ID, normalized);
    devLog(
      `System event handed to ingress queue: eventId=${normalized.eventId} source=${normalized.source}/${normalized.eventName} queued=${result.queued !== false}`,
    );
    return result;
  };
  const pluginRuntimeContext: PluginRuntimeContext = {
    clientId: CLIENT_ID,
    dataDir: resolve(projectRoot, "data"),
    projectRoot,
    publishSystemEvent,
    emitSystemEvent: publishSystemEvent,
    registerSystemAdapter: (adapter) => adapterRegistry.register(adapter),
    ingestExternalRequest: async (request) => await systemIngress.ingestExternalRequest(request),
  };

  const plugins = await loadPlugins(pluginFactories);
  for (const plugin of plugins) {
    registry.register(plugin);
  }

  await engine.start();
  systemEventWorker.start();
  await wsServer.start();
  await uploadServer.start();
  if (telegramServer) {
    await telegramServer.start();
  }
  await pulseScheduler.start();
  await registry.startAll(pluginRuntimeContext);

  console.log(`Ayati i-vec ready — plugins: [${registry.list().join(", ")}]`);

  const shutdown = async (): Promise<void> => {
    await registry.stopAll(pluginRuntimeContext);
    await pulseScheduler.stop();
    pulseStore.close();
    if (telegramServer) {
      await telegramServer.stop();
    }
    await uploadServer.stop();
    await wsServer.stop();
    await systemEventWorker.stop();
    inboundQueueStore.stop();
    await memory.stop();
    await engine.stop();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
