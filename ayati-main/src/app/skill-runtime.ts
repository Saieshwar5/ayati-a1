import { resolve } from "node:path";
import type {
  EpisodicMemoryController,
  EpisodicMemoryRetriever,
} from "../memory/episodic/index.js";
import type { PersonalMemoryStore } from "../memory/personal/personal-memory-store.js";
import type { PreparedAttachmentService } from "../documents/prepared-attachment-service.js";
import type { SessionAttachmentService } from "../documents/session-attachment-service.js";
import type { DirectoryLibrary } from "../files/directory-library.js";
import type { FileLibrary } from "../files/file-library.js";
import type { WorkspaceOrchestrator } from "../ui/workspace-orchestrator.js";
import type { AyatiRuntimeConfig } from "../config/runtime-config.js";
import type { ContextEngineService } from "ayati-context-engine";
import { builtInSkillsProvider } from "../skills/provider.js";
import { createToolExecutor, type ToolExecutor } from "../skills/tool-executor.js";
import type { SkillDefinition } from "../skills/types.js";
import { createRecallSkill } from "../skills/builtins/recall/index.js";
import { createMemorySkill } from "../skills/builtins/memory/index.js";
import { createPythonSkill } from "../skills/builtins/python/index.js";
import { createAttachmentSkill } from "../skills/builtins/attachments/index.js";
import { createDatasetSkill } from "../skills/builtins/datasets/index.js";
import { createDocumentSkill } from "../skills/builtins/documents/index.js";
import { createFilesSkill } from "../skills/builtins/files/index.js";
import { createGitContextSkill } from "../skills/builtins/git-context/index.js";
import { createUiSkill } from "../skills/builtins/ui/index.js";
import { createContextSkill } from "../skills/builtins/context/index.js";
import { createSystemSkill } from "../skills/builtins/system/index.js";
import { CapabilityCatalog } from "../ivec/agent-runner/capabilities/catalog.js";
import { ToolRegistry } from "../ivec/agent-runner/capabilities/registry.js";
import { CapabilitySurfaceManager } from "../ivec/agent-runner/capabilities/surface-manager.js";
import { createResourceScopedToolExecutor } from "./resource-scoped-tool-executor.js";
import {
  createPersonalMemoryHotContextSource,
  HotContextRuntime,
  RUN_SCOPED_HOT_CONTEXT_KEYS,
} from "../ivec/hot-context/index.js";

export interface SkillRuntimeOptions {
  projectRoot: string;
  clientId: string;
  personalMemoryStore: PersonalMemoryStore;
  memoryRetriever: EpisodicMemoryRetriever;
  episodicMemoryController: EpisodicMemoryController;
  sessionAttachmentService: SessionAttachmentService;
  preparedAttachmentService: PreparedAttachmentService;
  fileLibrary: FileLibrary;
  directoryLibrary: DirectoryLibrary;
  workspaceOrchestrator: WorkspaceOrchestrator;
  config: AyatiRuntimeConfig;
  contextEngineService: ContextEngineService;
  personalMemorySnapshot(clientId: string): string;
}

export interface SkillRuntime {
  toolExecutor: ToolExecutor;
  toolRegistry: ToolRegistry;
  capabilitySurfaceManager: CapabilitySurfaceManager;
  hotContextRuntime: HotContextRuntime;
}

export async function createSkillRuntime(options: SkillRuntimeOptions): Promise<SkillRuntime> {
  const builtInSkills = await builtInSkillsProvider.getAllSkills();
  const hotContextRuntime = new HotContextRuntime({
    sources: [
      createPersonalMemoryHotContextSource({
        getSnapshot: options.personalMemorySnapshot,
      }),
    ],
    runScopedKeys: [...RUN_SCOPED_HOT_CONTEXT_KEYS],
  });

  const runtimeSkills: SkillDefinition[] = [
    createContextSkill({ hotContextRuntime }),
    createSystemSkill({
      defaultTimezone: options.config.contextEngine.timezone,
      healthRoot: options.config.contextEngine.rootDirectory,
    }),
    createRecallSkill({
      retriever: options.memoryRetriever,
      controls: options.episodicMemoryController,
    }),
    createMemorySkill({
      store: options.personalMemoryStore,
      defaultUserId: options.clientId,
    }),
    createPythonSkill({
      dataDir: resolve(options.projectRoot, "data"),
      interpreterPath: options.config.python.interpreterPath,
    }),
    createAttachmentSkill({ sessionAttachmentService: options.sessionAttachmentService }),
    createDatasetSkill({ preparedAttachmentService: options.preparedAttachmentService }),
    createDocumentSkill({ preparedAttachmentService: options.preparedAttachmentService }),
    createFilesSkill({
      fileLibrary: options.fileLibrary,
      directoryLibrary: options.directoryLibrary,
    }),
    createGitContextSkill({
      service: options.contextEngineService,
    }),
    createUiSkill({
      workspaceOrchestrator: options.workspaceOrchestrator,
    }),
  ];

  const allRuntimeSkills = [
    ...builtInSkills,
    ...runtimeSkills,
  ];
  const baseToolExecutor = createToolExecutor([]);
  const toolExecutor = createResourceScopedToolExecutor({
    base: baseToolExecutor,
    contextEngine: options.contextEngineService,
    workspaceRoot: options.config.workspace.root,
    filesystemAccess: options.config.filesystemAccess,
  });
  const toolRegistry = ToolRegistry.fromSkills(allRuntimeSkills);
  const capabilitySurfaceManager = new CapabilitySurfaceManager({
    catalog: new CapabilityCatalog(),
    registry: toolRegistry,
    toolExecutor,
    maxVisibleTools: options.config.agent.loopConfig.maxCapabilitySurfaceTools,
  });

  return {
    toolExecutor,
    toolRegistry,
    capabilitySurfaceManager,
    hotContextRuntime,
  };
}
