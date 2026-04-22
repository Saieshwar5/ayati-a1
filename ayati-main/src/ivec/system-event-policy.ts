import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AyatiSystemEvent,
  SystemEventClass,
  SystemEventCreatedBy,
  SystemEventEffectLevel,
  SystemEventIntentKind,
  SystemEventTrustTier,
} from "../core/contracts/plugin.js";
import type { AgentResponseKind } from "../memory/types.js";

export type SystemEventHandlingMode =
  | "log_only"
  | "auto_execute_notify"
  | "auto_execute_silent"
  | "analyze_notify"
  | "analyze_ask"
  | "draft_then_approve"
  | "approve_then_execute";

export type SystemEventContextVisibility = "none" | "summary" | "full";

export interface SystemEventClassification {
  intentKind: SystemEventIntentKind;
  eventClass: SystemEventClass;
  trustTier: SystemEventTrustTier;
  effectLevel: SystemEventEffectLevel;
  requestedAction?: string;
  createdBy: SystemEventCreatedBy;
}

export interface SystemEventPolicyRule {
  source?: string;
  eventName?: string;
  intentKind?: SystemEventIntentKind | "*";
  eventClass?: SystemEventClass | "*";
  trustTier?: SystemEventTrustTier | "*";
  effectLevel?: SystemEventEffectLevel | "*";
  createdBy?: SystemEventCreatedBy | "*";
  requestedAction?: string | "*";
  mode?: SystemEventHandlingMode;
  delivery?: AgentResponseKind;
  contextVisibility?: SystemEventContextVisibility;
  approvalRequired?: boolean;
}

export interface SystemEventPolicyDefaults {
  mode: SystemEventHandlingMode;
  delivery: AgentResponseKind;
  contextVisibility: SystemEventContextVisibility;
  approvalRequired: boolean;
}

export interface SystemEventPolicyConfig {
  schemaVersion: 1 | 2;
  defaults: SystemEventPolicyDefaults;
  rules: SystemEventPolicyRule[];
}

export interface ResolvedSystemEventPolicy {
  mode: SystemEventHandlingMode;
  delivery: AgentResponseKind;
  contextVisibility: SystemEventContextVisibility;
  approvalRequired: boolean;
}

const DEFAULT_SYSTEM_EVENT_POLICY: SystemEventPolicyConfig = {
  schemaVersion: 2,
  defaults: {
    mode: "analyze_notify",
    delivery: "notification",
    contextVisibility: "summary",
    approvalRequired: false,
  },
  rules: [],
};

const EXTERNAL_ACTION_HINT = /\b(send|reply|email|mail|message|notify|post|share|forward|invite|publish|dispatch)\b/i;

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
    ?? normalizeRequestedAction(asOptionalString(event.payload["actionType"]))
    ?? normalizeRequestedAction(asOptionalString(event.payload["instruction"]));
  const explicitCreatedBy = normalizeCreatedBy(event.intent?.createdBy);
  const explicitEventClass = normalizeEventClass(event.intent?.eventClass)
    ?? normalizeEventClass(event.payload["eventClass"])
    ?? normalizeEventClass(event.payload["event_class"]);
  const explicitTrustTier = normalizeTrustTier(event.intent?.trustTier)
    ?? normalizeTrustTier(event.payload["trustTier"])
    ?? normalizeTrustTier(event.payload["trust_tier"]);
  const explicitEffectLevel = normalizeEffectLevel(event.intent?.effectLevel)
    ?? normalizeEffectLevel(event.payload["effectLevel"])
    ?? normalizeEffectLevel(event.payload["effect_level"]);

  const intentKind = explicitIntentKind ?? inferIntentKind(event);
  const requestedAction = explicitRequestedAction ?? inferRequestedAction(event, intentKind);
  const createdBy = explicitCreatedBy ?? inferCreatedBy(event);
  const eventClass = explicitEventClass ?? inferEventClass(event, requestedAction);
  const trustTier = explicitTrustTier ?? inferTrustTier(event, eventClass, createdBy);
  const effectLevel = explicitEffectLevel ?? inferEffectLevel(event, eventClass, requestedAction);

  return {
    intentKind,
    eventClass,
    trustTier,
    effectLevel,
    ...(requestedAction ? { requestedAction } : {}),
    createdBy,
  };
}

export function resolveSystemEventPolicy(
  policy: SystemEventPolicyConfig | undefined,
  event: AyatiSystemEvent,
  classification: SystemEventClassification,
): ResolvedSystemEventPolicy {
  const effective = coercePolicyConfig(policy);
  const defaults = normalizeDefaults(effective.defaults);
  const matchedRule = resolveBestRule(effective.rules, event, classification);
  return matchedRule ? mergePolicy(defaults, matchedRule) : defaults;
}

export function resolveSystemEventResponseKind(
  policy: SystemEventPolicyConfig | undefined,
  event: AyatiSystemEvent,
): AgentResponseKind {
  const classification = classifySystemEvent(event);
  return resolveSystemEventPolicy(policy, event, classification).delivery;
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
  const schemaVersion = parsed["schemaVersion"] === 1 ? 1 : 2;
  const defaults = parseDefaults(parsed["defaults"]);
  const rules = parseRules(parsed["rules"]);
  return {
    schemaVersion,
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
      const delivery = isResponseKind(value["defaultResponseKind"])
        ? value["defaultResponseKind"]
        : undefined;
      const mode = delivery ? deliveryToDefaultMode(delivery) : undefined;
      return [{
        source: normalizeOptionalRuleString(value["source"]),
        eventName: normalizeOptionalRuleString(value["eventName"]),
        mode,
        ...(delivery ? { delivery } : {}),
        ...(delivery ? { approvalRequired: deliveryRequiresApproval(delivery) } : {}),
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
  });
}

function parseRules(value: unknown): SystemEventPolicyRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((rule) => {
    if (!rule || typeof rule !== "object") return [];
    const parsed = rule as Record<string, unknown>;

    const intentKind = parsed["intentKind"] === "*"
      ? "*"
      : normalizeIntentKind(parsed["intentKind"]);
    const eventClass = parsed["eventClass"] === "*"
      ? "*"
      : normalizeEventClass(parsed["eventClass"]);
    const trustTier = parsed["trustTier"] === "*"
      ? "*"
      : normalizeTrustTier(parsed["trustTier"]);
    const effectLevel = parsed["effectLevel"] === "*"
      ? "*"
      : normalizeEffectLevel(parsed["effectLevel"]);
    const createdBy = parsed["createdBy"] === "*"
      ? "*"
      : normalizeCreatedBy(parsed["createdBy"]);
    const requestedAction = parsed["requestedAction"] === "*"
      ? "*"
      : normalizeRequestedAction(parsed["requestedAction"]);
    const mode = normalizeMode(parsed["mode"]);
    const delivery = normalizeDelivery(parsed["delivery"]);
    const contextVisibility = normalizeContextVisibility(parsed["contextVisibility"]);

    return [{
      source: normalizeOptionalRuleString(parsed["source"]),
      eventName: normalizeOptionalRuleString(parsed["eventName"]),
      ...(intentKind ? { intentKind } : {}),
      ...(eventClass ? { eventClass } : {}),
      ...(trustTier ? { trustTier } : {}),
      ...(effectLevel ? { effectLevel } : {}),
      ...(createdBy ? { createdBy } : {}),
      ...(requestedAction ? { requestedAction } : {}),
      ...(mode ? { mode } : {}),
      ...(delivery ? { delivery } : {}),
      ...(contextVisibility ? { contextVisibility } : {}),
      ...(typeof parsed["approvalRequired"] === "boolean" ? { approvalRequired: parsed["approvalRequired"] } : {}),
    } satisfies SystemEventPolicyRule];
  });
}

function resolveBestRule(
  rules: SystemEventPolicyRule[],
  event: AyatiSystemEvent,
  classification: SystemEventClassification,
): SystemEventPolicyRule | null {
  let bestRule: SystemEventPolicyRule | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const rule of rules) {
    if (!matchesRule(rule, event, classification)) {
      continue;
    }

    const score = scoreRule(rule);
    if (score > bestScore) {
      bestScore = score;
      bestRule = rule;
    }
  }

  return bestRule;
}

function matchesRule(
  rule: SystemEventPolicyRule,
  event: AyatiSystemEvent,
  classification: SystemEventClassification,
): boolean {
  return matchesText(rule.source, event.source)
    && matchesText(rule.eventName, event.eventName)
    && matchesText(rule.requestedAction, classification.requestedAction)
    && matchesEnum(rule.intentKind, classification.intentKind)
    && matchesEnum(rule.eventClass, classification.eventClass)
    && matchesEnum(rule.trustTier, classification.trustTier)
    && matchesEnum(rule.effectLevel, classification.effectLevel)
    && matchesEnum(rule.createdBy, classification.createdBy);
}

function scoreRule(rule: SystemEventPolicyRule): number {
  const priority = rulePriority(rule);
  const specificity = [
    isSpecificRuleValue(rule.source),
    isSpecificRuleValue(rule.eventName),
    isSpecificRuleValue(rule.requestedAction),
    isSpecificRuleValue(rule.intentKind),
    isSpecificRuleValue(rule.eventClass),
    isSpecificRuleValue(rule.trustTier),
    isSpecificRuleValue(rule.effectLevel),
    isSpecificRuleValue(rule.createdBy),
  ].filter(Boolean).length;

  return priority * 100 + specificity;
}

function rulePriority(rule: SystemEventPolicyRule): number {
  if (isSpecificRuleValue(rule.source) && isSpecificRuleValue(rule.eventName) && isSpecificRuleValue(rule.requestedAction)) {
    return 5;
  }
  if (isSpecificRuleValue(rule.source) && isSpecificRuleValue(rule.eventName)) {
    return 4;
  }
  if (isSpecificRuleValue(rule.source) && isSpecificRuleValue(rule.eventClass)) {
    return 3;
  }
  if (isSpecificRuleValue(rule.trustTier) && isSpecificRuleValue(rule.effectLevel) && isSpecificRuleValue(rule.createdBy)) {
    return 2;
  }
  return 1;
}

function mergePolicy(defaults: SystemEventPolicyDefaults, rule: SystemEventPolicyRule): ResolvedSystemEventPolicy {
  const mode = rule.mode ?? defaults.mode;
  return {
    mode,
    delivery: rule.delivery ?? modeToDefaultDelivery(mode),
    contextVisibility: rule.contextVisibility ?? modeToContextVisibility(mode) ?? defaults.contextVisibility,
    approvalRequired: typeof rule.approvalRequired === "boolean"
      ? rule.approvalRequired
      : modeRequiresApproval(mode),
  };
}

function normalizeDefaults(defaults: SystemEventPolicyDefaults): SystemEventPolicyDefaults {
  const mode = normalizeMode(defaults.mode) ?? DEFAULT_SYSTEM_EVENT_POLICY.defaults.mode;
  return {
    mode,
    delivery: normalizeDelivery(defaults.delivery) ?? modeToDefaultDelivery(mode),
    contextVisibility: normalizeContextVisibility(defaults.contextVisibility) ?? modeToContextVisibility(mode),
    approvalRequired: typeof defaults.approvalRequired === "boolean"
      ? defaults.approvalRequired
      : modeRequiresApproval(mode),
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

  if (source === "pulse" && eventName === "reminder_due") {
    return "reminder";
  }

  if (eventName.includes("reminder") || summary.includes("reminder due")) {
    return "reminder";
  }

  if (instruction.length > 0 || asOptionalString(event.payload["requestedAction"])) {
    return "task";
  }

  if (source.includes("mail") && eventName.includes("received")) {
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

function inferEventClass(event: AyatiSystemEvent, requestedAction?: string): SystemEventClass {
  const source = event.source.toLowerCase();
  const eventName = event.eventName.toLowerCase();

  if (eventName.includes("approval")) {
    return "approval_response";
  }
  if (source.includes("mail") && eventName.includes("received")) {
    return "message_received";
  }
  if (eventName.includes("message") && eventName.includes("received")) {
    return "message_received";
  }
  if (
    source === "pulse"
    || eventName.endsWith("_due")
    || eventName.includes("trigger")
    || typeof event.payload["occurrenceId"] === "string"
  ) {
    return "trigger_fired";
  }
  if (
    Array.isArray(event.payload["attachments"])
    || typeof event.payload["documentId"] === "string"
    || eventName.includes("artifact")
    || eventName.includes("document")
    || eventName.includes("attachment")
  ) {
    return "artifact_received";
  }
  if (
    eventName.includes("changed")
    || eventName.includes("updated")
    || eventName.includes("synced")
    || eventName.includes("status")
    || eventName.includes("completed")
  ) {
    return "state_changed";
  }
  if (requestedAction || typeof event.payload["instruction"] === "string") {
    return "task_requested";
  }
  return "state_changed";
}

function inferTrustTier(
  event: AyatiSystemEvent,
  eventClass: SystemEventClass,
  createdBy: SystemEventCreatedBy,
): SystemEventTrustTier {
  const source = event.source.toLowerCase();
  if (source === "pulse") {
    return "internal";
  }
  if (
    createdBy === "external"
    || eventClass === "message_received"
    || source.includes("mail")
    || source.includes("telegram")
    || source.includes("whatsapp")
  ) {
    return "external";
  }
  return "trusted_system";
}

function inferEffectLevel(
  event: AyatiSystemEvent,
  eventClass: SystemEventClass,
  requestedAction?: string,
): SystemEventEffectLevel {
  const action = requestedAction ?? "";
  const summary = event.summary;

  if (eventClass === "message_received" || eventClass === "artifact_received" || eventClass === "state_changed") {
    return "observe";
  }

  if (EXTERNAL_ACTION_HINT.test(action) || EXTERNAL_ACTION_HINT.test(summary)) {
    return "act_external";
  }

  if (eventClass === "trigger_fired" || eventClass === "task_requested" || eventClass === "approval_response") {
    return requestedAction ? "act" : "assist";
  }

  return "assist";
}

function inferCreatedBy(event: AyatiSystemEvent): SystemEventCreatedBy {
  const source = event.source.toLowerCase();
  if (source === "pulse" || typeof event.payload["reminderId"] === "string" || typeof event.payload["taskId"] === "string") {
    return "user";
  }
  if (source.includes("mail") || event.eventName.toLowerCase().includes("received")) {
    return "external";
  }
  return "system";
}

function normalizeRequestedAction(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeIntentKind(value: unknown): SystemEventIntentKind | undefined {
  return value === "reminder" || value === "task" || value === "notification" || value === "unknown"
    ? value
    : undefined;
}

function normalizeCreatedBy(value: unknown): SystemEventCreatedBy | undefined {
  return value === "user"
    || value === "agent"
    || value === "system"
    || value === "external"
    || value === "unknown"
    ? value
    : undefined;
}

function normalizeEventClass(value: unknown): SystemEventClass | undefined {
  return value === "message_received"
    || value === "trigger_fired"
    || value === "task_requested"
    || value === "state_changed"
    || value === "artifact_received"
    || value === "approval_response"
    ? value
    : undefined;
}

function normalizeTrustTier(value: unknown): SystemEventTrustTier | undefined {
  return value === "internal" || value === "trusted_system" || value === "external"
    ? value
    : undefined;
}

function normalizeEffectLevel(value: unknown): SystemEventEffectLevel | undefined {
  return value === "observe" || value === "assist" || value === "act" || value === "act_external"
    ? value
    : undefined;
}

function normalizeMode(value: unknown): SystemEventHandlingMode | undefined {
  return value === "log_only"
    || value === "auto_execute_notify"
    || value === "auto_execute_silent"
    || value === "analyze_notify"
    || value === "analyze_ask"
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

function normalizeOptionalRuleString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isResponseKind(value: unknown): value is AgentResponseKind {
  return value === "reply" || value === "feedback" || value === "notification" || value === "none";
}

function modeToDefaultDelivery(mode: SystemEventHandlingMode): AgentResponseKind {
  switch (mode) {
    case "log_only":
    case "auto_execute_silent":
      return "none";
    case "analyze_notify":
    case "auto_execute_notify":
      return "notification";
    case "analyze_ask":
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
      return "analyze_notify";
    case "none":
      return "log_only";
    case "reply":
      return "auto_execute_notify";
  }
}

function modeRequiresApproval(mode: SystemEventHandlingMode): boolean {
  return mode === "draft_then_approve" || mode === "approve_then_execute";
}

function modeToContextVisibility(mode: SystemEventHandlingMode): SystemEventContextVisibility {
  switch (mode) {
    case "log_only":
      return "none";
    case "auto_execute_notify":
    case "auto_execute_silent":
    case "analyze_notify":
    case "analyze_ask":
    case "draft_then_approve":
    case "approve_then_execute":
      return "summary";
  }
}

function deliveryRequiresApproval(delivery: AgentResponseKind): boolean {
  return delivery === "feedback";
}

function matchesText(ruleValue: string | undefined, actual: string | undefined): boolean {
  if (!isSpecificRuleValue(ruleValue)) {
    return true;
  }
  return actual === ruleValue;
}

function matchesEnum<T extends string>(ruleValue: T | "*" | undefined, actual: T): boolean {
  if (!isSpecificRuleValue(ruleValue)) {
    return true;
  }
  return actual === ruleValue;
}

function isSpecificRuleValue(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value !== "*";
}
