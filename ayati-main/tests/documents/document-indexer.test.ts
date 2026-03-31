import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/documents/document-store.js";
import { DocumentIndexer } from "../../src/documents/document-indexer.js";
import type {
  DocumentChunkVectorMatch,
  DocumentChunkVectorRecord,
  DocumentEmbeddingProvider,
  DocumentVectorSearchInput,
  DocumentVectorStore,
} from "../../src/documents/document-vector-types.js";

class InMemoryDocumentVectorStore implements DocumentVectorStore {
  records: DocumentChunkVectorRecord[] = [];
  upsertCalls = 0;

  async upsertDocumentChunks(records: DocumentChunkVectorRecord[]): Promise<void> {
    this.upsertCalls++;
    this.records = this.records.filter((candidate) => !records.some((record) => (
      record.documentId === candidate.documentId && record.embeddingModel === candidate.embeddingModel
    )));
    this.records.push(...records);
  }

  async search(_input: DocumentVectorSearchInput): Promise<DocumentChunkVectorMatch[]> {
    return [];
  }
}

describe("DocumentIndexer", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("indexes prepared chunks once and reuses cached index metadata", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "document-indexer-"));
    const attachmentPath = join(tmpDir, "policy.txt");
    writeFileSync(
      attachmentPath,
      [
        "Page one details.\f",
        "Termination requires 30 days written notice before cancellation.\f",
        "Payments are due within 15 days.",
      ].join("\n"),
      "utf-8",
    );

    const store = new DocumentStore({
      dataDir: join(tmpDir, "documents"),
      preferCli: false,
    });
    const registered = await store.registerAttachments([{ path: attachmentPath, name: "policy.txt" }]);
    const prepared = await store.prepareDocuments(registered.documents);
    const vectorStore = new InMemoryDocumentVectorStore();
    const embedder: DocumentEmbeddingProvider = {
      modelName: "test-embedding-model",
      embed: vi.fn(async (text: string) => [text.length, 1]),
      embedBatch: vi.fn(async (texts: string[]) => texts.map((text) => [text.length, 1])),
    };
    const indexer = new DocumentIndexer({
      embedder,
      store: vectorStore,
      documentsDir: store.documentsDir,
    });

    await indexer.ensureIndexed(prepared);
    await indexer.ensureIndexed(prepared);

    expect(vectorStore.upsertCalls).toBe(1);
    expect(vectorStore.records.length).toBe(prepared[0]?.chunks.length ?? 0);
    expect(embedder.embedBatch as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);

    const metadataPath = join(store.documentsDir, registered.documents[0]!.documentId, "vector-index.json");
    expect(existsSync(metadataPath)).toBe(true);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as Record<string, unknown>;
    expect(metadata["embeddingModel"]).toBe("test-embedding-model");
    expect(metadata["chunkCount"]).toBe(prepared[0]?.chunks.length ?? 0);
  });
});
