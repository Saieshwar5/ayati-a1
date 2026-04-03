import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareIncomingAttachments } from "../../src/documents/attachment-preparer.js";
import { DocumentStore } from "../../src/documents/document-store.js";
import { PreparedAttachmentRegistry } from "../../src/documents/prepared-attachment-registry.js";
import { SessionAttachmentService } from "../../src/documents/session-attachment-service.js";
import { MemoryManager } from "../../src/memory/session-manager.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-session-attachments-"));
}

describe("SessionAttachmentService", () => {
  it("does not auto-restore an older session attachment when the current run already has attachments", async () => {
    const dataDir = makeTmpDir();
    const sessionMemory = new MemoryManager({ dataDir: join(dataDir, "memory") });
    sessionMemory.initialize("c1");

    try {
      const oldCsvPath = join(dataDir, "chat_states_1k.csv");
      const newCsvPath = join(dataDir, "electronic-card-transactions-february-2026-csv-tables.csv");
      writeFileSync(oldCsvPath, "stage,count\nLEAD-NEW,10\n", "utf-8");
      writeFileSync(newCsvPath, "txn_type,amount\npurchase,120\n", "utf-8");

      const documentStore = new DocumentStore({
        dataDir: join(dataDir, "documents"),
        preferCli: false,
      });
      const registry = new PreparedAttachmentRegistry();

      const firstRegistered = await documentStore.registerAttachments([{ path: oldCsvPath, name: "chat_states_1k.csv" }]);
      await prepareIncomingAttachments({
        attachedDocuments: firstRegistered.documents,
        runId: "run-1",
        runPath: join(dataDir, "runs", "run-1"),
        documentStore,
        registry,
      });

      const firstRunRecords = registry.getRunAttachments("run-1");
      sessionMemory.recordActiveAttachments?.("c1", {
        runId: "run-1",
        sessionId: "session-1",
        runPath: join(dataDir, "runs", "run-1"),
        action: "prepared",
        attachments: firstRunRecords.map((record) => ({
          manifest: record.manifest,
          summary: record.summary,
          detail: record.detail.payload,
        })),
      });

      const secondRegistered = await documentStore.registerAttachments([{ path: newCsvPath, name: "electronic-card-transactions-february-2026-csv-tables.csv" }]);
      await prepareIncomingAttachments({
        attachedDocuments: secondRegistered.documents,
        runId: "run-2",
        runPath: join(dataDir, "runs", "run-2"),
        documentStore,
        registry,
      });

      const service = new SessionAttachmentService({
        sessionMemory,
        preparedAttachmentRegistry: registry,
        dataDir,
      });

      await expect(service.restoreAttachmentContext({ runId: "run-2" })).rejects.toThrow(
        "Current run already has attachments. Use the current attachment, or specify the earlier file to restore.",
      );
    } finally {
      await sessionMemory.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
