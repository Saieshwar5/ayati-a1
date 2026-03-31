import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "./types.js";

export interface PreparedAttachmentDetailRecord {
  kind: "structured_data" | "unstructured_text" | "unsupported";
  payload: Record<string, unknown>;
}

export interface PreparedAttachmentRecord {
  summary: PreparedAttachmentSummary;
  manifest: ManagedDocumentManifest;
  runPath: string;
  detail: PreparedAttachmentDetailRecord;
}

export class PreparedAttachmentRegistry {
  private readonly runs = new Map<string, {
    runPath: string;
    attachments: Map<string, PreparedAttachmentRecord>;
  }>();

  registerRunAttachments(runId: string, runPath: string, records: PreparedAttachmentRecord[]): void {
    this.runs.set(runId, {
      runPath,
      attachments: new Map(records.map((record) => [record.summary.preparedInputId, record])),
    });
  }

  upsertRunAttachment(runId: string, runPath: string, record: PreparedAttachmentRecord): void {
    const run = this.runs.get(runId);
    if (!run) {
      this.registerRunAttachments(runId, runPath, [record]);
      return;
    }
    run.runPath = runPath;
    run.attachments.set(record.summary.preparedInputId, record);
  }

  getRunAttachments(runId: string): PreparedAttachmentRecord[] {
    return [...(this.runs.get(runId)?.attachments.values() ?? [])];
  }

  getAttachment(runId: string, preparedInputId: string): PreparedAttachmentRecord | null {
    return this.runs.get(runId)?.attachments.get(preparedInputId) ?? null;
  }

  updateAttachmentSummary(
    runId: string,
    preparedInputId: string,
    updater: (summary: PreparedAttachmentSummary) => PreparedAttachmentSummary,
  ): PreparedAttachmentSummary | null {
    const record = this.getAttachment(runId, preparedInputId);
    if (!record) {
      return null;
    }
    record.summary = updater(record.summary);
    return record.summary;
  }

  clearRun(runId: string): void {
    this.runs.delete(runId);
  }
}
