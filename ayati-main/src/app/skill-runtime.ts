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
import type { CourseStore } from "../learning/course-store.js";
import type { LearningFileStore } from "../learning/file-store.js";
import type { LearningWorkspaceController } from "../ui/learning-workspace.js";
import type { WorkspaceOrchestrator } from "../ui/workspace-orchestrator.js";
import type { AyatiRuntimeConfig } from "../config/runtime-config.js";
import { builtInSkillsProvider } from "../skills/provider.js";
import { createToolExecutor, type ToolExecutor } from "../skills/tool-executor.js";
import type { SkillDefinition, ToolDefinition } from "../skills/types.js";
import { createRecallSkill } from "../skills/builtins/recall/index.js";
import { createMemorySkill } from "../skills/builtins/memory/index.js";
import { createPythonSkill } from "../skills/builtins/python/index.js";
import { createAttachmentSkill } from "../skills/builtins/attachments/index.js";
import { createDatasetSkill } from "../skills/builtins/datasets/index.js";
import { createDocumentSkill } from "../skills/builtins/documents/index.js";
import { createFilesSkill } from "../skills/builtins/files/index.js";
import { createLearningFileSkill } from "../skills/builtins/learning-v2/index.js";
import { createUiSkill } from "../skills/builtins/ui/index.js";
import { createSkillBrokerSkill } from "../skills/builtins/skill-broker/index.js";
import {
  createExternalSkillBroker,
  ExternalSkillRegistry,
  type ExternalSkillBroker,
  type ExternalSkillScanRoot,
} from "../skills/external/index.js";

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
  courseStore: CourseStore;
  learningFileStore: LearningFileStore;
  learningWorkspace: LearningWorkspaceController;
  workspaceOrchestrator: WorkspaceOrchestrator;
  config: AyatiRuntimeConfig;
}

export interface SkillRuntime {
  toolExecutor: ToolExecutor;
  externalSkillBroker: ExternalSkillBroker;
  externalSkillRegistry: ExternalSkillRegistry;
  baseToolDefs: ToolDefinition[];
  runtimeToolDefs: ToolDefinition[];
  additionalSkills: SkillDefinition[];
}

export async function createSkillRuntime(options: SkillRuntimeOptions): Promise<SkillRuntime> {
  const enabledTools = await builtInSkillsProvider.getAllTools();

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

  const baseToolDefs = [
    ...enabledTools,
    ...runtimeSkills.flatMap((skill) => skill.tools),
  ];
  const toolExecutor = createToolExecutor(baseToolDefs);
  const externalSkillRoots: ExternalSkillScanRoot[] = [
    { skillsDir: resolve(options.projectRoot, "data", "skills"), source: "project" },
  ];
  const externalSkillBroker = createExternalSkillBroker({
    roots: externalSkillRoots,
    cachePath: resolve(options.projectRoot, "data", "skills", "catalog.json"),
    secretMappingPath: resolve(options.projectRoot, "context", "skill-secrets.json"),
    policyPath: resolve(options.projectRoot, "context", "skill-policy.json"),
    toolExecutor,
  });
  await externalSkillBroker.initialize();

  const skillBrokerSkill = createSkillBrokerSkill(externalSkillBroker);
  toolExecutor.mount?.("static:skill-broker", skillBrokerSkill.tools, {
    scope: "static",
    description: skillBrokerSkill.description,
  });

  const externalSkillRegistry = new ExternalSkillRegistry({
    roots: externalSkillRoots,
    secretMappingPath: resolve(options.projectRoot, "context", "skill-secrets.json"),
    policyPath: resolve(options.projectRoot, "context", "skill-policy.json"),
  });
  await externalSkillRegistry.initialize();

  const additionalSkills = [...runtimeSkills, skillBrokerSkill];

  return {
    toolExecutor,
    externalSkillBroker,
    externalSkillRegistry,
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
