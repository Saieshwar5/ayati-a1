import { describe, expect, it } from "vitest";
import {
  parseAyatiCommitTrailers,
  renderAyatiCommitMessage,
} from "../../../src/context-engine/daily-session/index.js";

describe("daily session commit messages", () => {
  it("renders run checkpoints as compact memory plus machine trailers", () => {
    const message = renderAyatiCommitMessage({
      subject: "complete run R-20260627-0001 for W-20260627-0001",
      summary: "Read the attached contract file and extracted the key payment and termination terms.",
      completed: ["Read contract.pdf", "Extracted payment terms"],
      open: ["Write final summary"],
      trailers: {
        sessionId: "2026-06-27",
        workId: "W-20260627-0001",
        runId: "R-20260627-0001",
        status: "active",
        event: "run_completed",
        extras: {
          "Ayati-Actions": "action-0001,action-0002",
        },
      },
    });

    expect(message).toContain("Completed:\n- Read contract.pdf\n- Extracted payment terms");
    expect(message).toContain("Ayati-Session: 2026-06-27");
    expect(message).toContain("Ayati-Work: W-20260627-0001");
    expect(message).toContain("Ayati-Run: R-20260627-0001");
    expect(message).toContain("Ayati-Actions: action-0001,action-0002");
  });

  it("parses Ayati trailers from rendered commit messages", () => {
    const parsed = parseAyatiCommitTrailers(`complete run

Ayati-Session: 2026-06-27
Ayati-Work: W-20260627-0001
Ayati-Run: R-20260627-0001
Ayati-Status: active
Ayati-Event: run_completed
Ayati-Actions: action-0001
Ayati-Actions: action-0002
`);

    expect(parsed).toMatchObject({
      sessionId: "2026-06-27",
      workId: "W-20260627-0001",
      runId: "R-20260627-0001",
      status: "active",
      event: "run_completed",
    });
    expect(parsed.raw["Ayati-Actions"]).toEqual(["action-0001", "action-0002"]);
  });
});
