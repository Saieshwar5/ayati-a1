import { describe, expect, it } from "vitest";
import {
  hasDoctorFailures,
  renderDoctorReport,
  summarizeDoctorReport,
  type DoctorReport,
} from "../../src/app/doctor.js";

function makeReport(): DoctorReport {
  return {
    projectRoot: "/tmp/ayati-main",
    generatedAt: "2026-06-07T00:00:00.000Z",
    sections: [
      {
        title: "Runtime",
        checks: [
          { label: "node", status: "ok", detail: "v26.2.0" },
          { label: "xlsx", status: "ok", detail: "/node_modules/xlsx" },
        ],
      },
      {
        title: "Document Extractors",
        checks: [
          { label: "pandoc", status: "warn", detail: "missing" },
          { label: "tika", status: "fail", detail: "missing" },
        ],
      },
    ],
  };
}

describe("doctor report", () => {
  it("summarizes status counts", () => {
    expect(summarizeDoctorReport(makeReport())).toEqual({
      ok: 2,
      warn: 1,
      fail: 1,
    });
  });

  it("detects failures", () => {
    expect(hasDoctorFailures(makeReport())).toBe(true);
  });

  it("renders a readable sectioned report", () => {
    const output = renderDoctorReport(makeReport());

    expect(output).toContain("Ayati Doctor");
    expect(output).toContain("Project: /tmp/ayati-main");
    expect(output).toContain("Runtime");
    expect(output).toContain("- [OK] node: v26.2.0");
    expect(output).toContain("- [WARN] pandoc: missing");
    expect(output).toContain("Summary: 2 ok, 1 warn, 1 fail");
  });
});
