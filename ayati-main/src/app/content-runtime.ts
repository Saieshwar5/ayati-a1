import { resolve } from "node:path";
import type { LlmProvider } from "../core/index.js";
import type { SessionMemory } from "../memory/types.js";
import { DocumentStore } from "../documents/document-store.js";
import { DocumentContextBackend } from "../documents/document-context-backend.js";
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
import type { AyatiRuntimeConfig } from "../config/runtime-config.js";
import type { EmbeddingProvider } from "../embeddings/contracts.js";

export interface ContentRuntimeOptions {
  projectRoot: string;
  provider: LlmProvider;
  sessionMemory: SessionMemory;
  config: AyatiRuntimeConfig;
  embeddingProvider?: EmbeddingProvider;
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

export async function createContentRuntime(options: ContentRuntimeOptions): Promise<ContentRuntime> {
  const { projectRoot, provider, sessionMemory, config } = options;
  const dataDir = resolve(projectRoot, "data");

  const documentStore = new DocumentStore({
    dataDir: resolve(dataDir, "documents"),
  });
  const fileLibrary = new FileLibrary({
    dataDir,
    defaultMaxDownloadBytes: config.http.maxUploadBytes,
  });
  const directoryLibrary = new DirectoryLibrary({
    dataDir,
  });

  let documentIndexer: DocumentIndexer | undefined;
  let documentRetriever: DocumentRetriever | undefined;
  if (config.documents.vectorEnabled && options.embeddingProvider) {
    try {
      const documentEmbedder = options.embeddingProvider;
      await documentEmbedder.start();
      const documentVectorStore = new LanceDocumentVectorStore({
        dataDir: resolve(dataDir, "documents", "vector"),
      });
      documentIndexer = new DocumentIndexer({
        embedder: documentEmbedder,
        store: documentVectorStore,
        documentsDir: documentStore.documentsDir,
        batchSize: config.documents.embedBatchSize,
      });
      documentRetriever = new DocumentRetriever({
        embedder: documentEmbedder,
        store: documentVectorStore,
      });
      devLog(`Document vector retrieval enabled with model=${documentEmbedder.modelName}`);
    } catch (err) {
      devWarn(`Document vector retrieval disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (config.documents.vectorEnabled) {
    devWarn("Document vector retrieval disabled: no embedding provider configured.");
  }

  const documentContextBackend = new DocumentContextBackend({
    store: documentStore,
    ...(documentIndexer ? { documentIndexer } : {}),
    ...(documentRetriever ? { documentRetriever } : {}),
    largeDocumentMinChunks: config.documents.vectorMinChunks,
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
  const learningWorkspace = new LearningWorkspaceController({
    projectRoot,
    dataDir,
    httpBaseUrl: config.learning.apiBaseUrl,
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
    httpHost: config.http.host,
    httpPort: config.http.port,
  };
}
