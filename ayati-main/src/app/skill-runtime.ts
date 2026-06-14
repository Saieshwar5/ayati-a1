import { resolve } from "node:path";
import type { StaticContext } from "../context/static-context-cache.js";
import type {
  EpisodicMemoryController,
  EpisodicMemoryRetriever,
} from "../memory/episodic/index.js";
import type { PersonalMemoryStore } from "../memory/personal/personal-memory-store.js";
import type { FocusStore } from "../memory/focus/index.js";
import type { PreparedAttachmentService } from "../documents/prepared-attachment-service.js";
import type { SessionAttachmentService } from "../documents/session-attachment-service.js";
import type { DirectoryLibrary } from "../files/directory-library.js";
import type { FileLibrary } from "../files/file-library.js";
import type { CourseStore } from "../learning/course-store.js";
import type { LearningFileStore } from "../learning/file-store.js";
import type { LearningWorkspaceController } from "../ui/learning-workspace.js";
import type { WorkspaceOrchestrator } from "../ui/workspace-orchestrator.js";
import type { AyatiRuntimeConfig } from "../config/runtime-config.js";
import { builtInSkillsProvider } from "../skills/provider.js";
import { createToolExecutor, type ToolExecutor } from "../skills/tool-executor.js";
import type { SkillDefinition, SkillsProvider, SkillPromptBlock, ToolDefinition } from "../skills/types.js";
import { createRecallSkill } from "../skills/builtins/recall/index.js";
import { createMemorySkill } from "../skills/builtins/memory/index.js";
import { createFocusSkill } from "../skills/builtins/focus/index.js";
import { createPythonSkill } from "../skills/builtins/python/index.js";
import { createAttachmentSkill } from "../skills/builtins/attachments/index.js";
import { createDatasetSkill } from "../skills/builtins/datasets/index.js";
import { createDocumentSkill } from "../skills/builtins/documents/index.js";
import { createFilesSkill } from "../skills/builtins/files/index.js";
import { createLearningFileSkill } from "../skills/builtins/learning-v2/index.js";
import { createUiSkill } from "../skills/builtins/ui/index.js";
import { createSkillBrokerSkill } from "../skills/builtins/skill-broker/index.js";
import { SkillActivationManager } from "../skills/activation-manager.js";
import { createSkillBundle, SkillCatalog } from "../skills/skill-catalog.js";

export interface SkillRuntimeOptions {
  projectRoot: string;
  clientId: string;
  personalMemoryStore: PersonalMemoryStore;
  focusStore: FocusStore;
  memoryRetriever: EpisodicMemoryRetriever;
  episodicMemoryController: EpisodicMemoryController;
  sessionAttachmentService: SessionAttachmentService;
  preparedAttachmentService: PreparedAttachmentService;
  fileLibrary: FileLibrary;
  directoryLibrary: DirectoryLibrary;
  courseStore: CourseStore;
  learningFileStore: LearningFileStore;
  learningWorkspace: LearningWorkspaceController;
  workspaceOrchestrator: WorkspaceOrchestrator;
  config: AyatiRuntimeConfig;
}

export interface SkillRuntime {
  toolExecutor: ToolExecutor;
  skillActivationManager: SkillActivationManager;
  dynamicSkillCatalog: SkillCatalog;
  staticSkillsProvider: SkillsProvider;
  baseToolDefs: ToolDefinition[];
  runtimeToolDefs: ToolDefinition[];
  additionalSkills: SkillDefinition[];
}

export async function createSkillRuntime(options: SkillRuntimeOptions): Promise<SkillRuntime> {
  const builtInSkills = await builtInSkillsProvider.getAllSkills();
  const kernelSkillIds = new Set(["shell", "filesystem"]);
  const kernelSkills = builtInSkills.filter((skill) => kernelSkillIds.has(skill.id));
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
    createFocusSkill({
      store: options.focusStore,
      defaultClientId: options.clientId,
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
    createLearningFileSkill({
      learningFileStore: options.learningFileStore,
      learningWorkspace: options.learningWorkspace,
    }),
    createUiSkill({
      learningWorkspace: options.learningWorkspace,
      workspaceOrchestrator: options.workspaceOrchestrator,
      includeLearningTools: false,
    }),
  ];

  const dynamicSkillCatalog = new SkillCatalog([
    ...dynamicBuiltInSkills,
    ...runtimeSkills,
  ].map((skill) => createSkillBundle(skill)));

  const baseToolDefs = kernelSkills.flatMap((skill) => skill.tools);
  const toolExecutor = createToolExecutor(baseToolDefs);

  const skillActivationManager = new SkillActivationManager({
    catalog: dynamicSkillCatalog,
    toolExecutor,
  });

  const skillBrokerSkill = createSkillBrokerSkill(skillActivationManager);
  toolExecutor.mount?.("static:skill-broker", skillBrokerSkill.tools, {
    scope: "static",
    description: skillBrokerSkill.description,
  });

  const staticSkillsProvider = createStaticSkillsProvider([...kernelSkills, skillBrokerSkill]);
  const additionalSkills: SkillDefinition[] = [];

  return {
    toolExecutor,
    skillActivationManager,
    dynamicSkillCatalog,
    staticSkillsProvider,
    baseToolDefs,
    runtimeToolDefs: [...baseToolDefs, ...skillBrokerSkill.tools],
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
