import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AyatiSystemEvent,
  SystemEventCreatedBy,
  SystemEventIntentKind,
} from "../core/contracts/plugin.js";
import type { AgentResponseKind } from "../memory/types.js";

export type SystemEventHandlingMode =
  | "auto_execute_notify"
  | "analyze_notify"
  | "draft_then_approve"
  | "approve_then_execute";

export type SystemEventContextVisibility = "none" | "summary" | "full";

export interface SystemEventClassification {
  intentKind: SystemEventIntentKind;
  requestedAction?: string;
  createdBy: SystemEventCreatedBy;
}

export interface SystemEventPolicyRule {
  source: string;
  eventName: string;
  intentKind?: SystemEventIntentKind | "*";
  mode?: SystemEventHandlingMode;
  delivery?: AgentResponseKind;
  contextVisibility?: SystemEventContextVisibility;
  approvalRequired?: boolean;
  feedbackTtlHours?: number;
}

export interface SystemEventPolicyDefaults {
  mode: SystemEventHandlingMode;
  delivery: AgentResponseKind;
  contextVisibility: SystemEventContextVisibility;
  approvalRequired: boolean;
  feedbackTtlHours: number;
}

export interface SystemEventPolicyConfig {
  schemaVersion: 1;
  defaults: SystemEventPolicyDefaults;
  rules: SystemEventPolicyRule[];
}

export interface ResolvedSystemEventPolicy {
  mode: SystemEventHandlingMode;
  delivery: AgentResponseKind;
  contextVisibility: SystemEventContextVisibility;
  approvalRequired: boolean;
  feedbackTtlHours: number;
}

const DEFAULT_SYSTEM_EVENT_POLICY: SystemEventPolicyConfig = {
  schemaVersion: 1,
  defaults: {
    mode: "analyze_notify",
    delivery: "notification",
    contextVisibility: "summary",
    approvalRequired: false,
    feedbackTtlHours: 24,
  },
  rules: [],
};

export function loadSystemEventPolicy(projectRoot: string): SystemEventPolicyConfig {
  const path = resolve(projectRoot, "context", "system-event-policy.json");
  if (!existsSync(path)) {
    return DEFAULT_SYSTEM_EVENT_POLICY;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if ("defaults" in parsed || "schemaVersion" in parsed) {
      return parseModernPolicy(parsed);
    }
    return parseLegacyPolicy(parsed);
  } catch {
    return DEFAULT_SYSTEM_EVENT_POLICY;
  }
}

export function classifySystemEvent(event: AyatiSystemEvent): SystemEventClassification {
  const payloadTask = asOptionalRecord(event.payload["task"]);
  const explicitIntentKind = normalizeIntentKind(event.intent?.kind);
  const explicitRequestedAction = normalizeRequestedAction(event.intent?.requestedAction)
    ?? normalizeRequestedAction(asOptionalString(event.payload["requestedAction"]))
    ?? normalizeRequestedAction(asOptionalString(payloadTask?.["requestedAction"]))
    ?? normalizeRequestedAction(asOptionalString(event.payload["actionType"]));
  const explicitCreatedBy = normalizeCreatedBy(event.intent?.createdBy);

  const intentKind = explicitIntentKind ?? inferIntentKind(event);
  const requestedAction = explicitRequestedAction ?? inferRequestedAction(event, intentKind);
  const createdBy = explicitCreatedBy ?? inferCreatedBy(event);

  return {
    intentKind,
    ...(requestedAction ? { requestedAction } : {}),
    createdBy,
  };
}

export function resolveSystemEventPolicy(
  policy: SystemEventPolicyConfig | undefined,
  event: AyatiSystemEvent,
  intentKind: SystemEventIntentKind,
): ResolvedSystemEventPolicy {
  const effective = coercePolicyConfig(policy);
  const defaults = normalizeDefaults(effective.defaults);

  for (const rule of effective.rules) {
    const sourceMatches = rule.source === "*" || rule.source === event.source;
    const eventMatches = rule.eventName === "*" || rule.eventName === event.eventName;
    const intentMatches = rule.intentKind === undefined || rule.intentKind === "*" || rule.intentKind === intentKind;
    if (!sourceMatches || !eventMatches || !intentMatches) {
      continue;
    }
    return mergePolicy(defaults, rule);
  }

  return defaults;
}

export function resolveSystemEventResponseKind(
  policy: SystemEventPolicyConfig | undefined,
  event: AyatiSystemEvent,
): AgentResponseKind {
  const classification = classifySystemEvent(event);
  return resolveSystemEventPolicy(policy, event, classification.intentKind).delivery;
}

function coercePolicyConfig(policy: SystemEventPolicyConfig | undefined): SystemEventPolicyConfig {
  if (!policy) {
    return DEFAULT_SYSTEM_EVENT_POLICY;
  }

  const parsed = policy as unknown as Record<string, unknown>;
  if ("defaults" in parsed || "schemaVersion" in parsed) {
    return parseModernPolicy(parsed);
  }

  return parseLegacyPolicy(parsed);
}

function parseModernPolicy(parsed: Record<string, unknown>): SystemEventPolicyConfig {
  const defaults = parseDefaults(parsed["defaults"]);
  const rules = parseRules(parsed["rules"]);
  return {
    schemaVersion: 1,
    defaults,
    rules,
  };
}

function parseLegacyPolicy(parsed: Record<string, unknown>): SystemEventPolicyConfig {
  const defaultResponseKind = isResponseKind(parsed["defaultResponseKind"])
    ? parsed["defaultResponseKind"]
    : DEFAULT_SYSTEM_EVENT_POLICY.defaults.delivery;

  const defaults = normalizeDefaults({
    ...DEFAULT_SYSTEM_EVENT_POLICY.defaults,
    delivery: defaultResponseKind,
    mode: deliveryToDefaultMode(defaultResponseKind),
    approvalRequired: deliveryRequiresApproval(defaultResponseKind),
  });

  const rules = Array.isArray(parsed["rules"])
    ? parsed["rules"].flatMap((rule) => {
      if (!rule || typeof rule !== "object") return [];
      const value = rule as Record<string, unknown>;
      if (typeof value["source"] !== "string" || typeof value["eventName"] !== "string") {
        return [];
      }
      const delivery = isResponseKind(value["defaultResponseKind"])
        ? value["defaultResponseKind"]
        : undefined;
      return [{
        source: value["source"],
        eventName: value["eventName"],
        ...(delivery ? {
          delivery,
          mode: deliveryToDefaultMode(delivery),
          approvalRequired: deliveryRequiresApproval(delivery),
        } : {}),
      } satisfies SystemEventPolicyRule];
    })
    : [];

  return {
    schemaVersion: 1,
    defaults,
    rules,
  };
}

function parseDefaults(value: unknown): SystemEventPolicyDefaults {
  if (!value || typeof value !== "object") {
    return DEFAULT_SYSTEM_EVENT_POLICY.defaults;
  }

  const parsed = value as Record<string, unknown>;
  return normalizeDefaults({
    mode: normalizeMode(parsed["mode"]) ?? DEFAULT_SYSTEM_EVENT_POLICY.defaults.mode,
    delivery: normalizeDelivery(parsed["delivery"]) ?? DEFAULT_SYSTEM_EVENT_POLICY.defaults.delivery,
    contextVisibility: normalizeContextVisibility(parsed["contextVisibility"]) ?? DEFAULT_SYSTEM_EVENT_POLICY.defaults.contextVisibility,
    approvalRequired: typeof parsed["approvalRequired"] === "boolean"
      ? parsed["approvalRequired"]
      : DEFAULT_SYSTEM_EVENT_POLICY.defaults.approvalRequired,
    feedbackTtlHours: normalizePositiveNumber(parsed["feedbackTtlHours"]) ?? DEFAULT_SYSTEM_EVENT_POLICY.defaults.feedbackTtlHours,
  });
}

function parseRules(value: unknown): SystemEventPolicyRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((rule) => {
    if (!rule || typeof rule !== "object") return [];
    const parsed = rule as Record<string, unknown>;
    if (typeof parsed["source"] !== "string" || typeof parsed["eventName"] !== "string") {
      return [];
    }

    const intentKind = parsed["intentKind"] === "*"
      ? "*"
      : normalizeIntentKind(parsed["intentKind"]);
    const mode = normalizeMode(parsed["mode"]);
    const delivery = normalizeDelivery(parsed["delivery"]);
    const contextVisibility = normalizeContextVisibility(parsed["contextVisibility"]);
    const feedbackTtlHours = normalizePositiveNumber(parsed["feedbackTtlHours"]);

    return [{
      source: parsed["source"],
      eventName: parsed["eventName"],
      ...(intentKind ? { intentKind } : {}),
      ...(mode ? { mode } : {}),
      ...(delivery ? { delivery } : {}),
      ...(contextVisibility ? { contextVisibility } : {}),
      ...(typeof parsed["approvalRequired"] === "boolean" ? { approvalRequired: parsed["approvalRequired"] } : {}),
      ...(feedbackTtlHours ? { feedbackTtlHours } : {}),
    } satisfies SystemEventPolicyRule];
  });
}

function mergePolicy(defaults: SystemEventPolicyDefaults, rule: SystemEventPolicyRule): ResolvedSystemEventPolicy {
  const mode = rule.mode ?? defaults.mode;
  const delivery = rule.delivery ?? defaults.delivery ?? modeToDefaultDelivery(mode);
  return {
    mode,
    delivery,
    contextVisibility: rule.contextVisibility ?? defaults.contextVisibility,
    approvalRequired: rule.approvalRequired ?? modeRequiresApproval(mode) ?? defaults.approvalRequired,
    feedbackTtlHours: rule.feedbackTtlHours ?? defaults.feedbackTtlHours,
  };
}

function normalizeDefaults(defaults: SystemEventPolicyDefaults): SystemEventPolicyDefaults {
  const mode = normalizeMode(defaults.mode) ?? DEFAULT_SYSTEM_EVENT_POLICY.defaults.mode;
  const delivery = normalizeDelivery(defaults.delivery) ?? modeToDefaultDelivery(mode);
  return {
    mode,
    delivery,
    contextVisibility: normalizeContextVisibility(defaults.contextVisibility) ?? DEFAULT_SYSTEM_EVENT_POLICY.defaults.contextVisibility,
    approvalRequired: typeof defaults.approvalRequired === "boolean"
      ? defaults.approvalRequired
      : modeRequiresApproval(mode),
    feedbackTtlHours: normalizePositiveNumber(defaults.feedbackTtlHours) ?? DEFAULT_SYSTEM_EVENT_POLICY.defaults.feedbackTtlHours,
  };
}

function inferIntentKind(event: AyatiSystemEvent): SystemEventIntentKind {
  const source = event.source.toLowerCase();
  const eventName = event.eventName.toLowerCase();
  const summary = event.summary.toLowerCase();
  const instruction = asOptionalString(event.payload["instruction"])?.toLowerCase() ?? "";
  const payloadIntentKind = normalizeIntentKind(event.payload["intentKind"]);

  if (payloadIntentKind) {
    return payloadIntentKind;
  }

  if (source === "pulse" && (eventName === "task_due" || typeof event.payload["taskId"] === "string")) {
    return "task";
  }

  if (source === "pulse" && asOptionalRecord(event.payload["task"])) {
    return "task";
  }

  if (source === "pulse" && eventName === "reminder_due") {
    return "reminder";
  }

  if (eventName.includes("reminder") || summary.includes("reminder due")) {
    return "reminder";
  }

  if (source.includes("mail") && eventName.includes("received")) {
    return "task";
  }

  if (instruction.length > 0 || asOptionalString(event.payload["requestedAction"])) {
    return "task";
  }

  if (/\b(check|review|reply|send|create|update|fix|run|execute)\b/.test(summary)) {
    return "task";
  }

  if (
    eventName.includes("notification")
    || eventName.includes("alert")
    || summary.includes("new ")
    || summary.includes("alert")
    || summary.includes("notification")
    || typeof event.payload["unreadCount"] === "number"
  ) {
    return "notification";
  }

  return "unknown";
}

function inferRequestedAction(event: AyatiSystemEvent, intentKind: SystemEventIntentKind): string | undefined {
  const payloadInstruction = asOptionalString(event.payload["instruction"]);
  if (payloadInstruction) {
    const normalized = normalizeRequestedAction(payloadInstruction);
    if (normalized) {
      return normalized;
    }
  }

  const summary = event.summary.toLowerCase();
  if (summary.includes("health")) {
    return "check_system_health";
  }

  if (event.source.toLowerCase().includes("mail")) {
    return "review_incoming_message";
  }

  if (intentKind === "reminder") {
    return "handle_reminder";
  }
  if (intentKind === "notification") {
    return "review_notification";
  }
  if (intentKind === "task") {
    return "process_system_task";
  }
  return undefined;
}

function inferCreatedBy(event: AyatiSystemEvent): SystemEventCreatedBy {
  const source = event.source.toLowerCase();
  if (source === "pulse" || typeof event.payload["reminderId"] === "string") {
    return "user";
  }
  if (source.includes("mail") || event.eventName.toLowerCase().includes("received")) {
    return "external";
  }
  return "system";
}

function normalizeRequestedAction(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const compact = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return compact.length > 0 ? compact : undefined;
}

function normalizeIntentKind(value: unknown): SystemEventIntentKind | undefined {
  return value === "reminder" || value === "task" || value === "notification" || value === "unknown"
    ? value
    : undefined;
}

function normalizeCreatedBy(value: unknown): SystemEventCreatedBy | undefined {
  return value === "user" || value === "system" || value === "external" || value === "unknown"
    ? value
    : undefined;
}

function normalizeMode(value: unknown): SystemEventHandlingMode | undefined {
  return value === "auto_execute_notify"
    || value === "analyze_notify"
    || value === "draft_then_approve"
    || value === "approve_then_execute"
    ? value
    : undefined;
}

function normalizeDelivery(value: unknown): AgentResponseKind | undefined {
  return isResponseKind(value) ? value : undefined;
}

function normalizeContextVisibility(value: unknown): SystemEventContextVisibility | undefined {
  return value === "none" || value === "summary" || value === "full"
    ? value
    : undefined;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function modeToDefaultDelivery(mode: SystemEventHandlingMode): AgentResponseKind {
  switch (mode) {
    case "auto_execute_notify":
    case "analyze_notify":
      return "notification";
    case "draft_then_approve":
    case "approve_then_execute":
      return "feedback";
  }
}

function deliveryToDefaultMode(delivery: AgentResponseKind): SystemEventHandlingMode {
  switch (delivery) {
    case "feedback":
      return "draft_then_approve";
    case "notification":
    case "none":
      return "analyze_notify";
    case "reply":
    default:
      return "auto_execute_notify";
  }
}

function modeRequiresApproval(mode: SystemEventHandlingMode): boolean {
  return mode === "draft_then_approve" || mode === "approve_then_execute";
}

function deliveryRequiresApproval(delivery: AgentResponseKind): boolean {
  return delivery === "feedback";
}

function isResponseKind(value: unknown): value is AgentResponseKind {
  return value === "reply" || value === "feedback" || value === "notification" || value === "none";
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
