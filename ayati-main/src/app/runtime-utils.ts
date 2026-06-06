export const DEFAULT_HTTP_PORT = 8081;
export const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function isEnvFalse(rawValue: string | undefined): boolean {
  return /^(?:0|false|no|off)$/i.test(rawValue ?? "");
}

export function hostForLocalClient(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}
