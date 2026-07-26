import { statfs } from "node:fs/promises";
import {
  arch,
  cpus,
  freemem,
  loadavg,
  platform,
  totalmem,
  uptime,
} from "node:os";
import type {
  SkillDefinition,
  ToolDefinition,
  ToolResult,
} from "../../types.js";
import {
  commonAnnotations,
  errorResult,
  okJsonResult,
  succeededContract,
} from "../contract-helpers.js";

type SystemHealthStatus = "healthy" | "degraded" | "critical" | "unknown";

interface DiskSpaceSample {
  totalBytes: number;
  availableBytes: number;
}

export interface SystemHealthRawSample {
  sampledAt: Date;
  platform: string;
  architecture: string;
  logicalCores: number;
  loadAverage: [number, number, number];
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  systemUptimeSeconds: number;
  processUptimeSeconds: number;
  processMemory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
  };
  disk?: DiskSpaceSample;
  diskUnavailableReason?: string;
}

export interface SystemHealthToolOptions {
  healthRoot: string;
  sample?: (healthRoot: string) => Promise<SystemHealthRawSample>;
}

export function createSystemHealthTool(
  options: SystemHealthToolOptions,
): ToolDefinition {
  if (!options.healthRoot.trim()) {
    throw new Error("system_health requires a non-empty healthRoot.");
  }

  return {
    name: "system_health",
    description:
      "Take a fresh, bounded health snapshot of the machine hosting Ayati. "
      + "Reports CPU load, memory availability, Ayati-volume disk availability, uptime, and Ayati process memory; it does not expose host identity, networks, environment variables, or process lists.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    outputSchema: systemHealthOutputSchema,
    annotations: commonAnnotations({
      domain: "system",
      readOnly: true,
    }),
    observationPolicy: {
      outputImportance: "decision_context",
      maxObservationChars: 4_000,
      rawStorage: "never",
    },
    resultContract: succeededContract({
      assertions: [
        {
          id: "system_health_status_present",
          kind: "json_path_exists",
          path: "$.result.structuredContent.status",
        },
        {
          id: "system_health_sample_time_present",
          kind: "json_path_exists",
          path: "$.result.structuredContent.sampledAtUtc",
        },
      ],
      progressFacts: [{
        kind: "system_health_observed",
        path: "$.result.structuredContent.scope",
        message: "Fresh local system health observed.",
      }],
    }),
    async execute(input): Promise<ToolResult> {
      const inputError = validateEmptyInput(input);
      if (inputError) return inputError;

      let sample: SystemHealthRawSample;
      try {
        sample = await (options.sample ?? collectSystemHealthSample)(
          options.healthRoot,
        );
      } catch {
        return errorResult({
          code: "SYSTEM_HEALTH_SAMPLE_FAILED",
          message: "The local runtime could not collect a system health snapshot.",
          category: "transient",
          retryable: true,
          recoverable: true,
          suggestedNextActions: ["Retry the system_health observation."],
        });
      }

      if (!Number.isFinite(sample.sampledAt.getTime())) {
        return errorResult({
          code: "SYSTEM_HEALTH_SAMPLE_INVALID",
          message: "The local runtime returned an invalid health sample timestamp.",
          category: "transient",
          retryable: true,
          recoverable: true,
          suggestedNextActions: ["Retry the system_health observation."],
        });
      }

      const structuredContent = buildSystemHealthSnapshot(sample);
      return okJsonResult({
        structuredContent,
        code: "SYSTEM_HEALTH_OBSERVED",
        message: `Local system health observed with status ${structuredContent.status}.`,
        meta: {
          sampledAtUtc: structuredContent.sampledAtUtc,
          status: structuredContent.status,
        },
      });
    },
  };
}

async function collectSystemHealthSample(
  healthRoot: string,
): Promise<SystemHealthRawSample> {
  const memory = process.memoryUsage();
  const load = loadavg();
  let disk: DiskSpaceSample | undefined;
  let diskUnavailableReason: string | undefined;
  try {
    const stats = await statfs(healthRoot);
    disk = {
      totalBytes: stats.blocks * stats.bsize,
      availableBytes: stats.bavail * stats.bsize,
    };
  } catch {
    diskUnavailableReason = "filesystem_stats_unavailable";
  }

  return {
    sampledAt: new Date(),
    platform: platform(),
    architecture: arch(),
    logicalCores: cpus().length,
    loadAverage: [
      load[0] ?? 0,
      load[1] ?? 0,
      load[2] ?? 0,
    ],
    totalMemoryBytes: totalmem(),
    availableMemoryBytes: freemem(),
    systemUptimeSeconds: uptime(),
    processUptimeSeconds: process.uptime(),
    processMemory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
    },
    ...(disk ? { disk } : {}),
    ...(diskUnavailableReason ? { diskUnavailableReason } : {}),
  };
}

function buildSystemHealthSnapshot(sample: SystemHealthRawSample) {
  const cpu = buildCpuHealth(sample);
  const memory = buildCapacityHealth(
    sample.totalMemoryBytes,
    sample.availableMemoryBytes,
  );
  const disk = sample.disk
    ? {
        scope: "ayati-root-volume",
        ...buildCapacityHealth(
          sample.disk.totalBytes,
          sample.disk.availableBytes,
        ),
      }
    : {
        scope: "ayati-root-volume",
        status: "unknown" as const,
        reason: sample.diskUnavailableReason ?? "filesystem_stats_unavailable",
      };
  const status = overallStatus([cpu.status, memory.status, disk.status]);
  const signals = [
    ...componentSignals("cpu", cpu.status, cpu.normalizedLoad1m),
    ...componentSignals("memory", memory.status, memory.usedPercent),
    ...componentSignals(
      "disk",
      disk.status,
      "usedPercent" in disk ? disk.usedPercent : undefined,
    ),
  ];

  return {
    scope: "local-machine",
    sampledAtUtc: sample.sampledAt.toISOString(),
    status,
    platform: sample.platform,
    architecture: sample.architecture,
    systemUptimeSeconds: roundWhole(sample.systemUptimeSeconds),
    cpu,
    memory,
    disk,
    agentProcess: {
      uptimeSeconds: roundWhole(sample.processUptimeSeconds),
      rssBytes: roundWhole(sample.processMemory.rssBytes),
      heapUsedBytes: roundWhole(sample.processMemory.heapUsedBytes),
      heapTotalBytes: roundWhole(sample.processMemory.heapTotalBytes),
      externalBytes: roundWhole(sample.processMemory.externalBytes),
    },
    signals,
  };
}

function buildCpuHealth(sample: SystemHealthRawSample) {
  const logicalCores = Math.max(0, Math.trunc(sample.logicalCores));
  const loadValuesAreValid = sample.loadAverage.every(Number.isFinite);
  const [load1m, load5m, load15m] = sample.loadAverage.map(
    (value) => Number.isFinite(value) ? roundTwo(value) : 0,
  ) as [
    number,
    number,
    number,
  ];
  if (
    logicalCores === 0
    || !loadValuesAreValid
  ) {
    return {
      status: "unknown" as const,
      logicalCores,
      load1m,
      load5m,
      load15m,
      normalizedLoad1m: null,
    };
  }
  const normalizedLoad1m = roundTwo(load1m / logicalCores);
  const status: SystemHealthStatus = normalizedLoad1m >= 2
    ? "critical"
    : normalizedLoad1m >= 1
      ? "degraded"
      : "healthy";
  return {
    status,
    logicalCores,
    load1m,
    load5m,
    load15m,
    normalizedLoad1m,
  };
}

function buildCapacityHealth(totalValue: number, availableValue: number) {
  const totalBytes = positiveNumber(totalValue);
  const availableBytes = Math.min(totalBytes, positiveNumber(availableValue));
  if (totalBytes <= 0) {
    return {
      status: "unknown" as const,
      totalBytes: 0,
      availableBytes: 0,
      usedBytes: 0,
      usedPercent: 0,
    };
  }
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const usedPercent = roundTwo((usedBytes / totalBytes) * 100);
  const status: SystemHealthStatus = usedPercent >= 95
    ? "critical"
    : usedPercent >= 90
      ? "degraded"
      : "healthy";
  return {
    status,
    totalBytes: roundWhole(totalBytes),
    availableBytes: roundWhole(availableBytes),
    usedBytes: roundWhole(usedBytes),
    usedPercent,
  };
}

function overallStatus(statuses: SystemHealthStatus[]): SystemHealthStatus {
  if (statuses.includes("critical")) return "critical";
  if (statuses.includes("degraded")) return "degraded";
  if (statuses.includes("unknown")) return "unknown";
  return "healthy";
}

function componentSignals(
  component: "cpu" | "memory" | "disk",
  status: SystemHealthStatus,
  value: number | null | undefined,
) {
  if (status === "healthy") return [];
  const valueLabel = typeof value === "number"
    ? ` (${value})`
    : "";
  return [{
    code: `${component}_${status}`,
    severity: status === "critical" ? "error" as const : "warning" as const,
    message: `${component} health is ${status}${valueLabel}.`,
  }];
}

function validateEmptyInput(input: unknown): ToolResult | undefined {
  if (input === undefined || input === null) return undefined;
  if (
    typeof input !== "object"
    || Array.isArray(input)
    || Object.keys(input as Record<string, unknown>).length > 0
  ) {
    return errorResult({
      code: "SYSTEM_HEALTH_INPUT_INVALID",
      message: "system_health accepts only an empty object.",
      category: "validation",
      retryable: true,
      recoverable: true,
      suggestedNextActions: ["Call system_health with an empty object."],
    });
  }
  return undefined;
}

function positiveNumber(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function roundWhole(value: number): number {
  return Math.round(positiveNumber(value));
}

function roundTwo(value: number): number {
  return Number.isFinite(value)
    ? Math.round(value * 100) / 100
    : Number.NaN;
}

const healthStatusSchema = {
  type: "string",
  enum: ["healthy", "degraded", "critical", "unknown"],
} as const;

const capacitySchema = {
  type: "object",
  required: [
    "status",
    "totalBytes",
    "availableBytes",
    "usedBytes",
    "usedPercent",
  ],
  properties: {
    status: healthStatusSchema,
    totalBytes: { type: "integer" },
    availableBytes: { type: "integer" },
    usedBytes: { type: "integer" },
    usedPercent: { type: "number" },
  },
} as const;

const systemHealthOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "scope",
    "sampledAtUtc",
    "status",
    "platform",
    "architecture",
    "systemUptimeSeconds",
    "cpu",
    "memory",
    "disk",
    "agentProcess",
    "signals",
  ],
  properties: {
    scope: { type: "string" },
    sampledAtUtc: { type: "string" },
    status: healthStatusSchema,
    platform: { type: "string" },
    architecture: { type: "string" },
    systemUptimeSeconds: { type: "integer" },
    cpu: {
      type: "object",
      required: [
        "status",
        "logicalCores",
        "load1m",
        "load5m",
        "load15m",
        "normalizedLoad1m",
      ],
      properties: {
        status: healthStatusSchema,
        logicalCores: { type: "integer" },
        load1m: { type: "number" },
        load5m: { type: "number" },
        load15m: { type: "number" },
        normalizedLoad1m: { type: ["number", "null"] },
      },
    },
    memory: capacitySchema,
    disk: {
      type: "object",
      required: ["scope", "status"],
      properties: {
        scope: { type: "string" },
        status: healthStatusSchema,
        totalBytes: { type: "integer" },
        availableBytes: { type: "integer" },
        usedBytes: { type: "integer" },
        usedPercent: { type: "number" },
        reason: { type: "string" },
      },
    },
    agentProcess: {
      type: "object",
      required: [
        "uptimeSeconds",
        "rssBytes",
        "heapUsedBytes",
        "heapTotalBytes",
        "externalBytes",
      ],
      properties: {
        uptimeSeconds: { type: "integer" },
        rssBytes: { type: "integer" },
        heapUsedBytes: { type: "integer" },
        heapTotalBytes: { type: "integer" },
        externalBytes: { type: "integer" },
      },
    },
    signals: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        required: ["code", "severity", "message"],
        properties: {
          code: { type: "string" },
          severity: {
            type: "string",
            enum: ["warning", "error"],
          },
          message: { type: "string" },
        },
      },
    },
  },
} as const;

export function createSystemHealthSkill(
  options: SystemHealthToolOptions,
): SkillDefinition {
  return {
    id: "system-health",
    version: "1.0.0",
    description: "Bounded local host and Ayati process health observation.",
    tools: [createSystemHealthTool(options)],
  };
}
