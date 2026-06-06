import { resolve } from "node:path";
import type { LlmProvider } from "../core/index.js";
import type { SessionMemory } from "../memory/types.js";
import { DocumentStore } from "../documents/document-store.js";
import { DocumentContextBackend } from "../documents/document-context-backend.js";
import { OpenAiDocumentEmbedder } from "../documents/openai-document-embedder.js";
import { LanceDocumentVectorStore } from "../documents/document-vector-store.js";
import { DocumentIndexer } from "../documents/document-indexer.js";
import { DocumentRetriever } from "../documents/document-retriever.js";
import { PreparedAttachmentRegistry } from "../documents/prepared-attachment-registry.js";
import { PreparedAttachmentService } from "../documents/prepared-attachment-service.js";
import { SessionAttachmentService } from "../documents/session-attachment-service.js";
import { DirectoryLibrary } from "../files/directory-library.js";
import { FileLibrary } from "../files/file-library.js";
import { CourseStore } from "../learning/course-store.js";
import { LearningWorkspaceController } from "../ui/learning-workspace.js";
import { devLog, devWarn } from "../shared/index.js";
import {
  DEFAULT_HTTP_PORT,
  DEFAULT_UPLOAD_MAX_BYTES,
  hostForLocalClient,
  isEnvFalse,
  parsePositiveInt,
} from "./runtime-utils.js";

export interface ContentRuntimeOptions {
  projectRoot: string;
  provider: LlmProvider;
  sessionMemory: SessionMemory;
  env?: NodeJS.ProcessEnv;
}

export interface ContentRuntime {
  documentStore: DocumentStore;
  documentContextBackend: DocumentContextBackend;
  preparedAttachmentRegistry: PreparedAttachmentRegistry;
  preparedAttachmentService: PreparedAttachmentService;
  sessionAttachmentService: SessionAttachmentService;
  fileLibrary: FileLibrary;
  directoryLibrary: DirectoryLibrary;
  courseStore: CourseStore;
  learningWorkspace: LearningWorkspaceController;
  httpHost: string;
  httpPort: number;
}

export function createContentRuntime(options: ContentRuntimeOptions): ContentRuntime {
  const { projectRoot, provider, sessionMemory } = options;
  const env = options.env ?? process.env;
  const dataDir = resolve(projectRoot, "data");

  const documentStore = new DocumentStore({
    dataDir: resolve(dataDir, "documents"),
  });
  const fileLibrary = new FileLibrary({
    dataDir,
    defaultMaxDownloadBytes: parsePositiveInt(env["AYATI_UPLOAD_MAX_BYTES"], DEFAULT_UPLOAD_MAX_BYTES),
  });
  const directoryLibrary = new DirectoryLibrary({
    dataDir,
  });

  let documentIndexer: DocumentIndexer | undefined;
  let documentRetriever: DocumentRetriever | undefined;
  if (!isEnvFalse(env["AYATI_DOCUMENT_VECTOR_ENABLED"])) {
    try {
      const documentEmbedder = new OpenAiDocumentEmbedder();
      const documentVectorStore = new LanceDocumentVectorStore({
        dataDir: resolve(dataDir, "documents", "vector"),
      });
      documentIndexer = new DocumentIndexer({
        embedder: documentEmbedder,
        store: documentVectorStore,
        documentsDir: documentStore.documentsDir,
        batchSize: parsePositiveInt(env["AYATI_DOCUMENT_EMBED_BATCH_SIZE"], 32),
      });
      documentRetriever = new DocumentRetriever({
        embedder: documentEmbedder,
        store: documentVectorStore,
      });
      devLog(`Document vector retrieval enabled with model=${documentEmbedder.modelName}`);
    } catch (err) {
      devWarn(`Document vector retrieval disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const documentContextBackend = new DocumentContextBackend({
    store: documentStore,
    ...(documentIndexer ? { documentIndexer } : {}),
    ...(documentRetriever ? { documentRetriever } : {}),
    largeDocumentMinChunks: parsePositiveInt(env["AYATI_DOCUMENT_VECTOR_MIN_CHUNKS"], 40),
  });
  const preparedAttachmentRegistry = new PreparedAttachmentRegistry();
  const preparedAttachmentService = new PreparedAttachmentService({
    registry: preparedAttachmentRegistry,
    documentStore,
    provider,
    documentContextBackend,
  });
  const sessionAttachmentService = new SessionAttachmentService({
    sessionMemory,
    preparedAttachmentRegistry,
    dataDir,
  });

  const courseStore = new CourseStore({
    dataDir,
  });
  const httpHost = env["AYATI_HTTP_HOST"]?.trim() || env["AYATI_UPLOAD_HOST"]?.trim() || "127.0.0.1";
  const httpPort = parsePositiveInt(env["AYATI_HTTP_PORT"] ?? env["AYATI_UPLOAD_PORT"], DEFAULT_HTTP_PORT);
  const learningWorkspace = new LearningWorkspaceController({
    projectRoot,
    dataDir,
    httpBaseUrl: env["AYATI_LEARNING_API_BASE"]?.trim()
      || `http://${hostForLocalClient(httpHost)}:${httpPort}`,
  });

  return {
    documentStore,
    documentContextBackend,
    preparedAttachmentRegistry,
    preparedAttachmentService,
    sessionAttachmentService,
    fileLibrary,
    directoryLibrary,
    courseStore,
    learningWorkspace,
    httpHost,
    httpPort,
  };
}
