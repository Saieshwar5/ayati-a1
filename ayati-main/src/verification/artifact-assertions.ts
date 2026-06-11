import type { ArtifactRef } from "./assertion-types.js";

export function fileArtifact(path: string, label?: string): ArtifactRef {
  return {
    kind: "file",
    path,
    ...(label ? { label } : {}),
  };
}

export function uniqueArtifacts(artifacts: ArtifactRef[]): ArtifactRef[] {
  const seen = new Set<string>();
  const out: ArtifactRef[] = [];
  for (const artifact of artifacts) {
    const key = `${artifact.kind}:${artifact.path ?? artifact.uri ?? artifact.id ?? artifact.label ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(artifact);
  }
  return out;
}

