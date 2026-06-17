import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IVecEngine } from "../ivec/index.js";
import { UploadServer, WsServer } from "../server/index.js";
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
import embeddingProvider from "../embeddings/runtime/index.js";
import imageGenerationProvider from "../image-generation/runtime/index.js";
import type { AgentUiContext } from "../ui/context.js";
import type { WorkspaceInteractionEvent } from "../ui/workspace-orchestrator.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");

const CLIENT_ID = "local";

export async function main(): Promise<void> {
  await initializeLlmRuntimeConfig({ projectRoot });
  const runtimeConfig = loadAyatiRuntimeConfig(process.env);
  const provider = await loadProvider(providerFactory);
  const systemEventPolicy = loadSystemEventPolicy(projectRoot);
  let engine: IVecEngine | null = null;
  let staticContext: StaticContext | null = null;
  const workspaceSessionsByTransport = new Map<string, string>();

  const memory = await createMemoryRuntime({
    projectRoot,
    clientId: CLIENT_ID,
    provider,
    embeddingProvider,
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

  let content: Awaited<ReturnType<typeof createContentRuntime>> | null = null;
  const wsServer = new WsServer({
    onMessage: (transportClientId, data) => {
      const workspaceEvent = parseWorkspaceEventMessage(data);
      if (workspaceEvent) {
        if (workspaceEvent.event === "workspace_session_started") {
          workspaceSessionsByTransport.set(transportClientId, workspaceEvent.workspaceSessionId);
          void content?.workspaceOrchestrator.startSession({
            clientId: CLIENT_ID,
            workspaceSessionId: workspaceEvent.workspaceSessionId,
            transportClientId,
            uiContext: workspaceEvent.uiContext,
          }).catch((err: unknown) => {
            devLog(`Workspace session start failed: ${err instanceof Error ? err.message : String(err)}`);
          });
          return;
        }

        if (workspaceEvent.event === "workspace_session_ended") {
          workspaceSessionsByTransport.delete(transportClientId);
          void content?.workspaceOrchestrator.endSession({
            clientId: CLIENT_ID,
            workspaceSessionId: workspaceEvent.workspaceSessionId,
            transportClientId,
            reason: "client_ended",
            uiContext: workspaceEvent.uiContext,
          }).catch((err: unknown) => {
            devLog(`Workspace session end failed: ${err instanceof Error ? err.message : String(err)}`);
          });
          return;
        }

        void content?.workspaceOrchestrator.handleInteractionEvent({
          clientId: CLIENT_ID,
          event: workspaceEvent.event,
          workspaceSessionId: workspaceEvent.workspaceSessionId,
          transportClientId,
          uiContext: workspaceEvent.uiContext,
        }).catch((err: unknown) => {
          devLog(`Workspace event ${workspaceEvent.event} failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }
      engine?.handleMessage(CLIENT_ID, data);
    },
    onDisconnect: (transportClientId) => {
      const workspaceSessionId = workspaceSessionsByTransport.get(transportClientId);
      workspaceSessionsByTransport.delete(transportClientId);
      if (!workspaceSessionId) {
        return;
      }
      void content?.workspaceOrchestrator.endSession({
        clientId: CLIENT_ID,
        workspaceSessionId,
        transportClientId,
        reason: "transport_closed",
      }).catch((err: unknown) => {
        devLog(`Workspace session disconnect cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
  });

  const pulseScheduler = new PulseScheduler({
    clientId: CLIENT_ID,
    store: pulseStore,
    onReminderDue: async (event) => {
      await systemIngress.ingestInternalEvent(CLIENT_ID, event);
    },
  });

  content = await createContentRuntime({
    projectRoot,
    clientId: CLIENT_ID,
    provider,
    sessionMemory: memory.sessionMemory,
    config: runtimeConfig,
    embeddingProvider,
  });
  content.workspaceFocusWatcher.start();

  const skills = await createSkillRuntime({
    projectRoot,
    clientId: CLIENT_ID,
    personalMemoryStore: memory.personalMemoryStore,
    activityStore: memory.activityStore,
    memoryRetriever: memory.memoryRetriever,
    episodicMemoryController: memory.episodicMemoryController,
    sessionAttachmentService: content.sessionAttachmentService,
    preparedAttachmentService: content.preparedAttachmentService,
    fileLibrary: content.fileLibrary,
    directoryLibrary: content.directoryLibrary,
    courseStore: content.courseStore,
    learningFileStore: content.learningFileStore,
    learningWorkspace: content.learningWorkspace,
    workspaceOrchestrator: content.workspaceOrchestrator,
    config: runtimeConfig,
  });

  staticContext = await loadStaticContext({
    skillsProvider: skills.staticSkillsProvider,
    toolDefinitions: skills.runtimeToolDefs,
  });
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
    learningFileStore: content.learningFileStore,
    learningWorkspace: content.learningWorkspace,
    learningClientId: CLIENT_ID,
  });
  engine = new IVecEngine({
    onReply: (clientId, data) => {
      wsServer.send(clientId, data);
    },
    provider,
    staticContext,
    toolExecutor: skills.toolExecutor,
    skillActivationManager: skills.skillActivationManager,
    sessionMemory: memory.sessionMemory,
    dataDir: resolve(projectRoot, "data"),
    documentStore: content.documentStore,
    preparedAttachmentRegistry: content.preparedAttachmentRegistry,
    documentContextBackend: content.documentContextBackend,
    fileLibrary: content.fileLibrary,
    directoryLibrary: content.directoryLibrary,
    courseStore: content.courseStore,
    learningFileStore: content.learningFileStore,
    systemEventPolicy,
    loopConfig: runtimeConfig.agent.loopConfig,
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
  await pulseScheduler.start();
  await registry.startAll(pluginRuntimeContext);

  console.log(`Ayati i-vec ready — plugins: [${registry.list().join(", ")}]`);

  const shutdown = async (): Promise<void> => {
    content?.workspaceFocusWatcher.stop();
    await registry.stopAll(pluginRuntimeContext);
    await pulseScheduler.stop();
    pulseStore.close();
    await uploadServer.stop();
    await wsServer.stop();
    await systemEventWorker.stop();
    inboundQueueStore.stop();
    await memory.stop();
    await embeddingProvider.stop();
    await imageGenerationProvider.stop();
    await engine.stop();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function parseWorkspaceEventMessage(data: unknown): {
  event: WorkspaceInteractionEvent | "workspace_session_started" | "workspace_session_ended";
  workspaceSessionId: string;
  uiContext?: AgentUiContext;
} | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (record["type"] !== "workspace_event") {
    return null;
  }
  const event = record["event"];
  if (
    event !== "workspace_session_started"
    && event !== "workspace_session_ended"
    && event !== "cli_input_started"
    && event !== "cli_message_submitted"
  ) {
    return null;
  }
  const workspaceSessionId = readWorkspaceSessionId(record["workspaceSessionId"]);
  if (!workspaceSessionId && (event === "workspace_session_started" || event === "workspace_session_ended")) {
    return null;
  }
  const uiContext = normalizeAgentUiContext(record["uiContext"]);
  return {
    event,
    workspaceSessionId: workspaceSessionId ?? "",
    ...(uiContext ? { uiContext } : {}),
  };
}

function readWorkspaceSessionId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeAgentUiContext(value: unknown): AgentUiContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record["source"] !== "agent-cli") {
    return undefined;
  }
  const processTreePids = Array.isArray(record["processTreePids"])
    ? record["processTreePids"].filter((pid): pid is number => typeof pid === "number")
    : undefined;
  return {
    source: "agent-cli",
    ...(typeof record["terminalPid"] === "number" ? { terminalPid: record["terminalPid"] } : {}),
    ...(typeof record["processPid"] === "number" ? { processPid: record["processPid"] } : {}),
    ...(processTreePids && processTreePids.length > 0 ? { processTreePids } : {}),
    ...(typeof record["windowAddress"] === "string" ? { windowAddress: record["windowAddress"] } : {}),
    ...(typeof record["windowClass"] === "string" ? { windowClass: record["windowClass"] } : {}),
    ...(typeof record["windowTitle"] === "string" ? { windowTitle: record["windowTitle"] } : {}),
    ...(typeof record["workspaceId"] === "number" ? { workspaceId: record["workspaceId"] } : {}),
    ...(typeof record["workspaceName"] === "string" ? { workspaceName: record["workspaceName"] } : {}),
    ...(typeof record["monitor"] === "string" ? { monitor: record["monitor"] } : {}),
    ...(typeof record["detectedAt"] === "string" ? { detectedAt: record["detectedAt"] } : {}),
  };
}
