import { describe, expect, it } from "vitest";
import type { RecentFileMetadata } from "ayati-context-engine";
import {
  buildRecentDocumentViews,
  MAX_ACTIVE_DOCUMENTS,
  MAX_HOT_RECENT_DOCUMENTS,
  MAX_RECENT_DOCUMENTS,
} from "../../src/ivec/recent-document-registry.js";

describe("recent document registry", () => {
  it("projects one bounded registry as five active pointers and 27 hot records", () => {
    const files = Array.from(
      { length: MAX_RECENT_DOCUMENTS + 2 },
      (_, index) => recentFile(index + 1),
    );

    const views = buildRecentDocumentViews(files);

    expect(views.active).toHaveLength(MAX_ACTIVE_DOCUMENTS);
    expect(views.hot).toHaveLength(MAX_HOT_RECENT_DOCUMENTS);
    expect(views.active.map((file) => file.path)).toEqual(
      files.slice(0, MAX_ACTIVE_DOCUMENTS).map((file) => file.path),
    );
    expect(views.hot.map((file) => file.path)).toEqual(
      files.slice(MAX_ACTIVE_DOCUMENTS, MAX_RECENT_DOCUMENTS)
        .map((file) => file.path),
    );
    expect(new Set([
      ...views.active.map((file) => file.path),
      ...views.hot.map((file) => file.path),
    ]).size).toBe(MAX_RECENT_DOCUMENTS);
  });

  it("keeps active pointers small and marks their current freshness unchecked", () => {
    const views = buildRecentDocumentViews([recentFile(1), recentFile(1)]);

    expect(views.active).toEqual([{
      name: "file-1.txt",
      path: "/workspace/docs/file-1.txt",
      lastReadAt: "2026-07-26T10:01:00.000Z",
      evidenceRef: "run:RUN-1:step:1:call:read-1",
      freshness: "unchecked",
      requestSeq: 1,
      responseSeq: 2,
    }]);
    expect(views.active[0]).not.toHaveProperty("sha256");
    expect(views.active[0]).not.toHaveProperty("sizeBytes");
    expect(views.active[0]).not.toHaveProperty("lineCount");
    expect(views.hot).toEqual([]);
  });
});

function recentFile(index: number): RecentFileMetadata {
  return {
    name: `file-${index}.txt`,
    path: `/workspace/docs/file-${index}.txt`,
    lastReadAt: `2026-07-26T10:${String(index).padStart(2, "0")}:00.000Z`,
    evidenceRef: `run:RUN-${index}:step:1:call:read-${index}`,
    coverage: "complete",
    status: "navigation_only",
    requestSeq: index,
    responseSeq: index + 1,
    sizeBytes: index * 10,
    lineCount: index,
    sha256: `sha256-${index}`,
  };
}
