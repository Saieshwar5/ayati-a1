import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IVecEngine } from "../ivec/index.js";
import { UploadServer, WsServer } from "../server/index.js";
import providerFactory from "../config/provider.js";
import {
  getActiveProvider,
  getLlmRuntimeConfig,
  getModelForProvider,
  initializeLlmRuntimeConfig,
} from "../config/llm-runtime-config.js";
import { loadProvider } from "../core/index.js";
import { loadStaticContext, type StaticContext } from "../context/static-context-cache.js";
import { devLog, devWarn } from "../shared/index.js";
import { createMemoryRuntime } from "./memory-runtime.js";
import { createContentRuntime } from "./content-runtime.js";
import { createSkillRuntime } from "./skill-runtime.js";
import { loadAyatiRuntimeConfig } from "../config/runtime-config.js";
import {
  NOOP_AGENT_EVENT_SINK,
  type AgentEventSink,
} from "../ivec/agent-event-sink.js";
import { startContextEngineHost } from "ayati-context-engine";
import { createContextEngineRuntime } from "./context-engine-runtime.js";
import { createChatTurnRuntime } from "./chat-turn-runtime.js";
import { ensureWorkspaceRoot } from "../skills/workspace-paths.js";
import {
  createHarnessContextEngineObserver,
  recordContextEngineObservabilityEvent,
} from "./context-engine-observability.js";
import {
  createEvaluationProvider,
  createEvaluationToolExecutor,
  startLiveEvaluationCapture,
  stopLiveEvaluationCapture,
} from "../evaluation/index.js";
import {
  NotifySendVoiceNotifier,
  VoiceChannelRuntime,
  VoxtypeAdapter,
  loadVoiceRuntimeConfig,
  resolveVoiceRuntimePaths,
} from "../voice/index.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");

const CLIENT_ID = "local";
const VOICE_REPLY_CLIENT_ID = "voice";

export async function main(): Promise<void> {
  await initializeLlmRuntimeConfig({ projectRoot });
  const runtimeConfig = loadAyatiRuntimeConfig(process.env);
  const voiceConfig = loadVoiceRuntimeConfig(process.env);
  const voicePaths = resolveVoiceRuntimePaths(process.env);
  await ensureWorkspaceRoot(runtimeConfig.workspace.root);
  const loadedProvider = await loadProvider(providerFactory);
  let evaluationRecorder: Awaited<ReturnType<typeof startLiveEvaluationCapture>>;
  try {
    evaluationRecorder = await startLiveEvaluationCapture({
      projectRoot,
      configuredRuntimeRoot: runtimeConfig.contextEngine.rootDirectory,
      provider: loadedProvider,
      model: getModelForProvider(getActiveProvider()),
      runtimeConfig,
      llmConfig: getLlmRuntimeConfig(),
    });
  } catch (error) {
    devLog(`Live evaluation capture unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const eventSink: AgentEventSink = evaluationRecorder ?? NOOP_AGENT_EVENT_SINK;
  const provider = createEvaluationProvider(loadedProvider);
  let engine: IVecEngine | null = null;
  let staticContext: StaticContext | null = null;
  let voiceChannel: VoiceChannelRuntime | null = null;
  const runByReplyTurn = new Map<string, string>();

  const memory = await createMemoryRuntime({
    projectRoot,
    clientId: CLIENT_ID,
    provider,
  });

  let content: Awaited<ReturnType<typeof createContentRuntime>> | null = null;
  const wsServer = new WsServer({
    onReplyRendered: (transportClientId, acknowledgement) => {
      const runId = runByReplyTurn.get(acknowledgement.turnId);
      runByReplyTurn.delete(acknowledgement.turnId);
      eventSink.record({
        clientId: CLIENT_ID,
        ...(runId ? { runId } : {}),
        stage: "client",
        event: "reply_rendered",
        data: {
          transportClientId,
          ...acknowledgement,
        },
      });
      if (runId) {
        eventSink.scheduleCheckpoint?.(runId);
      }
    },
    onMessage: (transportClientId, data) => {
      eventSink.record({
        clientId: CLIENT_ID,
        stage: "transport",
        event: "inbound",
        data: { transportClientId, envelope: data },
      });
      const receipt = engine?.handleMessage(CLIENT_ID, data, {
        replyClientId: transportClientId,
        channel: wsServer.clientKind(transportClientId),
      });
      if (receipt) {
        const started = process.hrtime.bigint();
        wsServer.send(transportClientId, receipt);
        recordOutboundTransport(
          eventSink,
          transportClientId,
          receipt,
          runByReplyTurn,
          elapsedMs(started),
        );
      }
    },
  });

  content = await createContentRuntime({
    projectRoot,
    config: runtimeConfig,
  });

  const contextEngineHost = await startContextEngineHost({
    databasePath: runtimeConfig.contextEngine.databasePath,
    rootDirectory: runtimeConfig.contextEngine.rootDirectory,
    observabilitySink: (event) => recordContextEngineObservabilityEvent(eventSink, event),
  });
  const contextEngineService = contextEngineHost.service;
  const contextEngineRuntime = createContextEngineRuntime({
    service: contextEngineService,
    timezone: runtimeConfig.contextEngine.timezone,
    agentId: runtimeConfig.contextEngine.agentId,
    observer: createHarnessContextEngineObserver(eventSink),
    onContextCheckpointCommitted: ({ streamId, plan, checkpoint }) => {
      memory.enqueuePersonalMemoryCheckpoint({
        userId: CLIENT_ID,
        streamId,
        plan,
        checkpoint,
      });
    },
  });
  const skills = await createSkillRuntime({
    projectRoot,
    clientId: CLIENT_ID,
    personalMemoryStore: memory.personalMemoryStore,
    sessionAttachmentService: content.sessionAttachmentService,
    fileLibrary: content.fileLibrary,
    directoryLibrary: content.directoryLibrary,
    config: runtimeConfig,
    contextEngineService: contextEngineService,
    personalMemorySnapshot: (clientId) => memory.personalMemorySnapshotCache.getSnapshot(clientId),
  });
  const toolExecutor = createEvaluationToolExecutor(skills.toolExecutor);

  staticContext = await loadStaticContext();
  const chatContextRuntime = contextEngineRuntime;
  const chatTurnRuntime = createChatTurnRuntime({
    onReply: (clientId, data) => {
      const started = process.hrtime.bigint();
      if (clientId === VOICE_REPLY_CLIENT_ID) {
        voiceChannel?.handleAgentMessage(data);
      } else {
        wsServer.send(clientId, data);
      }
      recordOutboundTransport(eventSink, clientId, data, runByReplyTurn, elapsedMs(started));
    },
    clientSupportsReplyStreaming: (clientId) => wsServer.clientSupportsReplyStreaming(clientId),
    provider,
    workspaceRoot: runtimeConfig.workspace.root,
    staticContext,
    toolExecutor,
    capabilitySurfaceManager: skills.capabilitySurfaceManager,
    hotContextRuntime: skills.hotContextRuntime,
    dataDir: resolve(projectRoot, "data"),
    fileLibrary: content.fileLibrary,
    directoryLibrary: content.directoryLibrary,
    loopConfig: runtimeConfig.agent.loopConfig,
    eventSink,
    chatContextRuntime,
    contextEngineService,
  });
  const uploadServer = new UploadServer({
    uploadsDir: content.uploadsDir,
    host: content.httpHost,
    port: content.httpPort,
    maxUploadBytes: runtimeConfig.http.maxUploadBytes,
    allowOrigin: runtimeConfig.http.allowOrigin,
    fileLibrary: content.fileLibrary,
  });
  engine = new IVecEngine({
    provider,
    staticContext,
    chatTurnRuntime,
  });
  if (voiceConfig.enabled) {
    voiceChannel = new VoiceChannelRuntime({
      config: voiceConfig,
      paths: voicePaths,
      transcriber: new VoxtypeAdapter({
        command: voiceConfig.command,
        statePath: voicePaths.voxtypeStatePath,
        transcriptionTimeoutMs: voiceConfig.transcriptionTimeoutMs,
        maxTranscriptChars: voiceConfig.maxTranscriptChars,
      }),
      notifier: new NotifySendVoiceNotifier(),
      submitChat: ({ messageId, content: voiceContent, onSettled }) => {
        eventSink.record({
          clientId: CLIENT_ID,
          stage: "transport",
          event: "inbound",
          data: {
            transportClientId: VOICE_REPLY_CLIENT_ID,
            channel: "voice",
            envelope: { type: "chat", messageId, content: voiceContent },
          },
        });
        return engine?.handleMessage(CLIENT_ID, {
          type: "chat",
          messageId,
          content: voiceContent,
        }, {
          replyClientId: VOICE_REPLY_CLIENT_ID,
          channel: "voice",
          onSettled,
        }) ?? null;
      },
    });
  }
  await engine.start();
  await wsServer.start();
  if (voiceChannel) {
    try {
      await voiceChannel.start();
    } catch (error) {
      devWarn("Voice channel failed to start:", error instanceof Error ? error.message : String(error));
      await voiceChannel.stop().catch(() => undefined);
      voiceChannel = null;
    }
  }
  await uploadServer.start();

  console.log(
    "Ayati i-vec ready"
      + (voiceChannel ? ` — voice: ${voiceChannel.snapshot().state}` : " — voice: disabled"),
  );

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (status: "completed" | "interrupted" | "failed" = "completed"): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await voiceChannel?.stop();
      await uploadServer.stop();
      await wsServer.stop();
      await memory.stop();
      await engine.stop();
      await contextEngineHost.stop();
      await stopLiveEvaluationCapture(evaluationRecorder, status);
    })();
    return shutdownPromise;
  };

  const handleSignal = (): void => {
    const keepAlive = setInterval(() => undefined, 1_000);
    void shutdown("interrupted").then(() => {
      clearInterval(keepAlive);
      process.exitCode = 0;
    }, (error: unknown) => {
      clearInterval(keepAlive);
      devLog(`Shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  process.on("SIGHUP", handleSignal);
}

function recordOutboundTransport(
  sink: AgentEventSink,
  clientId: string,
  data: unknown,
  runByReplyTurn: Map<string, string>,
  durationMs: number,
): void {
  const record = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;
  const turnId = typeof record?.["turnId"] === "string" ? record["turnId"] : undefined;
  const directRunId = typeof record?.["runId"] === "string" ? record["runId"] : undefined;
  const runId = directRunId ?? (turnId ? runByReplyTurn.get(turnId) : undefined);
  if (runId && turnId) runByReplyTurn.set(turnId, runId);
  sink.record({
    clientId,
    ...(runId ? { runId } : {}),
    stage: "transport",
    event: "outbound",
    data: {
      envelope: data,
      ...(typeof record?.["type"] === "string" ? { type: record["type"] } : {}),
      ...(turnId ? { turnId } : {}),
      terminal: ["reply", "feedback", "notification", "error", "reply_done"].includes(String(record?.["type"] ?? "")),
      durationMs,
    },
  });
}

function elapsedMs(startedNs: bigint): number {
  return Number(process.hrtime.bigint() - startedNs) / 1_000_000;
}
