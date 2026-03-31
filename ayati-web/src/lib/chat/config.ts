const DEFAULT_WEBSOCKET_URL = "ws://localhost:8080";
const DEFAULT_UPLOAD_URL = "http://localhost:8081/api/uploads";

export function getChatWebSocketUrl(): string {
  const configuredUrl = process.env.NEXT_PUBLIC_AYATI_WS_URL?.trim();
  if (configuredUrl && configuredUrl.length > 0) {
    return configuredUrl;
  }

  return DEFAULT_WEBSOCKET_URL;
}

export function getChatUploadUrl(): string {
  const configuredUrl = process.env.NEXT_PUBLIC_AYATI_UPLOAD_URL?.trim();
  if (configuredUrl && configuredUrl.length > 0) {
    return configuredUrl;
  }

  return DEFAULT_UPLOAD_URL;
}

export function getChatArtifactUrl(urlPath: string): string {
  const configuredBaseUrl = process.env.NEXT_PUBLIC_AYATI_ARTIFACT_BASE_URL?.trim();
  if (configuredBaseUrl && configuredBaseUrl.length > 0) {
    return new URL(urlPath, configuredBaseUrl).toString();
  }

  return new URL(urlPath, getChatUploadUrl()).toString();
}
