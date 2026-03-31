import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PreparedManagedDocument } from "./document-store.js";
import type {
  DocumentChunkVectorRecord,
  DocumentEmbeddingProvider,
  DocumentVectorStore,
} from "./document-vector-types.js";

interface DocumentVectorIndexMetadata {
  version: 1;
  documentId: string;
  checksum: string;
  chunkCount: number;
  embeddingModel: string;
  indexedAt: string;
}

export interface DocumentIndexerOptions {
  embedder: DocumentEmbeddingProvider;
  store: DocumentVectorStore;
  documentsDir: string;
  now?: () => Date;
  batchSize?: number;
}

const INDEX_METADATA_VERSION = 1;
const DEFAULT_BATCH_SIZE = 32;

export class DocumentIndexer {
  private readonly embedder: DocumentEmbeddingProvider;
  private readonly store: DocumentVectorStore;
  private readonly documentsDir: string;
  private readonly nowProvider: () => Date;
  private readonly batchSize: number;

  constructor(options: DocumentIndexerOptions) {
    this.embedder = options.embedder;
    this.store = options.store;
    this.documentsDir = options.documentsDir;
    this.nowProvider = options.now ?? (() => new Date());
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  }

  async ensureIndexed(documents: PreparedManagedDocument[]): Promise<void> {
    for (const document of documents) {
      await this.ensureDocumentIndexed(document);
    }
  }

  async ensureDocumentIndexed(document: PreparedManagedDocument): Promise<void> {
    if (document.chunks.length === 0) {
      return;
    }

    const metadataPath = this.getMetadataPath(document.manifest.documentId);
    const currentMetadata = await this.readMetadata(metadataPath);
    if (
      currentMetadata
      && currentMetadata.version === INDEX_METADATA_VERSION
      && currentMetadata.documentId === document.manifest.documentId
      && currentMetadata.checksum === document.manifest.checksum
      && currentMetadata.chunkCount === document.chunks.length
      && currentMetadata.embeddingModel === this.embedder.modelName
    ) {
      return;
    }

    const embeddings = await embedTexts(this.embedder, document.chunks.map((chunk) => chunk.text), this.batchSize);
    const indexedAt = this.nowProvider().toISOString();
    const records: DocumentChunkVectorRecord[] = document.chunks.map((chunk, index) => ({
      id: `${this.embedder.modelName}:${chunk.sourceId}`,
      documentId: document.manifest.documentId,
      checksum: document.manifest.checksum,
      sourceId: chunk.sourceId,
      documentName: chunk.documentName,
      documentPath: chunk.documentPath,
      location: chunk.location,
      text: chunk.text,
      tokens: chunk.tokens,
      embedding: embeddings[index] ?? [],
      embeddingModel: this.embedder.modelName,
      indexedAt,
    }));

    await this.store.upsertDocumentChunks(records);
    await mkdir(join(this.documentsDir, document.manifest.documentId), { recursive: true });
    await writeFile(metadataPath, JSON.stringify({
      version: INDEX_METADATA_VERSION,
      documentId: document.manifest.documentId,
      checksum: document.manifest.checksum,
      chunkCount: document.chunks.length,
      embeddingModel: this.embedder.modelName,
      indexedAt,
    } satisfies DocumentVectorIndexMetadata, null, 2), "utf-8");
  }

  private getMetadataPath(documentId: string): string {
    return join(this.documentsDir, documentId, "vector-index.json");
  }

  private async readMetadata(path: string): Promise<DocumentVectorIndexMetadata | null> {
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<DocumentVectorIndexMetadata>;
      if (
        parsed
        && parsed.version === INDEX_METADATA_VERSION
        && typeof parsed.documentId === "string"
        && typeof parsed.checksum === "string"
        && typeof parsed.chunkCount === "number"
        && typeof parsed.embeddingModel === "string"
        && typeof parsed.indexedAt === "string"
      ) {
        return parsed as DocumentVectorIndexMetadata;
      }
    } catch {
      // Ignore cache read failures and rebuild.
    }
    return null;
  }
}

async function embedTexts(
  embedder: DocumentEmbeddingProvider,
  texts: string[],
  batchSize: number,
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  if (typeof embedder.embedBatch === "function") {
    const results: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      results.push(...await embedder.embedBatch(texts.slice(offset, offset + batchSize)));
    }
    return results;
  }

  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embedder.embed(text));
  }
  return results;
}
