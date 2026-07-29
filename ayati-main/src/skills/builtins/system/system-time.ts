import {
  getNowSnapshot,
  getTimeZoneOffsetMinutes,
  isValidTimeZone,
} from "../../../pulse/time.js";
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

interface SystemTimeInput {
  timezone?: string;
}

export interface SystemTimeToolOptions {
  defaultTimezone: string;
  now?: () => Date;
}

export function createSystemTimeTool(
  options: SystemTimeToolOptions,
): ToolDefinition {
  const defaultTimezone = options.defaultTimezone.trim();
  if (!isValidTimeZone(defaultTimezone)) {
    throw new Error(
      `system_time requires a valid default IANA timezone, received '${options.defaultTimezone}'.`,
    );
  }

  return {
    name: "system_time",
    description:
      "Get a fresh, timezone-aware date, time, weekday, UTC offset, and timestamp. "
      + "For local, machine-local, or Ayati-local time, omit timezone so Ayati's configured timezone is used. "
      + "Set timezone only when the user explicitly requests a particular timezone or location.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        timezone: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description:
            "Optional IANA timezone for a timezone or location explicitly requested by the user. "
            + "Omit it for local, machine-local, or Ayati-local time; Ayati's configured timezone will be used.",
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "scope",
        "observedAtUtc",
        "epochMs",
        "timezone",
        "utcOffsetMinutes",
        "utcOffset",
        "localDate",
        "localTime",
        "weekday",
      ],
      properties: {
        scope: { type: "string" },
        observedAtUtc: { type: "string" },
        epochMs: { type: "integer" },
        timezone: { type: "string" },
        utcOffsetMinutes: { type: "integer" },
        utcOffset: { type: "string" },
        localDate: { type: "string" },
        localTime: { type: "string" },
        weekday: { type: "string" },
      },
    },
    annotations: commonAnnotations({
      domain: "system",
      readOnly: true,
    }),
    observationPolicy: {
      outputImportance: "decision_context",
      maxObservationChars: 2_000,
      rawStorage: "never",
    },
    resultContract: succeededContract({
      assertions: [
        {
          id: "system_time_timestamp_present",
          kind: "json_path_exists",
          path: "$.result.structuredContent.observedAtUtc",
        },
        {
          id: "system_time_timezone_present",
          kind: "json_path_exists",
          path: "$.result.structuredContent.timezone",
        },
      ],
      progressFacts: [{
        kind: "system_time_observed",
        path: "$.result.structuredContent.scope",
        message: "Fresh system time observed.",
      }],
    }),
    async execute(input): Promise<ToolResult> {
      const parsed = parseSystemTimeInput(input);
      if ("ok" in parsed) return parsed;

      const timezone = parsed.timezone ?? defaultTimezone;
      if (!isValidTimeZone(timezone)) {
        return errorResult({
          code: "SYSTEM_TIME_INVALID_TIMEZONE",
          message: `Unknown or unsupported IANA timezone '${timezone}'.`,
          category: "validation",
          target: timezone,
          retryable: true,
          recoverable: true,
          suggestedNextActions: [
            "Retry with a valid explicitly requested IANA timezone, or omit timezone to use Ayati's configured local timezone.",
          ],
        });
      }

      const observedAt = options.now?.() ?? new Date();
      if (!Number.isFinite(observedAt.getTime())) {
        return errorResult({
          code: "SYSTEM_TIME_CLOCK_UNAVAILABLE",
          message: "The local runtime did not provide a valid current timestamp.",
          category: "transient",
          retryable: true,
          recoverable: true,
          suggestedNextActions: ["Retry the system_time observation."],
        });
      }

      const snapshot = getNowSnapshot(observedAt, timezone);
      const utcOffsetMinutes = getTimeZoneOffsetMinutes(
        observedAt,
        snapshot.timezone,
      );
      const structuredContent = {
        scope: `timezone:${snapshot.timezone}`,
        observedAtUtc: snapshot.nowUtc,
        epochMs: observedAt.getTime(),
        timezone: snapshot.timezone,
        utcOffsetMinutes,
        utcOffset: formatUtcOffset(utcOffsetMinutes),
        localDate: snapshot.localDate,
        localTime: snapshot.localTime,
        weekday: snapshot.weekday,
      };

      return okJsonResult({
        structuredContent,
        code: "SYSTEM_TIME_OBSERVED",
        message: `Current time observed in ${snapshot.timezone}.`,
        meta: {
          observedAtUtc: snapshot.nowUtc,
          timezone: snapshot.timezone,
        },
      });
    },
  };
}

function parseSystemTimeInput(
  input: unknown,
): SystemTimeInput | ToolResult {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    return invalidInput("system_time input must be an object.");
  }

  const record = input as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter(
    (key) => key !== "timezone",
  );
  if (unknownFields.length > 0) {
    return invalidInput(
      `system_time does not accept fields: ${unknownFields.join(", ")}.`,
    );
  }
  if (record["timezone"] === undefined) return {};
  if (
    typeof record["timezone"] !== "string"
    || record["timezone"].trim().length === 0
  ) {
    return invalidInput(
      "system_time timezone must be a non-empty IANA timezone string.",
    );
  }
  return { timezone: record["timezone"].trim() };
}

function invalidInput(message: string): ToolResult {
  return errorResult({
    code: "SYSTEM_TIME_INPUT_INVALID",
    message,
    category: "validation",
    retryable: true,
    recoverable: true,
    suggestedNextActions: [
      "Call system_time with an empty object or one valid timezone field.",
    ],
  });
}

function formatUtcOffset(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const remainingMinutes = absolute % 60;
  return `${sign}${String(hours).padStart(2, "0")}:${String(remainingMinutes).padStart(2, "0")}`;
}

export function createSystemTimeSkill(
  options: SystemTimeToolOptions,
): SkillDefinition {
  return {
    id: "system-time",
    version: "1.0.0",
    description: "Fresh timezone-aware system time observation.",
    tools: [createSystemTimeTool(options)],
  };
}
