import { getChatArtifactUrl } from "@/lib/chat/config";
import type { ChatArtifact } from "@/lib/chat/types";

interface MessageArtifactsProps {
  artifacts: ChatArtifact[];
}

const FILE_SIZE_FORMATTER = new Intl.NumberFormat("en", {
  maximumFractionDigits: 1,
});

export function MessageArtifacts({ artifacts }: MessageArtifactsProps) {
  if (artifacts.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {artifacts.map((artifact) => {
        const artifactUrl = getChatArtifactUrl(artifact.urlPath);
        return (
          <a
            key={`${artifact.urlPath}:${artifact.name}`}
            className="group overflow-hidden rounded-2xl border border-black/8 bg-white/70 shadow-sm shadow-slate-950/5 transition hover:border-[color:var(--app-accent-soft)]"
            href={artifactUrl}
            rel="noreferrer noopener"
            target="_blank"
          >
            <img
              alt={artifact.name}
              className="h-52 w-full bg-slate-100 object-cover"
              loading="lazy"
              src={artifactUrl}
            />
            <div className="space-y-1 px-3 py-2">
              <div className="line-clamp-1 text-sm font-medium text-[color:var(--app-foreground)] group-hover:text-[color:var(--app-accent)]">
                {artifact.name}
              </div>
              <div className="text-xs text-[color:var(--app-muted)]">
                {formatArtifactMeta(artifact)}
              </div>
            </div>
          </a>
        );
      })}
    </div>
  );
}

function formatArtifactMeta(artifact: ChatArtifact): string {
  const parts = [artifact.mimeType ?? "image"];
  if (typeof artifact.sizeBytes === "number" && Number.isFinite(artifact.sizeBytes)) {
    parts.push(formatFileSize(artifact.sizeBytes));
  }
  return parts.join(" • ");
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${FILE_SIZE_FORMATTER.format(sizeBytes / 1024)} KB`;
  }
  return `${FILE_SIZE_FORMATTER.format(sizeBytes / (1024 * 1024))} MB`;
}
