import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareIncomingAttachments } from "../../src/documents/attachment-preparer.js";
import { DocumentStore } from "../../src/documents/document-store.js";
import { PreparedAttachmentRegistry } from "../../src/documents/prepared-attachment-registry.js";
import { SessionAttachmentService } from "../../src/documents/session-attachment-service.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-session-attachments-"));
}

describe("SessionAttachmentService", () => {
  it("does not auto-restore an older session attachment when the current run already has attachments", async () => {
    const dataDir = makeTmpDir();

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
        attachmentRoot: join(dataDir, "prepared-attachments", "run-1"),
        documentStore,
        registry,
      });

      const secondRegistered = await documentStore.registerAttachments([{ path: newCsvPath, name: "electronic-card-transactions-february-2026-csv-tables.csv" }]);
      await prepareIncomingAttachments({
        attachedDocuments: secondRegistered.documents,
        runId: "run-2",
        attachmentRoot: join(dataDir, "prepared-attachments", "run-2"),
        documentStore,
        registry,
      });

      const service = new SessionAttachmentService({
        preparedAttachmentRegistry: registry,
        dataDir,
        documentStore,
      });

      await expect(service.restoreAttachmentContext({ runId: "run-2" })).rejects.toThrow(
        "Current run already has attachments. Use the current attachment, or specify the earlier file to restore.",
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("restores a document from git task assets without activity memory", async () => {
    const dataDir = makeTmpDir();

    try {
      const policyPath = join(dataDir, "policy.txt");
      writeFileSync(policyPath, "Renewal happens automatically unless cancelled in writing.", "utf-8");

      const documentStore = new DocumentStore({
        dataDir: join(dataDir, "documents"),
        preferCli: false,
      });
      const registry = new PreparedAttachmentRegistry();
      const service = new SessionAttachmentService({
        preparedAttachmentRegistry: registry,
        dataDir,
        documentStore,
      });

      const restored = await service.restoreAttachmentContext({
        runId: "run-git-assets",
        reference: "policy.txt",
        taskAssets: [{
          assetId: "A-20260627-0001",
          role: "input",
          kind: "document",
          name: "policy.txt",
          path: policyPath,
        }],
      });

      expect(restored).toMatchObject({
        source: "task_asset",
        assetId: "A-20260627-0001",
        restored: true,
        attachmentKind: "document",
      });
      expect(registry.getRunAttachments("run-git-assets")[0]?.summary.displayName).toBe("policy.txt");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
