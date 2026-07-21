import { ContextEngineServiceError } from "../errors.js";
import type {
  ResourceAvailability,
  ResourceKind,
  ResourceOrigin,
  ResourcePublicLocator,
  ResourceRole,
  ResourceVersion,
} from "../contracts.js";
import { requireRequestId, requireWorkstreamId } from "./workstream-repository-layout.js";

export const WORKSTREAM_RESOURCE_MANIFEST_SCHEMA = "ayati.workstream-resources/v1";

export interface WorkstreamResourceManifestEntry {
  resourceId: string;
  kind: ResourceKind;
  origin: ResourceOrigin;
  role: ResourceRole;
  access: "read" | "mutate";
  primary: boolean;
  requestIds: string[];
  displayName: string;
  description: string;
  aliases: string[];
  locator: ResourcePublicLocator;
  version: ResourceVersion;
  availability: ResourceAvailability;
  mediaType?: string;
  lastUsedAt?: string;
}

export interface WorkstreamResourceManifest {
  schema: typeof WORKSTREAM_RESOURCE_MANIFEST_SCHEMA;
  workstreamId: string;
  updatedAt: string;
  resources: WorkstreamResourceManifestEntry[];
}

export function renderWorkstreamResourceManifest(
  manifest: WorkstreamResourceManifest,
): string {
  const normalized = validateManifest(manifest);
  return JSON.stringify(normalized, null, 2) + "\n";
}

export function parseWorkstreamResourceManifest(
  content: string,
  expectedWorkstreamId?: string,
): WorkstreamResourceManifest {
  if (Buffer.byteLength(content, "utf8") > 256_000) {
    invalid("Workstream resource manifest exceeds its size limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    invalid("Workstream resource manifest is not valid JSON.");
  }
  const manifest = validateManifest(parsed);
  if (expectedWorkstreamId && manifest.workstreamId !== expectedWorkstreamId) {
    invalid("Workstream resource manifest identity does not match the workstream.", {
      expectedWorkstreamId,
      actualWorkstreamId: manifest.workstreamId,
    });
  }
  return manifest;
}

function validateManifest(value: unknown): WorkstreamResourceManifest {
  if (!isRecord(value)
    || value["schema"] !== WORKSTREAM_RESOURCE_MANIFEST_SCHEMA
    || typeof value["workstreamId"] !== "string"
    || typeof value["updatedAt"] !== "string"
    || !Array.isArray(value["resources"])) {
    invalid("Workstream resource manifest has an invalid shape.");
  }
  const workstreamId = requireWorkstreamId(value["workstreamId"] as string);
  const updatedAt = value["updatedAt"] as string;
  if (!Number.isFinite(Date.parse(updatedAt))) {
    invalid("Workstream resource manifest update time is invalid.");
  }
  const resources = (value["resources"] as unknown[]).map(validateEntry);
  const identities = new Set<string>();
  let primaryCount = 0;
  for (const resource of resources) {
    if (identities.has(resource.resourceId)) {
      invalid("Workstream resource manifest contains a duplicate resource.", {
        resourceId: resource.resourceId,
      });
    }
    identities.add(resource.resourceId);
    if (resource.primary) primaryCount += 1;
  }
  if (primaryCount > 1) {
    invalid("Workstream resource manifest may contain at most one primary resource.");
  }
  return {
    schema: WORKSTREAM_RESOURCE_MANIFEST_SCHEMA,
    workstreamId,
    updatedAt,
    resources: resources.sort((left, right) => left.resourceId.localeCompare(right.resourceId)),
  };
}

function validateEntry(value: unknown): WorkstreamResourceManifestEntry {
  if (!isRecord(value)
    || typeof value["resourceId"] !== "string"
    || !/^RES-[0-9A-F]{24}$/.test(value["resourceId"])
    || !isResourceKind(value["kind"])
    || !isResourceOrigin(value["origin"])
    || !isResourceRole(value["role"])
    || (value["access"] !== "read" && value["access"] !== "mutate")
    || typeof value["primary"] !== "boolean"
    || !Array.isArray(value["requestIds"])
    || !value["requestIds"].every((item) => typeof item === "string")
    || typeof value["displayName"] !== "string"
    || typeof value["description"] !== "string"
    || !Array.isArray(value["aliases"])
    || !value["aliases"].every((item) => typeof item === "string")
    || !isLocator(value["locator"])
    || !isVersion(value["version"])
    || !isAvailability(value["availability"])
    || (value["mediaType"] !== undefined && typeof value["mediaType"] !== "string")) {
    invalid("Workstream resource manifest contains an invalid resource entry.");
  }
  const requestIds = [...new Set((value["requestIds"] as string[]).map(requireRequestId))].sort();
  const aliases = [...new Set((value["aliases"] as string[]).map(normalizeText).filter(Boolean))].sort();
  const lastUsedAt = value["lastUsedAt"];
  if (lastUsedAt !== undefined
    && (typeof lastUsedAt !== "string" || !Number.isFinite(Date.parse(lastUsedAt)))) {
    invalid("Workstream resource manifest contains an invalid last-used time.");
  }
  return {
    resourceId: value["resourceId"] as string,
    kind: value["kind"] as ResourceKind,
    origin: value["origin"] as ResourceOrigin,
    role: value["role"] as ResourceRole,
    access: value["access"] as "read" | "mutate",
    primary: value["primary"] as boolean,
    requestIds,
    displayName: requiredText(value["displayName"], "display name", 500),
    description: requiredText(value["description"], "description", 2_000),
    aliases,
    locator: value["locator"] as ResourcePublicLocator,
    version: structuredClone(value["version"] as ResourceVersion),
    availability: value["availability"] as ResourceAvailability,
    ...(value["mediaType"]
      ? { mediaType: requiredText(value["mediaType"], "media type", 500) }
      : {}),
    ...(lastUsedAt ? { lastUsedAt: lastUsedAt as string } : {}),
  };
}

function isResourceOrigin(value: unknown): value is ResourceOrigin {
  return value === "user_attachment" || value === "user_reference"
    || value === "agent_created" || value === "agent_discovered"
    || value === "agent_download";
}

function isResourceKind(value: unknown): value is ResourceKind {
  return value === "file" || value === "directory" || value === "document"
    || value === "image" || value === "audio" || value === "video"
    || value === "dataset" || value === "database" || value === "git_repository"
    || value === "url" || value === "external_object";
}

function isResourceRole(value: unknown): value is ResourceRole {
  return value === "input" || value === "reference" || value === "primary"
    || value === "supporting" || value === "output" || value === "deliverable"
    || value === "evidence" || value === "asset";
}

function isAvailability(value: unknown): value is ResourceAvailability {
  return value === "available" || value === "missing" || value === "changed"
    || value === "deleted" || value === "unverified";
}

function isLocator(value: unknown): value is ResourcePublicLocator {
  if (!isRecord(value)) return false;
  if (value["kind"] === "filesystem") return typeof value["path"] === "string";
  if (value["kind"] === "managed_blob") return typeof value["resourceId"] === "string";
  if (value["kind"] === "url") return typeof value["url"] === "string";
  return value["kind"] === "external"
    && typeof value["provider"] === "string"
    && typeof value["externalId"] === "string"
    && (value["uri"] === undefined || typeof value["uri"] === "string");
}

function isVersion(value: unknown): value is ResourceVersion {
  if (!isRecord(value)
    || typeof value["key"] !== "string"
    || !value["key"].trim()
    || value["key"].length > 1_000
    || typeof value["observedAt"] !== "string"
    || !Number.isFinite(Date.parse(value["observedAt"]))
    || typeof value["exists"] !== "boolean"
    || !(value["kind"] === "file" || value["kind"] === "directory"
      || value["kind"] === "git" || value["kind"] === "url"
      || value["kind"] === "external" || value["kind"] === "unversioned")) {
    return false;
  }
  return optionalString(value["sha256"], 100)
    && optionalInteger(value["sizeBytes"])
    && optionalString(value["modifiedAt"], 100)
    && optionalString(value["fingerprint"], 1_000)
    && optionalInteger(value["entryCount"])
    && optionalString(value["head"], 100)
    && (value["dirty"] === undefined || typeof value["dirty"] === "boolean")
    && optionalString(value["etag"], 1_000)
    && optionalString(value["lastModified"], 1_000)
    && optionalString(value["externalVersion"], 1_000);
}

function optionalString(value: unknown, maximum: number): boolean {
  return value === undefined
    || (typeof value === "string" && value.length > 0 && value.length <= maximum);
}

function optionalInteger(value: unknown): boolean {
  return value === undefined
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") invalid("Workstream resource " + field + " is invalid.");
  const normalized = normalizeText(value as string);
  if (!normalized || normalized.length > maximum) {
    invalid("Workstream resource " + field + " is invalid.");
  }
  return normalized;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new ContextEngineServiceError({
    code: "WORKSTREAM_REPOSITORY_INVALID",
    message,
    ...(details ? { details } : {}),
  });
}
