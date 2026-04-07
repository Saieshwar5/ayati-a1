import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isSupportedDocumentInput, sanitizeFileName } from "../documents/document-ingress.js";

export interface ManagedUploadRecord {
  uploadId: string;
  uploadedPath: string;
  originalName: string;
  mimeType?: string;
  sizeBytes: number;
}

export interface PersistManagedUploadInput {
  uploadsDir: string;
  originalName: string;
  bytes: Uint8Array;
  mimeType?: string;
  maxUploadBytes: number;
}

export async function persistManagedUpload(input: PersistManagedUploadInput): Promise<ManagedUploadRecord> {
  const originalName = input.originalName.trim();
  if (originalName.length === 0) {
    throw new Error("uploaded file is missing a filename.");
  }

  const mimeType = input.mimeType?.trim() || undefined;
  if (!isSupportedDocumentInput(originalName, mimeType)) {
    throw new Error("unsupported file type.");
  }

  const bytes = Buffer.from(input.bytes);
  if (bytes.length === 0) {
    throw new Error("uploaded file is empty.");
  }

  if (bytes.length > input.maxUploadBytes) {
    throw new Error(`upload exceeds ${input.maxUploadBytes} bytes.`);
  }

  const uploadId = randomUUID();
  const storedName = sanitizeFileName(originalName);
  const uploadDir = join(resolve(input.uploadsDir), uploadId);
  const uploadedPath = resolve(join(uploadDir, storedName));

  await mkdir(uploadDir, { recursive: true });
  await writeFile(uploadedPath, bytes);

  return {
    uploadId,
    uploadedPath,
    originalName,
    ...(mimeType ? { mimeType } : {}),
    sizeBytes: bytes.length,
  };
}
