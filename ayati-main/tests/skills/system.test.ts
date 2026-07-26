import { describe, expect, it } from "vitest";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import {
  createSystemSkill,
  type SystemHealthRawSample,
} from "../../src/skills/builtins/system/index.js";

const FIXED_NOW = new Date("2026-01-15T12:00:00.000Z");

describe("system observation tools", () => {
  it("returns a deterministic timezone-aware time snapshot", async () => {
    const skill = createSystemSkill({
      defaultTimezone: "Asia/Kolkata",
      healthRoot: "/tmp",
      now: () => FIXED_NOW,
      healthSample: async () => healthySample(),
    });
    const executor = createToolExecutor(skill.tools);

    const result = await executor.execute("system_time", {
      timezone: "America/New_York",
    });

    expect(result.ok).toBe(true);
    expect(result.v2?.structuredContent).toEqual({
      scope: "timezone:America/New_York",
      observedAtUtc: "2026-01-15T12:00:00.000Z",
      epochMs: FIXED_NOW.getTime(),
      timezone: "America/New_York",
      utcOffsetMinutes: -300,
      utcOffset: "-05:00",
      localDate: "2026-01-15",
      localTime: "07:00:00",
      weekday: "thursday",
    });
    expect(result.v2?.verification).toEqual(expect.objectContaining({
      status: "passed",
      facts: expect.arrayContaining([expect.objectContaining({
        kind: "system_time_observed",
        path: "timezone:America/New_York",
      })]),
    }));
  });

  it("uses the configured timezone and rejects invalid timezone input", async () => {
    const skill = createSystemSkill({
      defaultTimezone: "Asia/Kolkata",
      healthRoot: "/tmp",
      now: () => FIXED_NOW,
      healthSample: async () => healthySample(),
    });
    const time = skill.tools.find((tool) => tool.name === "system_time");
    if (!time) throw new Error("Missing system_time fixture.");

    const configured = await time.execute({});
    expect(configured.v2?.structuredContent).toMatchObject({
      timezone: "Asia/Kolkata",
      localTime: "17:30:00",
      utcOffset: "+05:30",
    });

    const invalid = await time.execute({ timezone: "Not/A_Timezone" });
    expect(invalid).toMatchObject({
      ok: false,
      v2: {
        code: "SYSTEM_TIME_INVALID_TIMEZONE",
        error: {
          category: "validation",
          retryable: true,
        },
      },
    });
  });

  it("returns a bounded healthy machine snapshot with verified evidence", async () => {
    const skill = createSystemSkill({
      defaultTimezone: "UTC",
      healthRoot: "/private/ayati/root",
      healthSample: async (healthRoot) => {
        expect(healthRoot).toBe("/private/ayati/root");
        return healthySample();
      },
    });
    const executor = createToolExecutor(skill.tools);

    const result = await executor.execute("system_health", {});
    const output = result.v2?.structuredContent as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(output).toMatchObject({
      scope: "local-machine",
      sampledAtUtc: FIXED_NOW.toISOString(),
      status: "healthy",
      platform: "linux",
      architecture: "x64",
      systemUptimeSeconds: 3600,
      cpu: {
        status: "healthy",
        logicalCores: 8,
        normalizedLoad1m: 0.5,
      },
      memory: {
        status: "healthy",
        totalBytes: 1_000,
        availableBytes: 600,
        usedBytes: 400,
        usedPercent: 40,
      },
      disk: {
        scope: "ayati-root-volume",
        status: "healthy",
        totalBytes: 2_000,
        availableBytes: 1_000,
        usedBytes: 1_000,
        usedPercent: 50,
      },
      signals: [],
    });
    expect(JSON.stringify(output)).not.toContain("/private/ayati/root");
    expect(output).not.toHaveProperty("hostname");
    expect(output).not.toHaveProperty("environment");
    expect(result.v2?.verification).toEqual(expect.objectContaining({
      status: "passed",
      facts: expect.arrayContaining([expect.objectContaining({
        kind: "system_health_observed",
        path: "local-machine",
      })]),
    }));
  });

  it("reports critical measurements and unavailable disk data without throwing", async () => {
    const critical = createSystemSkill({
      defaultTimezone: "UTC",
      healthRoot: "/tmp",
      healthSample: async () => ({
        ...healthySample(),
        logicalCores: 4,
        loadAverage: [8, 4, 2],
        totalMemoryBytes: 1_000,
        availableMemoryBytes: 40,
        disk: {
          totalBytes: 2_000,
          availableBytes: 80,
        },
      }),
    });
    const criticalExecutor = createToolExecutor(critical.tools);
    const criticalResult = await criticalExecutor.execute(
      "system_health",
      {},
    );
    expect(criticalResult.v2?.structuredContent).toMatchObject({
      status: "critical",
      cpu: { status: "critical", normalizedLoad1m: 2 },
      memory: { status: "critical", usedPercent: 96 },
      disk: { status: "critical", usedPercent: 96 },
      signals: [
        { code: "cpu_critical", severity: "error" },
        { code: "memory_critical", severity: "error" },
        { code: "disk_critical", severity: "error" },
      ],
    });

    const partial = createSystemSkill({
      defaultTimezone: "UTC",
      healthRoot: "/tmp",
      healthSample: async () => {
        const sample = healthySample();
        delete sample.disk;
        sample.diskUnavailableReason = "filesystem_stats_unavailable";
        return sample;
      },
    });
    const partialExecutor = createToolExecutor(partial.tools);
    const partialResult = await partialExecutor.execute("system_health", {});
    expect(partialResult.v2?.structuredContent).toMatchObject({
      status: "unknown",
      disk: {
        status: "unknown",
        scope: "ayati-root-volume",
        reason: "filesystem_stats_unavailable",
      },
      signals: [{
        code: "disk_unknown",
        severity: "warning",
      }],
    });
  });

  it("does not accept caller-selected health paths or other inspection input", async () => {
    const skill = createSystemSkill({
      defaultTimezone: "UTC",
      healthRoot: "/tmp",
      healthSample: async () => healthySample(),
    });
    const health = skill.tools.find((tool) => tool.name === "system_health");
    if (!health) throw new Error("Missing system_health fixture.");

    const result = await health.execute({ path: "/" });
    expect(result).toMatchObject({
      ok: false,
      v2: {
        code: "SYSTEM_HEALTH_INPUT_INVALID",
        error: { category: "validation" },
      },
    });
  });
});

function healthySample(): SystemHealthRawSample {
  return {
    sampledAt: FIXED_NOW,
    platform: "linux",
    architecture: "x64",
    logicalCores: 8,
    loadAverage: [4, 3, 2],
    totalMemoryBytes: 1_000,
    availableMemoryBytes: 600,
    systemUptimeSeconds: 3_600,
    processUptimeSeconds: 120,
    processMemory: {
      rssBytes: 200,
      heapUsedBytes: 100,
      heapTotalBytes: 150,
      externalBytes: 20,
    },
    disk: {
      totalBytes: 2_000,
      availableBytes: 1_000,
    },
  };
}
