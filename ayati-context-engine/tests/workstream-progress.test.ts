import { describe, expect, it } from "vitest";
import type { RunOutcome } from "../src/contracts.js";
import { ContextEngineServiceError } from "../src/errors.js";
import {
  appendWorkstreamProgressEntry,
  parseWorkstreamProgress,
  renderWorkstreamProgress,
  renderWorkstreamProgressEntry,
  WORKSTREAM_PROGRESS_LIMITS,
  type WorkstreamProgressEntry,
} from "../src/workstreams/workstream-progress.js";

describe("workstream progress", () => {
  it("renders and parses one canonical finalized-run entry", () => {
    const value = entry();
    const rendered = renderWorkstreamProgress([value]);

    expect(rendered).toBe([
      "# Progress",
      "",
      "## RUN-9054007D-0000000001 — 2026-07-28T12:30:00+05:30",
      "",
      "Request: R-0001",
      "Outcome: incomplete",
      "",
      "### Summary",
      "",
      "Created and verified the initial website files.",
      "",
      "### Work completed",
      "",
      "- Created index.html.",
      "",
      "### Verified mutations",
      "",
      "- Created RES-123 at /workspace/index.html.",
      "",
      "### Validation",
      "",
      "- File hash verification passed.",
      "",
      "### Findings and decisions",
      "",
      "- No build system is required.",
      "",
      "### Problems",
      "",
      "None.",
      "",
      "### Next",
      "",
      "Validate the website in a browser.",
      "",
    ].join("\n"));
    expect(parseWorkstreamProgress(rendered)).toEqual([value]);
    expect(renderWorkstreamProgress(parseWorkstreamProgress(rendered))).toBe(rendered);
  });

  it("supports every finalized run outcome, including an empty no-change entry", () => {
    const outcomes: RunOutcome[] = [
      "done",
      "incomplete",
      "failed",
      "blocked",
      "needs_user_input",
    ];
    const entries = outcomes.map((outcome, index) => entry({
      runId: runId(index + 1),
      outcome,
      workCompleted: [],
      verifiedMutations: [],
      validation: [],
      findingsAndDecisions: [],
      problems: [],
      next: undefined,
    }));

    const rendered = renderWorkstreamProgress(entries);

    expect(parseWorkstreamProgress(rendered).map((item) => item.outcome)).toEqual(outcomes);
    expect(rendered.match(/^## RUN-/gm)).toHaveLength(outcomes.length);
    expect(rendered.match(/^None\.$/gm)).toHaveLength(outcomes.length * 6);
  });

  it("appends without changing existing bytes and rejects a duplicate run", () => {
    const first = renderWorkstreamProgress([entry()]);
    const second = entry({
      runId: runId(2),
      requestId: "R-0002",
      outcome: "done",
      summary: "Completed the second request.",
    });

    const appended = appendWorkstreamProgressEntry(first, second);

    expect(appended.slice(0, first.length)).toBe(first);
    expect(parseWorkstreamProgress(appended)).toEqual([entry(), second]);
    expect(() => appendWorkstreamProgressEntry(appended, second)).toThrow(
      "already contains this run",
    );
    expect(() => parseWorkstreamProgress(
      first + "\n" + renderWorkstreamProgressEntry(entry()),
    )).toThrow("duplicate run ID");
  });

  it("deduplicates and deterministically bounds list items", () => {
    const verifiedMutations = [
      "  First\nmutation  ",
      "First mutation",
      ...Array.from({ length: 21 }, (_, index) => "Mutation " + String(index + 1)),
    ];

    const parsed = parseWorkstreamProgress(renderWorkstreamProgress([
      entry({ verifiedMutations }),
    ]));

    expect(parsed[0]?.verifiedMutations).toHaveLength(
      WORKSTREAM_PROGRESS_LIMITS.maximumListItems,
    );
    expect(parsed[0]?.verifiedMutations[0]).toBe("First mutation");
    expect(parsed[0]?.verifiedMutations.at(-1)).toBe(
      "... 3 additional items omitted.",
    );
  });

  it("normalizes multiline text without allowing fake progress headings", () => {
    const summary = "## RUN-DEADBEEF-0000000099\n### Problems";
    const workCompleted = ["### Next\n## RUN-DEADBEEF-0000000098"];
    const rendered = renderWorkstreamProgress([
      entry({
        summary,
        workCompleted,
        next: "# Validate the result",
      }),
    ]);

    expect(rendered.match(/^## RUN-/gm)).toHaveLength(1);
    expect(rendered).toContain("\\## RUN-DEADBEEF-0000000099 ### Problems");
    expect(rendered).toContain("- ### Next ## RUN-DEADBEEF-0000000098");
    expect(rendered).toContain("\\# Validate the result");
    expect(parseWorkstreamProgress(rendered)[0]).toMatchObject({
      summary: "## RUN-DEADBEEF-0000000099 ### Problems",
      workCompleted: ["### Next ## RUN-DEADBEEF-0000000098"],
      next: "# Validate the result",
    });
  });

  it("preserves chronological order so callers can select recent request entries", () => {
    const rendered = renderWorkstreamProgress([
      entry({ runId: runId(1), requestId: "R-0001" }),
      entry({ runId: runId(2), requestId: "R-0002" }),
      entry({ runId: runId(3), requestId: "R-0001" }),
    ]);

    const recentForRequest = parseWorkstreamProgress(rendered)
      .filter((item) => item.requestId === "R-0001")
      .slice(-2);

    expect(recentForRequest.map((item) => item.runId)).toEqual([
      runId(1),
      runId(3),
    ]);
  });

  it.each([
    ["run ID", { runId: "RUN-1" }],
    ["request ID", { requestId: "R-1" }],
    ["timestamp", { at: "2026-07-28T12:30:00" }],
    ["outcome", { outcome: "completed" as RunOutcome }],
    ["summary", { summary: " " }],
    ["list item", { problems: ["x".repeat(WORKSTREAM_PROGRESS_LIMITS.itemChars + 1)] }],
  ])("rejects an invalid %s", (_name, override) => {
    expect(() => renderWorkstreamProgressEntry(entry(override))).toThrow(
      ContextEngineServiceError,
    );
  });

  it("rejects noncanonical or incomplete progress files", () => {
    const rendered = renderWorkstreamProgress([entry()]);

    expect(() => parseWorkstreamProgress(rendered.slice(0, -1))).toThrow(
      "must end with one newline",
    );
    expect(() => parseWorkstreamProgress(rendered.replace(
      "### Work completed",
      "### Completed work",
    ))).toThrow("required section order");
    expect(() => parseWorkstreamProgress("# Progress\r\n")).toThrow(
      "must use LF line endings",
    );
  });
});

function entry(
  override: Partial<WorkstreamProgressEntry> = {},
): WorkstreamProgressEntry {
  return {
    runId: runId(1),
    requestId: "R-0001",
    at: "2026-07-28T12:30:00+05:30",
    outcome: "incomplete",
    summary: "Created and verified the initial website files.",
    workCompleted: ["Created index.html."],
    verifiedMutations: ["Created RES-123 at /workspace/index.html."],
    validation: ["File hash verification passed."],
    findingsAndDecisions: ["No build system is required."],
    problems: [],
    next: "Validate the website in a browser.",
    ...override,
  };
}

function runId(sequence: number): string {
  return "RUN-9054007D-" + String(sequence).padStart(10, "0");
}
