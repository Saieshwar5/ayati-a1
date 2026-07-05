export type RepairCode =
  | "R_ASSISTANT_TEXT_TOOL_CALL"
  | "R_TOOL_NOT_SELECTED"
  | "R_LOAD_TOOLS_USED_AS_ACTION"
  | "R_EMPTY_TOOL_LOAD_SELECTOR"
  | "R_TOOL_INPUT_INVALID"
  | "R_TOOL_INPUT_MISSING_REQUIRED_FIELD"
  | "R_FRESH_SESSION_NEEDS_TASK"
  | "R_NORMAL_TOOL_WITHOUT_TASK_RUN"
  | "R_PENDING_TURN_UNBOUND"
  | "R_PENDING_TURN_CLARIFYING"
  | "R_TASK_FEEDBACK_UNAVAILABLE"
  | "R_MULTIPLE_NATIVE_TOOL_CALLS"
  | "R_PARSE_FAILED"
  | "R_PROVIDER_EMPTY_RESPONSE"
  | "R_PROVIDER_MALFORMED_RESPONSE"
  | "R_VERIFICATION_FAILED"
  | "R_NO_PROGRESS"
  | "R_DUPLICATE_READ"
  | "R_MUTATION_EXPECTED_AFTER_CONTEXT"
  | "R_REPEATED_REPAIR_FAILURE";

export type RepairSeverity = "info" | "repairable" | "warning" | "error" | "fatal";

export interface RepairCatalogEntry {
  code: RepairCode;
  severity: RepairSeverity;
  source: string;
  message: string;
  allowedNextActions: string[];
  modelFacing: boolean;
}

export interface RepairSignal {
  code: RepairCode;
  severity: RepairSeverity;
  source: string;
  message: string;
  blockedTargets: string[];
  missingFields: string[];
  invalidFields: string[];
  allowedNextActions: string[];
  modelFacing: boolean;
  operatorDetails: Record<string, unknown>;
}

export interface RepairSignalInput {
  severity?: RepairSeverity;
  source?: string;
  message?: string;
  blockedTargets?: string[];
  missingFields?: string[];
  invalidFields?: string[];
  allowedNextActions?: string[];
  modelFacing?: boolean;
  operatorDetails?: Record<string, unknown>;
}

export interface RepairPromptCard {
  code: RepairCode;
  message: string;
  blockedTargets?: string[];
  missingFields?: string[];
  invalidFields?: string[];
  allowedNextActions: string[];
}

export interface RepairFeedbackData {
  repair: {
    code: RepairCode;
    severity: RepairSeverity;
    source: string;
    message: string;
    modelFacing: boolean;
    blockedTargets: string[];
    missingFields: string[];
    invalidFields: string[];
    allowedNextActions: string[];
    operatorDetails: Record<string, unknown>;
  };
}

export const REPAIR_CODES: readonly RepairCode[] = [
  "R_ASSISTANT_TEXT_TOOL_CALL",
  "R_TOOL_NOT_SELECTED",
  "R_LOAD_TOOLS_USED_AS_ACTION",
  "R_EMPTY_TOOL_LOAD_SELECTOR",
  "R_TOOL_INPUT_INVALID",
  "R_TOOL_INPUT_MISSING_REQUIRED_FIELD",
  "R_FRESH_SESSION_NEEDS_TASK",
  "R_NORMAL_TOOL_WITHOUT_TASK_RUN",
  "R_PENDING_TURN_UNBOUND",
  "R_PENDING_TURN_CLARIFYING",
  "R_TASK_FEEDBACK_UNAVAILABLE",
  "R_MULTIPLE_NATIVE_TOOL_CALLS",
  "R_PARSE_FAILED",
  "R_PROVIDER_EMPTY_RESPONSE",
  "R_PROVIDER_MALFORMED_RESPONSE",
  "R_VERIFICATION_FAILED",
  "R_NO_PROGRESS",
  "R_DUPLICATE_READ",
  "R_MUTATION_EXPECTED_AFTER_CONTEXT",
  "R_REPEATED_REPAIR_FAILURE",
];

export const REPAIR_CODE_CATALOG: Readonly<Record<RepairCode, RepairCatalogEntry>> = {
  R_ASSISTANT_TEXT_TOOL_CALL: {
    code: "R_ASSISTANT_TEXT_TOOL_CALL",
    severity: "repairable",
    source: "decision.assistant_text",
    message: "The assistant response looked like a tool call written as text.",
    allowedNextActions: [
      "Do not write tool-call JSON in assistant text.",
      "If tool work is needed, call exactly one available native tool directly.",
      "Use direct assistant text only for a user-facing reply.",
    ],
    modelFacing: true,
  },
  R_TOOL_NOT_SELECTED: {
    code: "R_TOOL_NOT_SELECTED",
    severity: "repairable",
    source: "decision.tool_protocol",
    message: "The decision referenced a tool that is not selected for this step.",
    allowedNextActions: [
      "Call only tools listed in Selected tools.",
      "Use decision_load_tools first if a missing tool is needed.",
    ],
    modelFacing: true,
  },
  R_LOAD_TOOLS_USED_AS_ACTION: {
    code: "R_LOAD_TOOLS_USED_AS_ACTION",
    severity: "repairable",
    source: "decision.tool_protocol",
    message: "Tool loading was used as executable work.",
    allowedNextActions: [
      "Use the native decision_load_tools control tool.",
      "Do not put load_tools in executable action calls.",
    ],
    modelFacing: true,
  },
  R_EMPTY_TOOL_LOAD_SELECTOR: {
    code: "R_EMPTY_TOOL_LOAD_SELECTOR",
    severity: "repairable",
    source: "decision.tool_protocol",
    message: "The tool-load request did not include a usable selector.",
    allowedNextActions: [
      "Retry decision_load_tools with at least one exact toolNames, groups, or query selector.",
    ],
    modelFacing: true,
  },
  R_TOOL_INPUT_INVALID: {
    code: "R_TOOL_INPUT_INVALID",
    severity: "repairable",
    source: "decision.input_schema",
    message: "The selected tool input does not match the tool schema.",
    allowedNextActions: [
      "Retry the selected tool with schema-valid input.",
      "Do not use empty or wrongly typed fields.",
    ],
    modelFacing: true,
  },
  R_TOOL_INPUT_MISSING_REQUIRED_FIELD: {
    code: "R_TOOL_INPUT_MISSING_REQUIRED_FIELD",
    severity: "repairable",
    source: "decision.input_schema",
    message: "The selected tool input is missing required fields.",
    allowedNextActions: [
      "Call the selected tool again with the missing required fields.",
    ],
    modelFacing: true,
  },
  R_FRESH_SESSION_NEEDS_TASK: {
    code: "R_FRESH_SESSION_NEEDS_TASK",
    severity: "repairable",
    source: "runner.guard",
    message: "No active task exists yet. Normal work tools cannot run before task creation.",
    allowedNextActions: [
      "Call git_context_create_task_for_turn with title, objective, and reason.",
      "Ask a short clarification if the request is unclear.",
    ],
    modelFacing: true,
  },
  R_NORMAL_TOOL_WITHOUT_TASK_RUN: {
    code: "R_NORMAL_TOOL_WITHOUT_TASK_RUN",
    severity: "error",
    source: "runner.guard",
    message: "A normal executable action reached the runner before a task run existed.",
    allowedNextActions: [
      "Route the turn to a task before normal tool execution.",
      "Create or activate the correct task if durable work is required.",
    ],
    modelFacing: true,
  },
  R_PENDING_TURN_UNBOUND: {
    code: "R_PENDING_TURN_UNBOUND",
    severity: "repairable",
    source: "runner.pending_turn",
    message: "The current pending turn is not bound to a task.",
    allowedNextActions: [
      "Use git-context read/search tools if needed.",
      "Then call git_context_activate_task_for_turn, git_context_create_task_for_turn, or git_context_ask_clarification_for_turn.",
    ],
    modelFacing: true,
  },
  R_PENDING_TURN_CLARIFYING: {
    code: "R_PENDING_TURN_CLARIFYING",
    severity: "repairable",
    source: "runner.pending_turn",
    message: "The current pending turn is waiting for task clarification.",
    allowedNextActions: [
      "Ask the user directly which task or target they mean.",
      "Do not call executable tools until task ownership is resolved.",
    ],
    modelFacing: true,
  },
  R_TASK_FEEDBACK_UNAVAILABLE: {
    code: "R_TASK_FEEDBACK_UNAVAILABLE",
    severity: "repairable",
    source: "decision.tool_protocol",
    message: "The task feedback tool is not available outside an active task run.",
    allowedNextActions: [
      "Use direct assistant text for pre-task questions and final replies.",
      "Use ask_user_feedback only when it is exposed during an active task run.",
    ],
    modelFacing: true,
  },
  R_MULTIPLE_NATIVE_TOOL_CALLS: {
    code: "R_MULTIPLE_NATIVE_TOOL_CALLS",
    severity: "repairable",
    source: "decision.native_tools",
    message: "The provider response contained multiple native tool calls.",
    allowedNextActions: [
      "Retry with exactly one native tool call.",
    ],
    modelFacing: true,
  },
  R_PARSE_FAILED: {
    code: "R_PARSE_FAILED",
    severity: "repairable",
    source: "decision.parse",
    message: "The model response could not be parsed as a valid decision.",
    allowedNextActions: [
      "Use direct assistant text for a user-facing reply.",
      "Otherwise call exactly one available native tool.",
    ],
    modelFacing: true,
  },
  R_PROVIDER_EMPTY_RESPONSE: {
    code: "R_PROVIDER_EMPTY_RESPONSE",
    severity: "error",
    source: "provider.response",
    message: "The model provider returned no usable assistant message or tool call.",
    allowedNextActions: [
      "Retry the provider request once.",
      "If retry fails, return a clean provider error to the user.",
    ],
    modelFacing: false,
  },
  R_PROVIDER_MALFORMED_RESPONSE: {
    code: "R_PROVIDER_MALFORMED_RESPONSE",
    severity: "error",
    source: "provider.response",
    message: "The model provider returned a malformed response that could not be parsed.",
    allowedNextActions: [
      "Retry the same provider request once.",
      "If retry fails, return a clean provider error to the user.",
    ],
    modelFacing: false,
  },
  R_VERIFICATION_FAILED: {
    code: "R_VERIFICATION_FAILED",
    severity: "repairable",
    source: "runner.verification",
    message: "The tool action ran, but deterministic verification did not pass.",
    allowedNextActions: [
      "Use the latest observations and evidence to correct the concrete failed condition.",
    ],
    modelFacing: true,
  },
  R_NO_PROGRESS: {
    code: "R_NO_PROGRESS",
    severity: "warning",
    source: "runner.progress",
    message: "The recent steps did not move the task forward.",
    allowedNextActions: [
      "Change strategy or stop with a clear failure if no useful next action exists.",
    ],
    modelFacing: true,
  },
  R_DUPLICATE_READ: {
    code: "R_DUPLICATE_READ",
    severity: "repairable",
    source: "runner.read_progress",
    message: "The selected read repeats context that is already available in this task run.",
    allowedNextActions: [
      "Use the existing observations and evidence instead of reading the same target again.",
      "If the user requested a concrete change, call write_file, write_files, or edit_file next.",
      "Ask one specific clarification only if the missing detail blocks the change.",
    ],
    modelFacing: true,
  },
  R_MUTATION_EXPECTED_AFTER_CONTEXT: {
    code: "R_MUTATION_EXPECTED_AFTER_CONTEXT",
    severity: "repairable",
    source: "runner.read_progress",
    message: "This task run has already gathered enough read context before making a change.",
    allowedNextActions: [
      "Use the current observations and evidence to make the requested change.",
      "Call write_file, write_files, or edit_file next when the user asked to build or update files.",
      "Ask one specific clarification if the change cannot be made from the available context.",
    ],
    modelFacing: true,
  },
  R_REPEATED_REPAIR_FAILURE: {
    code: "R_REPEATED_REPAIR_FAILURE",
    severity: "fatal",
    source: "runner.repair_loop",
    message: "The same repair class repeated too many times.",
    allowedNextActions: [
      "Stop the loop with a clean failure instead of retrying again.",
    ],
    modelFacing: false,
  },
};

export function createRepairSignal(code: RepairCode, input: RepairSignalInput = {}): RepairSignal {
  const entry = REPAIR_CODE_CATALOG[code];
  return {
    code,
    severity: input.severity ?? entry.severity,
    source: normalizeText(input.source) ?? entry.source,
    message: normalizeText(input.message) ?? entry.message,
    blockedTargets: compactStrings(input.blockedTargets ?? []),
    missingFields: compactStrings(input.missingFields ?? []),
    invalidFields: compactStrings(input.invalidFields ?? []),
    allowedNextActions: compactStrings(input.allowedNextActions ?? entry.allowedNextActions),
    modelFacing: input.modelFacing ?? entry.modelFacing,
    operatorDetails: input.operatorDetails ? { ...input.operatorDetails } : {},
  };
}

export function repairSignalToPromptCard(signal: RepairSignal): RepairPromptCard | undefined {
  if (!signal.modelFacing) {
    return undefined;
  }
  return {
    code: signal.code,
    message: signal.message,
    ...(signal.blockedTargets.length > 0 ? { blockedTargets: signal.blockedTargets } : {}),
    ...(signal.missingFields.length > 0 ? { missingFields: signal.missingFields } : {}),
    ...(signal.invalidFields.length > 0 ? { invalidFields: signal.invalidFields } : {}),
    allowedNextActions: signal.allowedNextActions,
  };
}

export function repairSignalToFeedbackData(signal: RepairSignal): RepairFeedbackData {
  return {
    repair: {
      code: signal.code,
      severity: signal.severity,
      source: signal.source,
      message: signal.message,
      modelFacing: signal.modelFacing,
      blockedTargets: signal.blockedTargets,
      missingFields: signal.missingFields,
      invalidFields: signal.invalidFields,
      allowedNextActions: signal.allowedNextActions,
      operatorDetails: signal.operatorDetails,
    },
  };
}

export function repairSignalToPromptText(signal: RepairSignal): string | undefined {
  const card = repairSignalToPromptCard(signal);
  if (!card) {
    return undefined;
  }
  const sections = [
    `Repair code: ${card.code}`,
    `Problem: ${card.message}`,
    card.blockedTargets?.length ? `Blocked targets: ${card.blockedTargets.join(", ")}` : "",
    card.missingFields?.length ? `Missing fields: ${card.missingFields.join(", ")}` : "",
    card.invalidFields?.length ? `Invalid fields: ${card.invalidFields.join(", ")}` : "",
    "Allowed next actions:",
    ...card.allowedNextActions.map((action) => `- ${action}`),
  ];
  return sections.filter((section) => section.length > 0).join("\n");
}

function compactStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.replace(/\s+/g, " ").trim()).filter((value) => value.length > 0))];
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
