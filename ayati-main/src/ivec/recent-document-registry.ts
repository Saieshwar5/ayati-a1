import {
  RECENT_DOCUMENT_REGISTRY_MAX_FILES,
  type RecentFileMetadata,
} from "ayati-context-engine";

export const MAX_RECENT_DOCUMENTS = RECENT_DOCUMENT_REGISTRY_MAX_FILES;
export const MAX_ACTIVE_DOCUMENTS = 5;
export const MAX_HOT_RECENT_DOCUMENTS =
  MAX_RECENT_DOCUMENTS - MAX_ACTIVE_DOCUMENTS;

export interface ActiveDocumentPointer {
  name: string;
  path: string;
  lastReadAt: string;
  evidenceRef: string;
  freshness: "unchecked";
  requestSeq?: number;
  responseSeq?: number;
}

export interface RecentDocumentViews {
  active: ActiveDocumentPointer[];
  hot: RecentFileMetadata[];
}

/**
 * Splits one ordered recent-document registry into two non-overlapping views.
 * The first five lightweight pointers are always visible. Older metadata is
 * available through files.recent and is mounted only when requested.
 */
export function buildRecentDocumentViews(
  files: RecentFileMetadata[],
): RecentDocumentViews {
  const registry = uniqueRecentDocuments(files).slice(0, MAX_RECENT_DOCUMENTS);
  return {
    active: registry
      .slice(0, MAX_ACTIVE_DOCUMENTS)
      .map(toActiveDocumentPointer),
    hot: registry.slice(MAX_ACTIVE_DOCUMENTS),
  };
}

export function activeDocumentPointers(
  files: RecentFileMetadata[],
): ActiveDocumentPointer[] {
  return buildRecentDocumentViews(files).active;
}

export function hotRecentDocuments(
  files: RecentFileMetadata[],
): RecentFileMetadata[] {
  return buildRecentDocumentViews(files).hot;
}

function uniqueRecentDocuments(
  files: RecentFileMetadata[],
): RecentFileMetadata[] {
  return [...new Map(files.map((file) => [file.path, file])).values()];
}

function toActiveDocumentPointer(
  file: RecentFileMetadata,
): ActiveDocumentPointer {
  return {
    name: file.name,
    path: file.path,
    lastReadAt: file.lastReadAt,
    evidenceRef: file.evidenceRef,
    freshness: "unchecked",
    ...(file.requestSeq !== undefined ? { requestSeq: file.requestSeq } : {}),
    ...(file.responseSeq !== undefined ? { responseSeq: file.responseSeq } : {}),
  };
}
