import { ContextEngineServiceError } from "../errors.js";

export const WORKSTREAM_CARD_PATH = "workstream.md";
export const WORKSTREAM_PROGRESS_PATH = "progress.md";
export const WORKSTREAM_REQUESTS_DIRECTORY = "requests";
export const WORKSTREAM_RESOURCES_PATH = "resources.json";
export const WORKSTREAM_SCHEMA = "ayati.workstream/v3";
export const WORKSTREAM_REQUEST_SCHEMA = "ayati.request/v3";

const WORKSTREAM_ID_PATTERN = /^W-\d{8}-\d{4}$/;
const REQUEST_ID_PATTERN = /^R-\d{4}$/;

export function isWorkstreamId(value: string): boolean {
  return WORKSTREAM_ID_PATTERN.test(value);
}

export function isRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value);
}

export function requireWorkstreamId(value: string): string {
  if (!isWorkstreamId(value)) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_CARD_INVALID",
      message: "Workstream ID must use W-YYYYMMDD-NNNN.",
      details: { field: "id", value },
    });
  }
  return value;
}

export function requireRequestId(value: string): string {
  if (!isRequestId(value)) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_REQUEST_INVALID",
      message: "Request ID must use R-NNNN.",
      details: { field: "id", value },
    });
  }
  return value;
}

export function workstreamSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "workstream";
}

export function workstreamDirectoryName(workstreamId: string, title: string): string {
  return requireWorkstreamId(workstreamId) + "-" + workstreamSlug(title);
}

export function requestFileName(requestId: string, title: string): string {
  return requireRequestId(requestId) + "-" + workstreamSlug(title) + ".md";
}

export function requestPath(requestId: string, title: string): string {
  return WORKSTREAM_REQUESTS_DIRECTORY + "/" + requestFileName(requestId, title);
}

export function requireRequestPath(path: string, requestId?: string): string {
  const match = /^requests\/(R-\d{4})-[a-z0-9](?:[a-z0-9-]{0,47})\.md$/.exec(path);
  if (!match || (requestId && match[1] !== requireRequestId(requestId))) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_REQUEST_INVALID",
      message: "Request path must use requests/R-NNNN-<creation-slug>.md.",
      details: { path, requestId: requestId ?? null },
    });
  }
  return path;
}

export function nextRequestId(existingIds: Iterable<string>): string {
  let largest = 0;
  for (const value of existingIds) {
    requireRequestId(value);
    largest = Math.max(largest, Number(value.slice(2)));
  }
  if (largest >= 9_999) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_REQUEST_INVALID",
      message: "The workstream has exhausted its request identifier range.",
    });
  }
  return "R-" + String(largest + 1).padStart(4, "0");
}
