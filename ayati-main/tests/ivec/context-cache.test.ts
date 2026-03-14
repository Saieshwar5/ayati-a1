import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  getContextCachePath,
  lookupContextCache,
  storeContextCache,
} from "../../src/ivec/context-cache.js";
import type { ScoutKnownLocations } from "../../src/ivec/context-scout.js";

describe("context-cache", () => {
  let tmpRoot = "";

  function makeFixture(): { runPath: string; knownLocations: ScoutKnownLocations } {
    tmpRoot = mkdtempSync(join(tmpdir(), "ayati-context-cache-"));
    const runPath = join(tmpRoot, "runs", "run-1");
    const stepsDir = join(runPath, "steps");
    const skillsDir = join(tmpRoot, "skills");
    const contextDir = join(tmpRoot, "context");
    const sessionDir = join(tmpRoot, "sessions");
    const sessionPath = join(sessionDir, "session-1.jsonl");

    mkdirSync(stepsDir, { recursive: true });
    mkdirSync(join(skillsDir, "gws-gmail"), { recursive: true });
    mkdirSync(join(skillsDir, "gws-gmail-triage"), { recursive: true });
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    writeFileSync(join(skillsDir, "gws-gmail", "skill.md"), "# gws-gmail\n", "utf-8");
    writeFileSync(join(skillsDir, "gws-gmail-triage", "skill.md"), "# gws-gmail-triage\n", "utf-8");
    writeFileSync(join(stepsDir, "002-act.md"), "# Act\n", "utf-8");
    writeFileSync(join(stepsDir, "002-verify.md"), "# Verify\n", "utf-8");
    writeFileSync(join(contextDir, "system_prompt.md"), "# Prompt\n", "utf-8");
    writeFileSync(sessionPath, "{\"role\":\"user\",\"content\":\"hi\"}\n", "utf-8");

    return {
      runPath,
      knownLocations: {
        runPath,
        contextDir,
        sessionDir,
        sessionPath,
        skillsDir,
        runId: "run-1",
        activeSessionId: "session-1",
      },
    };
  }

  function cleanup(): void {
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  }

  it("reuses cached skill lookups across different query wording", () => {
    const { runPath, knownLocations } = makeFixture();
    try {
      storeContextCache(runPath, {
        scope: "skills",
        query: "Load the full command reference for the installed Gmail skills",
        knownLocations,
        iteration: 1,
        result: {
          context: "Use gws-gmail-triage for read-only inbox summaries.",
          sources: [
            join(knownLocations.skillsDir!, "gws-gmail", "skill.md"),
            join(knownLocations.skillsDir!, "gws-gmail-triage", "skill.md"),
          ],
          confidence: 0.92,
        },
      });

      const hit = lookupContextCache(runPath, {
        scope: "skills",
        query: "Need the Gmail skill command reference again before using triage",
        knownLocations,
        iteration: 2,
      });

      expect(hit).not.toBeNull();
      expect(hit?.targets).toEqual(["skills:gws-gmail", "skills:gws-gmail-triage"]);
      expect(hit?.context).toContain("read-only inbox summaries");

      const cacheFile = JSON.parse(readFileSync(getContextCachePath(runPath), "utf-8")) as {
        entries: Array<{ lastUsedIteration: number }>;
      };
      expect(cacheFile.entries[0]?.lastUsedIteration).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("reuses cached run artifact lookups by step identity", () => {
    const { runPath, knownLocations } = makeFixture();
    try {
      storeContextCache(runPath, {
        scope: "run_artifacts",
        query: "Read step 2 act and verify files",
        knownLocations,
        iteration: 3,
        result: {
          context: "Step 2 failed because the tool output was incomplete.",
          sources: [
            join(runPath, "steps", "002-act.md"),
            join(runPath, "steps", "002-verify.md"),
          ],
          confidence: 0.88,
        },
      });

      const hit = lookupContextCache(runPath, {
        scope: "run_artifacts",
        query: "What happened in step 2?",
        knownLocations,
        iteration: 4,
      });

      expect(hit).not.toBeNull();
      expect(hit?.targets).toContain("run_artifacts:step:2");
      expect(hit?.context).toContain("tool output was incomplete");
    } finally {
      cleanup();
    }
  });

  it("reuses empty cached results so missing context is not searched repeatedly", () => {
    const { runPath, knownLocations } = makeFixture();
    try {
      storeContextCache(runPath, {
        scope: "session",
        query: "Read the current session log",
        knownLocations,
        iteration: 5,
        result: {
          context: "",
          sources: [knownLocations.sessionPath!],
          confidence: 0.1,
        },
      });

      const hit = lookupContextCache(runPath, {
        scope: "session",
        query: "Read the active session log again",
        knownLocations,
        iteration: 6,
      });

      expect(hit).not.toBeNull();
      expect(hit?.status).toBe("empty");
      expect(hit?.context).toBe("");
    } finally {
      cleanup();
    }
  });

  it("misses when the requested target is different", () => {
    const { runPath, knownLocations } = makeFixture();
    try {
      storeContextCache(runPath, {
        scope: "run_artifacts",
        query: "Read step 2 act and verify files",
        knownLocations,
        iteration: 7,
        result: {
          context: "Step 2 context",
          sources: [join(runPath, "steps", "002-act.md")],
          confidence: 0.8,
        },
      });

      const miss = lookupContextCache(runPath, {
        scope: "run_artifacts",
        query: "What happened in step 3?",
        knownLocations,
        iteration: 8,
      });

      expect(miss).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("keeps document cache entries query-aware for the same attachment", () => {
    const { runPath, knownLocations } = makeFixture();
    const documentPath = join(tmpRoot, "docs", "policy.txt");

    try {
      mkdirSync(join(tmpRoot, "docs"), { recursive: true });
      writeFileSync(documentPath, "Termination requires 30 days written notice.", "utf-8");

      knownLocations.attachedDocuments = [
        {
          documentId: "doc-policy",
          name: "policy.txt",
          originalPath: documentPath,
          storedPath: documentPath,
          kind: "txt",
          sizeBytes: 41,
          checksum: "abc123",
        },
      ];

      storeContextCache(runPath, {
        scope: "documents",
        query: "What is the termination clause?",
        knownLocations,
        iteration: 9,
        documentPaths: [documentPath],
        result: {
          context: "Termination requires 30 days written notice.",
          sources: [documentPath],
          confidence: 0.93,
        },
      });

      const hit = lookupContextCache(runPath, {
        scope: "documents",
        query: "What is the termination clause?",
        knownLocations,
        iteration: 10,
        documentPaths: [documentPath],
      });

      const miss = lookupContextCache(runPath, {
        scope: "documents",
        query: "Who signed the agreement?",
        knownLocations,
        iteration: 11,
        documentPaths: [documentPath],
      });

      expect(hit).not.toBeNull();
      expect(hit?.targets).toContain("documents:doc:doc-policy");
      expect(hit?.context).toContain("30 days written notice");
      expect(miss).toBeNull();
    } finally {
      cleanup();
    }
  });

});
