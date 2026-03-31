import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import * as XLSX from "xlsx";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import { prepareIncomingAttachments } from "../../src/documents/attachment-preparer.js";
import type { DocumentContextBackend } from "../../src/documents/document-context-backend.js";
import { DocumentStore } from "../../src/documents/document-store.js";
import { PreparedAttachmentRegistry } from "../../src/documents/prepared-attachment-registry.js";
import { PreparedAttachmentService } from "../../src/documents/prepared-attachment-service.js";
import { createDatasetSkill } from "../../src/skills/builtins/datasets/index.js";
import { createDocumentSkill } from "../../src/skills/builtins/documents/index.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-prepared-tools-"));
}

function parseOutput(output: string | undefined): Record<string, unknown> {
  expect(output).toBeTruthy();
  return JSON.parse(output ?? "{}");
}

function mockProvider(): LlmProvider {
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi.fn(),
  };
}

function writeWorkbook(filePath: string, sheets: Array<{ name: string; rows: unknown[][] }>): void {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  }
  XLSX.writeFile(workbook, filePath);
}

describe("prepared attachment tools", () => {
  it("profiles, queries, and promotes prepared csv attachments", async () => {
    const dataDir = makeTmpDir();
    const runPath = join(dataDir, "runs", "run-1");
    const csvPath = join(dataDir, "sales.csv");
    writeFileSync(csvPath, "month,amount\nJan,120\nFeb,180\n", "utf-8");

    try {
      const documentStore = new DocumentStore({ dataDir: join(dataDir, "documents"), preferCli: false });
      const registered = await documentStore.registerAttachments([{ path: csvPath, name: "sales.csv" }]);
      const registry = new PreparedAttachmentRegistry();
      await prepareIncomingAttachments({
        attachedDocuments: registered.documents,
        runId: "run-1",
        runPath,
        documentStore,
        registry,
      });
      const service = new PreparedAttachmentService({
        registry,
        documentStore,
        provider: mockProvider(),
      });
      const datasetSkill = createDatasetSkill({ preparedAttachmentService: service });
      const profileTool = datasetSkill.tools.find((tool) => tool.name === "dataset_profile");
      const queryTool = datasetSkill.tools.find((tool) => tool.name === "dataset_query");
      const promoteTool = datasetSkill.tools.find((tool) => tool.name === "dataset_promote_table");
      expect(profileTool).toBeTruthy();
      expect(queryTool).toBeTruthy();
      expect(promoteTool).toBeTruthy();

      const profile = await profileTool!.execute({ preparedInputId: "att_1_" + registered.documents[0]!.documentId.slice(0, 8) }, { runId: "run-1" });
      expect(profile.ok).toBe(true);
      expect(parseOutput(profile.output)["rowCount"]).toBe(2);

      const query = await queryTool!.execute({
        preparedInputId: "att_1_" + registered.documents[0]!.documentId.slice(0, 8),
        sql: "SELECT month, amount FROM staging_att_1_" + registered.documents[0]!.documentId.slice(0, 8) + " ORDER BY amount DESC",
      }, { runId: "run-1" });
      expect(query.ok).toBe(true);
      const queryPayload = parseOutput(query.output);
      expect(queryPayload["rowCount"]).toBe(2);

      const promote = await promoteTool!.execute({
        preparedInputId: "att_1_" + registered.documents[0]!.documentId.slice(0, 8),
        targetTable: "sales_snapshot",
        targetDbPath: join(dataDir, "exports.sqlite"),
        ifExists: "replace",
      }, { runId: "run-1" });
      expect(promote.ok).toBe(true);
      expect(parseOutput(promote.output)["rowsCopied"]).toBe(2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("profiles, queries, and promotes prepared xlsx attachments", async () => {
    const dataDir = makeTmpDir();
    const runPath = join(dataDir, "runs", "run-1");
    const workbookPath = join(dataDir, "sales.xlsx");
    writeWorkbook(workbookPath, [
      {
        name: "Orders",
        rows: [["month", "amount"], ["Jan", 120], ["Feb", 180]],
      },
      {
        name: "Ignored",
        rows: [["month", "amount"], ["Mar", 90]],
      },
    ]);

    try {
      const documentStore = new DocumentStore({ dataDir: join(dataDir, "documents"), preferCli: false });
      const registered = await documentStore.registerAttachments([{ path: workbookPath, name: "sales.xlsx" }]);
      const registry = new PreparedAttachmentRegistry();
      await prepareIncomingAttachments({
        attachedDocuments: registered.documents,
        runId: "run-1",
        runPath,
        documentStore,
        registry,
      });
      const service = new PreparedAttachmentService({
        registry,
        documentStore,
        provider: mockProvider(),
      });
      const datasetSkill = createDatasetSkill({ preparedAttachmentService: service });
      const profileTool = datasetSkill.tools.find((tool) => tool.name === "dataset_profile");
      const queryTool = datasetSkill.tools.find((tool) => tool.name === "dataset_query");
      const promoteTool = datasetSkill.tools.find((tool) => tool.name === "dataset_promote_table");
      expect(profileTool).toBeTruthy();
      expect(queryTool).toBeTruthy();
      expect(promoteTool).toBeTruthy();

      const preparedInputId = `att_1_${registered.documents[0]!.documentId.slice(0, 8)}`;
      const profile = await profileTool!.execute({ preparedInputId }, { runId: "run-1" });
      expect(profile.ok).toBe(true);
      const profilePayload = parseOutput(profile.output);
      expect(profilePayload["rowCount"]).toBe(2);
      expect(profilePayload["sheetName"]).toBe("Orders");
      expect(profilePayload["sheetCount"]).toBe(2);
      expect(profilePayload["warnings"]).toEqual(["Workbook has 2 sheets; using first sheet: Orders"]);

      const query = await queryTool!.execute({
        preparedInputId,
        sql: `SELECT month, amount FROM staging_${preparedInputId} ORDER BY amount DESC`,
      }, { runId: "run-1" });
      expect(query.ok).toBe(true);
      const queryPayload = parseOutput(query.output);
      expect(queryPayload["rowCount"]).toBe(2);
      expect(JSON.stringify(queryPayload["rows"])).toContain("Feb");

      const promote = await promoteTool!.execute({
        preparedInputId,
        targetTable: "sales_snapshot",
        targetDbPath: join(dataDir, "exports.sqlite"),
        ifExists: "replace",
      }, { runId: "run-1" });
      expect(promote.ok).toBe(true);
      expect(parseOutput(promote.output)["rowsCopied"]).toBe(2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("resolves a single structured attachment when the reference is truncated or omitted", async () => {
    const dataDir = makeTmpDir();
    const runPath = join(dataDir, "runs", "run-1");
    const csvPath = join(dataDir, "employees.csv");
    writeFileSync(csvPath, "name,salary\nLila,42000\n", "utf-8");

    try {
      const documentStore = new DocumentStore({ dataDir: join(dataDir, "documents"), preferCli: false });
      const registered = await documentStore.registerAttachments([{ path: csvPath, name: "employees.csv" }]);
      const registry = new PreparedAttachmentRegistry();
      await prepareIncomingAttachments({
        attachedDocuments: registered.documents,
        runId: "run-1",
        runPath,
        documentStore,
        registry,
      });
      const service = new PreparedAttachmentService({
        registry,
        documentStore,
        provider: mockProvider(),
      });
      const datasetSkill = createDatasetSkill({ preparedAttachmentService: service });
      const queryTool = datasetSkill.tools.find((tool) => tool.name === "dataset_query");
      const profileTool = datasetSkill.tools.find((tool) => tool.name === "dataset_profile");
      expect(queryTool).toBeTruthy();
      expect(profileTool).toBeTruthy();

      const preparedInputId = `att_1_${registered.documents[0]!.documentId.slice(0, 8)}`;
      const truncatedReference = preparedInputId.slice(0, -1);
      const byPrefix = await queryTool!.execute({
        preparedInputId: truncatedReference,
        sql: `SELECT salary FROM staging_${preparedInputId} WHERE name = 'Lila'`,
      }, { runId: "run-1" });
      expect(byPrefix.ok).toBe(true);
      expect(JSON.stringify(parseOutput(byPrefix.output))).toContain("42000");

      const autoSelected = await profileTool!.execute({}, { runId: "run-1" });
      expect(autoSelected.ok).toBe(true);
      expect(parseOutput(autoSelected.output)["displayName"]).toBe("employees.csv");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("lists and reads prepared document sections", async () => {
    const dataDir = makeTmpDir();
    const runPath = join(dataDir, "runs", "run-1");
    const textPath = join(dataDir, "profile.txt");
    writeFileSync(textPath, "Summary\n\nNode.js engineer\n\nProjects\n\nBuilt APIs", "utf-8");

    try {
      const documentStore = new DocumentStore({ dataDir: join(dataDir, "documents"), preferCli: false });
      const registered = await documentStore.registerAttachments([{ path: textPath, name: "profile.txt" }]);
      const registry = new PreparedAttachmentRegistry();
      await prepareIncomingAttachments({
        attachedDocuments: registered.documents,
        runId: "run-1",
        runPath,
        documentStore,
        registry,
      });
      const service = new PreparedAttachmentService({
        registry,
        documentStore,
        provider: mockProvider(),
      });
      const documentSkill = createDocumentSkill({ preparedAttachmentService: service });
      const listTool = documentSkill.tools.find((tool) => tool.name === "document_list_sections");
      const readTool = documentSkill.tools.find((tool) => tool.name === "document_read_section");
      expect(listTool).toBeTruthy();
      expect(readTool).toBeTruthy();

      const preparedInputId = "att_1_" + registered.documents[0]!.documentId.slice(0, 8);
      const listed = await listTool!.execute({ preparedInputId }, { runId: "run-1" });
      expect(listed.ok).toBe(true);
      const listedPayload = parseOutput(listed.output);
      const sections = listedPayload["sections"] as Array<{ id: string }>;
      expect(sections.length).toBeGreaterThan(0);

      const read = await readTool!.execute({ preparedInputId, sectionIds: [sections[0]!.id] }, { runId: "run-1" });
      expect(read.ok).toBe(true);
      expect(JSON.stringify(parseOutput(read.output))).toContain("Node.js engineer");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("queries prepared documents through the document backend", async () => {
    const dataDir = makeTmpDir();
    const runPath = join(dataDir, "runs", "run-1");
    const textPath = join(dataDir, "profile.txt");
    writeFileSync(textPath, "Summary\n\nNode.js engineer", "utf-8");

    try {
      const documentStore = new DocumentStore({ dataDir: join(dataDir, "documents"), preferCli: false });
      const registered = await documentStore.registerAttachments([{ path: textPath, name: "profile.txt" }]);
      const registry = new PreparedAttachmentRegistry();
      await prepareIncomingAttachments({
        attachedDocuments: registered.documents,
        runId: "run-1",
        runPath,
        documentStore,
        registry,
      });
      const backend = {
        search: vi.fn().mockResolvedValue({
          context: "The profile says the candidate is a Node.js engineer.",
          sources: [textPath],
          confidence: 0.92,
          documentState: {
            status: "sufficient",
            insufficientEvidence: false,
            warnings: [],
          },
        }),
      } as unknown as DocumentContextBackend;
      const service = new PreparedAttachmentService({
        registry,
        documentStore,
        provider: mockProvider(),
        documentContextBackend: backend,
      });
      const documentSkill = createDocumentSkill({ preparedAttachmentService: service });
      const queryTool = documentSkill.tools.find((tool) => tool.name === "document_query");
      expect(queryTool).toBeTruthy();

      const preparedInputId = "att_1_" + registered.documents[0]!.documentId.slice(0, 8);
      const queried = await queryTool!.execute({ preparedInputId, query: "What does the profile say?" }, { runId: "run-1" });
      expect(queried.ok).toBe(true);
      expect(parseOutput(queried.output)["confidence"]).toBe(0.92);
      expect(backend.search).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("resolves a single document attachment by name or omitted reference", async () => {
    const dataDir = makeTmpDir();
    const runPath = join(dataDir, "runs", "run-1");
    const textPath = join(dataDir, "summary.txt");
    writeFileSync(textPath, "Summary\n\nThis file explains the Helix process.", "utf-8");

    try {
      const documentStore = new DocumentStore({ dataDir: join(dataDir, "documents"), preferCli: false });
      const registered = await documentStore.registerAttachments([{ path: textPath, name: "summary.txt" }]);
      const registry = new PreparedAttachmentRegistry();
      await prepareIncomingAttachments({
        attachedDocuments: registered.documents,
        runId: "run-1",
        runPath,
        documentStore,
        registry,
      });
      const service = new PreparedAttachmentService({
        registry,
        documentStore,
        provider: mockProvider(),
      });
      const documentSkill = createDocumentSkill({ preparedAttachmentService: service });
      const readTool = documentSkill.tools.find((tool) => tool.name === "document_read_section");
      const listTool = documentSkill.tools.find((tool) => tool.name === "document_list_sections");
      expect(readTool).toBeTruthy();
      expect(listTool).toBeTruthy();

      const byName = await listTool!.execute({
        preparedInputId: "summary.txt",
      }, { runId: "run-1" });
      expect(byName.ok).toBe(true);
      const byNamePayload = parseOutput(byName.output);
      const sections = byNamePayload["sections"] as Array<{ id: string }>;
      expect(sections.length).toBeGreaterThan(0);

      const read = await readTool!.execute({ sectionIds: [sections[0]!.id] }, { runId: "run-1" });
      expect(read.ok).toBe(true);
      expect(JSON.stringify(parseOutput(read.output))).toContain("Helix process");

      const autoSelected = await listTool!.execute({}, { runId: "run-1" });
      expect(autoSelected.ok).toBe(true);
      const payload = parseOutput(autoSelected.output);
      expect(payload["displayName"]).toBe("summary.txt");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
