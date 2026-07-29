import { basename } from "node:path";
import type {
  ResourcePublicLocator,
  ResourceRef,
  ResourceVersion,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { ContextEngineServiceError } from "../errors.js";
import { requireAbsoluteFilesystemPath } from "../resources/filesystem-paths.js";
import {
  readResource,
  readResourceByLocator,
  refreshResourceSearch,
  resourceLocatorKey,
} from "./resource-records.js";

export function relocateFilesystemResource(
  database: ContextDatabase,
  input: {
    resourceId: string;
    sourcePath: string;
    destinationPath: string;
    afterVersion: ResourceVersion;
    runId: string;
    at: string;
  },
): ResourceRef {
  const source = filesystemLocator(input.sourcePath);
  const destination = filesystemLocator(input.destinationPath);
  const current = readResource(database, input.resourceId);
  if (!current) {
    throw new ContextEngineServiceError({
      code: "RESOURCE_NOT_FOUND",
      message: "Resource does not exist.",
      details: { resourceId: input.resourceId },
    });
  }
  if (current.locator.kind !== "filesystem") {
    throw new ContextEngineServiceError({
      code: "RESOURCE_CONFLICT",
      message: "Only filesystem resources can be relocated by a filesystem move.",
      details: { resourceId: input.resourceId },
    });
  }
  if (current.locator.path === destination.path) return current;
  if (current.locator.path !== source.path) {
    throw new ContextEngineServiceError({
      code: "RESOURCE_CONFLICT",
      message: "Move source no longer matches the resource's authoritative locator.",
      details: {
        resourceId: input.resourceId,
        expectedSource: current.locator.path,
        actualSource: source.path,
      },
    });
  }
  const destinationOwner = readResourceByLocator(database, destination);
  if (destinationOwner && destinationOwner.resourceId !== input.resourceId) {
    throw new ContextEngineServiceError({
      code: "RESOURCE_CONFLICT",
      message: "Move destination is already owned by another durable resource.",
      details: {
        resourceId: input.resourceId,
        destinationResourceId: destinationOwner.resourceId,
        destinationPath: destination.path,
      },
    });
  }

  const storedMetadata = readStoredMetadata(database, input.resourceId);
  const formerLocators = uniqueLocators([
    ...(current.formerLocators ?? []),
    source,
  ]);
  const fallback = fallbackMetadata(
    current.kind,
    basename(destination.path) || destination.path,
    destination,
  );
  const aliases = normalizeAliases([
    ...current.aliases,
    ...fallback.aliases,
    basename(source.path),
    basename(source.path).replace(/\.[^.]+$/, ""),
  ]);
  const useFallback = current.metadataStatus === "fallback";
  const describedVersionKey = current.metadataStatus === "enriched"
    ? input.afterVersion.key
    : current.describedVersionKey ?? null;
  database.prepare([
    "UPDATE resources SET locator_kind = 'filesystem', locator_key = ?, locator_json = ?,",
    "display_name = ?, description = ?, aliases_json = ?, described_version_key = ?,",
    "current_version_key = ?, current_version_json = ?, availability = ?,",
    "size_bytes = ?, content_hash = ?, metadata_json = ?, last_verified_run_id = ?,",
    "last_verified_at = ?, updated_at = ? WHERE resource_id = ?",
  ].join(" ")).run(
    resourceLocatorKey(destination),
    JSON.stringify(destination),
    useFallback ? basename(destination.path) || destination.path : current.displayName,
    useFallback ? fallback.description : current.description,
    JSON.stringify(aliases),
    describedVersionKey,
    input.afterVersion.key,
    JSON.stringify(input.afterVersion),
    input.afterVersion.exists ? "available" : "missing",
    input.afterVersion.sizeBytes ?? null,
    input.afterVersion.sha256 ?? null,
    JSON.stringify({ ...storedMetadata, formerLocators }),
    input.runId,
    input.at,
    input.at,
    input.resourceId,
  );
  refreshResourceSearch(database, input.resourceId);
  const relocated = readResource(database, input.resourceId);
  if (!relocated) {
    throw new Error("Resource could not be read after relocation: " + input.resourceId);
  }
  return relocated;
}

function filesystemLocator(path: string): { kind: "filesystem"; path: string } {
  return {
    kind: "filesystem",
    path: requireAbsoluteFilesystemPath(path),
  };
}

function readStoredMetadata(
  database: ContextDatabase,
  resourceId: string,
): Record<string, unknown> {
  const row = database.prepare(
    "SELECT metadata_json FROM resources WHERE resource_id = ?",
  ).get(resourceId) as { metadata_json: string } | undefined;
  if (!row) return {};
  const value = JSON.parse(row.metadata_json) as unknown;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function uniqueLocators(values: ResourcePublicLocator[]): ResourcePublicLocator[] {
  const seen = new Set<string>();
  const output: ResourcePublicLocator[] = [];
  for (const locator of values) {
    const key = resourceLocatorKey(locator);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(structuredClone(locator));
  }
  return output;
}

function fallbackMetadata(
  kind: ResourceRef["kind"],
  displayName: string,
  locator: { kind: "filesystem"; path: string },
): { description: string; aliases: string[] } {
  const fileName = basename(locator.path);
  return {
    description: kind.replaceAll("_", " ") + " resource "
      + displayName + " at " + locator.path,
    aliases: normalizeAliases([
      displayName,
      fileName,
      fileName.replace(/\.[^.]+$/, ""),
    ]),
  };
}

function normalizeAliases(values: string[]): string[] {
  return [...new Set(values
    .map((value) => value.trim().replace(/\s+/g, " "))
    .filter((value) => value.length > 0 && value.length <= 500))]
    .sort((left, right) => left.localeCompare(right));
}
