import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AgentArtifact, StepSummary } from "./types.js";

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export function collectAgentArtifacts(
  runId: string,
  runPath: string,
  dataDir: string,
  completedSteps: StepSummary[],
): AgentArtifact[] {
  const seen = new Set<string>();
  const descriptors: AgentArtifact[] = [];

  for (const step of completedSteps) {
    for (const artifact of step.artifacts) {
      const normalized = normalizeArtifactPath(runId, artifact);
      if (!normalized) {
        continue;
      }

      const mimeType = detectImageMimeType(normalized.relativePath);
      if (!mimeType || seen.has(normalized.relativePath)) {
        continue;
      }

      seen.add(normalized.relativePath);
      const sizeBytes = readSizeBytes(resolveArtifactAbsolutePath(runPath, dataDir, runId, normalized));
      descriptors.push({
        kind: "image",
        name: basename(normalized.relativePath),
        relativePath: normalized.relativePath,
        urlPath: buildArtifactUrlPath(runId, normalized.relativePath),
        mimeType,
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      });
    }
  }

  return descriptors;
}

function normalizeArtifactPath(
  runId: string,
  artifactPath: string,
): { scope: "run" | "data"; relativePath: string } | null {
  const normalized = artifactPath.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!normalized) {
    return null;
  }

  const runPrefix = `runs/${runId}/`;
  if (normalized.startsWith(runPrefix)) {
    return {
      scope: "data",
      relativePath: normalized.slice(runPrefix.length),
    };
  }

  return {
    scope: "run",
    relativePath: normalized,
  };
}

function detectImageMimeType(relativePath: string): string | null {
  const lowerPath = relativePath.toLowerCase();
  const extension = lowerPath.slice(lowerPath.lastIndexOf("."));
  return IMAGE_MIME_BY_EXTENSION[extension] ?? null;
}

function buildArtifactUrlPath(runId: string, relativePath: string): string {
  const encodedRunId = encodeURIComponent(runId);
  const encodedPath = relativePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/api/artifacts/${encodedRunId}/${encodedPath}`;
}

function resolveArtifactAbsolutePath(
  runPath: string,
  dataDir: string,
  runId: string,
  artifact: { scope: "run" | "data"; relativePath: string },
): string {
  if (artifact.scope === "data") {
    return resolve(dataDir, "runs", runId, artifact.relativePath);
  }
  return resolve(runPath, artifact.relativePath);
}

function readSizeBytes(absolutePath: string): number | undefined {
  try {
    const stats = statSync(absolutePath);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}
