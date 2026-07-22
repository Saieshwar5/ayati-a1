import { afterEach, describe, expect, it } from "vitest";
import { runRuntimePerformanceBenchmarks } from "../../src/benchmarks/runtime-performance-runner.js";

const originalValue = process.env["AYATI_LIVE_EVALUATION"];

afterEach(() => {
  if (originalValue === undefined) delete process.env["AYATI_LIVE_EVALUATION"];
  else process.env["AYATI_LIVE_EVALUATION"] = originalValue;
});

describe("runtime diagnostic isolation", () => {
  it("refuses to perturb a live evaluation daemon", async () => {
    process.env["AYATI_LIVE_EVALUATION"] = "1";
    await expect(runRuntimePerformanceBenchmarks({ scale: "smoke" })).rejects.toThrow(
      /cannot run during live agent evaluation/,
    );
  });
});
