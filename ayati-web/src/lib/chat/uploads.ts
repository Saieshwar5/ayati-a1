import { getChatUploadUrl } from "@/lib/chat/config";
import type { UploadResponse, WebChatAttachment } from "@/lib/chat/types";

export async function uploadChatFiles(files: File[]): Promise<WebChatAttachment[]> {
  if (files.length === 0) {
    return [];
  }

  const uploadUrl = getChatUploadUrl();
  return Promise.all(files.map((file) => uploadSingleFile(uploadUrl, file)));
}

async function uploadSingleFile(uploadUrl: string, file: File): Promise<WebChatAttachment> {
  const formData = new FormData();
  formData.set("file", file);

  const response = await fetch(uploadUrl, {
    method: "POST",
    body: formData,
  });

  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    const message = payload && typeof payload["error"] === "string"
      ? payload["error"]
      : `Upload failed for ${file.name}.`;
    throw new Error(message);
  }

  const uploaded = parseUploadResponse(payload);
  if (!uploaded) {
    throw new Error(`Upload response for ${file.name} was invalid.`);
  }

  return {
    source: "web",
    uploadedPath: uploaded.uploadedPath,
    originalName: uploaded.originalName,
    ...(uploaded.mimeType ? { mimeType: uploaded.mimeType } : {}),
    sizeBytes: uploaded.sizeBytes,
  };
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown> | null> {
  const raw = await response.text();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseUploadResponse(payload: Record<string, unknown> | null): UploadResponse | null {
  if (!payload) {
    return null;
  }

  if (
    typeof payload["uploadId"] !== "string"
    || typeof payload["uploadedPath"] !== "string"
    || typeof payload["originalName"] !== "string"
    || typeof payload["sizeBytes"] !== "number"
  ) {
    return null;
  }

  return {
    uploadId: payload["uploadId"],
    uploadedPath: payload["uploadedPath"],
    originalName: payload["originalName"],
    mimeType: typeof payload["mimeType"] === "string" ? payload["mimeType"] : undefined,
    sizeBytes: payload["sizeBytes"],
  };
}
