import { resolve } from "node:path";
import type { StaticContext } from "../context/static-context-cache.js";
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
import type { GitContextService } from "ayati-git-context";
import { builtInSkillsProvider } from "../skills/provider.js";
import { createToolExecutor, type ToolExecutor } from "../skills/tool-executor.js";
import type { SkillDefinition, SkillsProvider, SkillPromptBlock, ToolDefinition } from "../skills/types.js";
import { createRecallSkill } from "../skills/builtins/recall/index.js";
import { createMemorySkill } from "../skills/builtins/memory/index.js";
import { createPythonSkill } from "../skills/builtins/python/index.js";
import { createAttachmentSkill } from "../skills/builtins/attachments/index.js";
import { createDatasetSkill } from "../skills/builtins/datasets/index.js";
import { createDocumentSkill } from "../skills/builtins/documents/index.js";
import { createFilesSkill } from "../skills/builtins/files/index.js";
import { createGitContextSkill } from "../skills/builtins/git-context/index.js";
import { createUiSkill } from "../skills/builtins/ui/index.js";
import { SkillActivationManager } from "../skills/activation-manager.js";
import { createSkillBundle, SkillCatalog } from "../skills/skill-catalog.js";
import { ToolCatalog } from "../ivec/agent-runner/tool-catalog.js";
import { ToolWorkingSetManager } from "../ivec/agent-runner/tool-working-set.js";
import { createTaskScopedToolExecutor } from "./task-scoped-tool-executor.js";

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
  gitContextService: GitContextService;
}

export interface SkillRuntime {
  toolExecutor: ToolExecutor;
  skillActivationManager: SkillActivationManager;
  toolWorkingSetManager: ToolWorkingSetManager;
  toolCatalog: ToolCatalog;
  dynamicSkillCatalog: SkillCatalog;
  staticSkillsProvider: SkillsProvider;
  baseToolDefs: ToolDefinition[];
  runtimeToolDefs: ToolDefinition[];
  additionalSkills: SkillDefinition[];
}

export async function createSkillRuntime(options: SkillRuntimeOptions): Promise<SkillRuntime> {
  const builtInSkills = await builtInSkillsProvider.getAllSkills();
  const kernelSkillIds = new Set(["shell", "filesystem"]);
  const dynamicBuiltInSkills = builtInSkills.filter((skill) => !kernelSkillIds.has(skill.id));

  const runtimeSkills: SkillDefinition[] = [
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
      service: options.gitContextService,
      workspaceRoot: options.config.workspace.root,
    }),
    createUiSkill({
      workspaceOrchestrator: options.workspaceOrchestrator,
    }),
  ];

  const dynamicSkillCatalog = new SkillCatalog([
    ...dynamicBuiltInSkills,
    ...runtimeSkills,
  ].map((skill) => createSkillBundle(skill)));

  const allRuntimeSkills = [
    ...builtInSkills,
    ...runtimeSkills,
  ];
  const baseToolDefs: ToolDefinition[] = [];
  const baseToolExecutor = createToolExecutor(baseToolDefs);
  const toolExecutor = createTaskScopedToolExecutor({
    base: baseToolExecutor,
    gitContext: options.gitContextService,
  });
  const toolCatalog = new ToolCatalog(allRuntimeSkills);
  const toolWorkingSetManager = new ToolWorkingSetManager({
    catalog: toolCatalog,
    toolExecutor,
    maxVisibleTools: options.config.agent.loopConfig.maxSelectedTools,
  });

  const skillActivationManager = new SkillActivationManager({
    catalog: dynamicSkillCatalog,
    toolExecutor,
  });

  const staticSkillsProvider = createStaticSkillsProvider([]);
  const additionalSkills: SkillDefinition[] = [];

  return {
    toolExecutor,
    skillActivationManager,
    toolWorkingSetManager,
    toolCatalog,
    dynamicSkillCatalog,
    staticSkillsProvider,
    baseToolDefs,
    runtimeToolDefs: [],
    additionalSkills,
  };
}

export function appendSkillBlocks(staticContext: StaticContext, skills: SkillDefinition[]): void {
  for (const skill of skills) {
    staticContext.skillBlocks.push({ id: skill.id, content: skill.promptBlock });
  }
}

function createStaticSkillsProvider(skills: SkillDefinition[]): SkillsProvider {
  return {
    async getAllSkills(): Promise<SkillDefinition[]> {
      return skills;
    },

    async getAllSkillBlocks(): Promise<SkillPromptBlock[]> {
      return skills.map((skill) => ({ id: skill.id, content: skill.promptBlock }));
    },

    async getAllTools(): Promise<ToolDefinition[]> {
      return skills.flatMap((skill) => skill.tools);
    },
  };
}
