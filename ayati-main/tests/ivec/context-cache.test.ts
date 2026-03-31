import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  getContextCacheEntriesByIds,
  getContextCachePath,
  listContextCacheMetadata,
  storeContextCache,
} from "../../src/ivec/context-cache.js";

describe("context-cache", () => {
  let tmpRoot = "";

  function makeFixture(): { runPath: string } {
    tmpRoot = mkdtempSync(join(tmpdir(), "ayati-context-cache-"));
    const runPath = join(tmpRoot, "runs", "run-1");
    mkdirSync(runPath, { recursive: true });
    return { runPath };
  }

  function cleanup(): void {
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  }

  it("stores the simplified cache entry schema", () => {
    const { runPath } = makeFixture();
    try {
      const entry = storeContextCache(runPath, {
        scope: "skills",
        query: "Read github-cli auth commands",
        result: {
          context: "Use gh auth status to verify login.",
          sources: ["data/skills/github-cli/skill.md"],
          confidence: 0.94,
        },
      });

      expect(entry.id).toBeTruthy();
      expect(entry.scope).toBe("skills");
      expect(entry.status).toBe("success");
      expect(entry.query).toBe("Read github-cli auth commands");

      const cacheFile = JSON.parse(readFileSync(getContextCachePath(runPath), "utf-8")) as {
        version: number;
        entries: Array<Record<string, unknown>>;
      };

      expect(cacheFile.version).toBe(3);
      expect(cacheFile.entries).toHaveLength(1);
      expect(cacheFile.entries[0]).toMatchObject({
        id: entry.id,
        scope: "skills",
        status: "success",
        query: "Read github-cli auth commands",
        context: "Use gh auth status to verify login.",
        sources: ["data/skills/github-cli/skill.md"],
        confidence: 0.94,
      });
      expect(cacheFile.entries[0]).not.toHaveProperty("targets");
    } finally {
      cleanup();
    }
  });

  it("keeps negative scout summaries marked as empty", () => {
    const { runPath } = makeFixture();
    try {
      const entry = storeContextCache(runPath, {
        scope: "skills",
        query: "Read pulse schedule syntax",
        result: {
          context: [
            "Context search status: max_turns_exhausted",
            "Scope: skills",
            "Query: Read pulse schedule syntax",
          ].join("\n"),
          sources: ["data/skills"],
          confidence: 0,
          scoutState: {
            status: "max_turns_exhausted",
            scope: "skills",
            query: "Read pulse schedule syntax",
            searchedLocations: ["data/skills"],
            attemptedSearches: ["list_directory path=data/skills"],
            errors: [],
          },
        },
      });

      expect(entry.status).toBe("empty");
      expect(entry.context).toContain("max_turns_exhausted");
    } finally {
      cleanup();
    }
  });

  it("returns cache metadata filtered by scope", () => {
    const { runPath } = makeFixture();
    try {
      const skillEntry = storeContextCache(runPath, {
        scope: "skills",
        query: "Read github-cli auth commands",
        result: {
          context: "Use gh auth status to verify login.",
          sources: ["data/skills/github-cli/skill.md"],
          confidence: 0.94,
        },
      });
      storeContextCache(runPath, {
        scope: "run_artifacts",
        query: "Review step 2 verify output",
        result: {
          context: "Step 2 failed because the path was missing.",
          sources: ["data/runs/run-1/steps/002-verify.md"],
          confidence: 0.81,
        },
      });

      const metadata = listContextCacheMetadata(runPath, "skills");

      expect(metadata).toEqual([
        {
          id: skillEntry.id,
          scope: "skills",
          status: "success",
          query: "Read github-cli auth commands",
          confidence: 0.94,
        },
      ]);
    } finally {
      cleanup();
    }
  });

  it("reads only the selected cache entries by id in the requested order", () => {
    const { runPath } = makeFixture();
    try {
      const first = storeContextCache(runPath, {
        scope: "skills",
        query: "Read github-cli auth commands",
        result: {
          context: "Use gh auth status to verify login.",
          sources: ["data/skills/github-cli/skill.md"],
          confidence: 0.94,
        },
      });
      const second = storeContextCache(runPath, {
        scope: "skills",
        query: "Read github-cli repo listing commands",
        result: {
          context: "Use gh repo list <owner> --limit 100.",
          sources: ["data/skills/github-cli/skill.md"],
          confidence: 0.9,
        },
      });

      const selected = getContextCacheEntriesByIds(runPath, [second.id, first.id]);

      expect(selected.map((entry) => entry.id)).toEqual([second.id, first.id]);
      expect(selected[0]?.context).toContain("gh repo list");
      expect(selected[1]?.context).toContain("gh auth status");
    } finally {
      cleanup();
    }
  });

  it("migrates legacy version 2 cache files into the new simplified shape", () => {
    const { runPath } = makeFixture();
    try {
      writeFileSync(
        getContextCachePath(runPath),
        JSON.stringify({
          version: 2,
          entries: [
            {
              scope: "run_artifacts",
              targets: ["run_artifacts:step:2"],
              context: "Step 2 failed because the tool output was incomplete.",
              sources: ["data/runs/run-1/steps/002-verify.md"],
              confidence: 0.88,
              status: "success",
              createdAtIteration: 3,
              lastUsedIteration: 4,
            },
          ],
        }, null, 2),
        "utf-8",
      );

      const metadata = listContextCacheMetadata(runPath, "run_artifacts");
      const selected = getContextCacheEntriesByIds(runPath, [metadata[0]!.id]);

      expect(metadata).toHaveLength(1);
      expect(metadata[0]?.scope).toBe("run_artifacts");
      expect(metadata[0]?.status).toBe("success");
      expect(selected[0]?.context).toContain("tool output was incomplete");
      expect(selected[0]?.query).toContain("run_artifacts:step:2");
    } finally {
      cleanup();
    }
  });
});
