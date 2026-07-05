import type { ToolDefinition } from "./types.js";

export type ToolEffect =
  | "read_only"
  | "workspace_mutation"
  | "context_mutation"
  | "external_mutation"
  | "destructive";

export type ToolRole =
  | "conversation_read"
  | "enquiry_read"
  | "task_routing"
  | "task_discovery"
  | "task_mutation"
  | "verification"
  | "evidence_access"
  | "command_execution"
  | "long_running_process"
  | "ui_control"
  | "memory_control"
  | "attachment_access"
  | "data_analysis";

export type ToolLifetime =
  | "single_use"
  | "one_step"
  | "phase"
  | "run"
  | "session"
  | "background";

export type ToolPhase =
  | "conversation"
  | "enquiry"
  | "routing"
  | "task_run"
  | "verification"
  | "finalization";

export interface ToolTaxonomyEntry {
  name: string;
  effect: ToolEffect;
  roles: ToolRole[];
  lifetime: ToolLifetime;
  allowedPhases: ToolPhase[];
  requiresTaskRun: boolean;
  canRunBeforeTask: boolean;
  producesEvidence: boolean;
  producesUserArtifact: boolean;
}

export interface ToolTaxonomySummary {
  known: string[];
  unknown: string[];
  effects: Record<ToolEffect, number>;
  roles: Record<ToolRole, number>;
  requiresTaskRun: string[];
  canRunBeforeTask: string[];
  longRunning: string[];
}

type ToolTaxonomyInput = Omit<ToolTaxonomyEntry, "name">;

const READ_ONLY_PHASES: ToolPhase[] = ["conversation", "enquiry", "routing", "task_run"];
const TASK_RUN_ONLY: ToolPhase[] = ["task_run"];
const ROUTING_ONLY: ToolPhase[] = ["routing"];

export const TOOL_TAXONOMY: Readonly<Record<string, ToolTaxonomyEntry>> = buildToolTaxonomy({
  calculator: readOnly(["conversation_read", "enquiry_read"], "one_step", READ_ONLY_PHASES),

  find_files: readOnly(["enquiry_read", "task_discovery"], "phase", ["enquiry", "routing", "task_run"]),
  search_in_files: readOnly(["enquiry_read", "task_discovery"], "phase", ["enquiry", "routing", "task_run"]),
  list_directory: readOnly(["enquiry_read", "task_discovery"], "phase", ["enquiry", "routing", "task_run"]),
  read_file: readOnly(["enquiry_read", "task_discovery", "evidence_access"], "phase", ["enquiry", "routing", "task_run"]),
  read_files: readOnly(["enquiry_read", "task_discovery", "evidence_access"], "one_step", ["enquiry", "routing", "task_run"]),
  write_file: workspaceMutation(["task_mutation"], "one_step"),
  write_files: workspaceMutation(["task_mutation"], "one_step"),
  edit_file: workspaceMutation(["task_mutation"], "one_step"),
  create_directory: workspaceMutation(["task_mutation"], "one_step"),
  move: workspaceMutation(["task_mutation"], "one_step"),
  delete: destructive(["task_mutation"], "one_step"),

  shell: workspaceMutation(["command_execution"], "one_step"),
  shell_run_script: workspaceMutation(["command_execution", "verification"], "one_step"),
  shell_session_start: workspaceMutation(["command_execution", "long_running_process"], "background"),
  shell_session_write: workspaceMutation(["command_execution", "long_running_process"], "background"),
  shell_session_close: workspaceMutation(["command_execution", "long_running_process"], "single_use"),

  db_list_tables: readOnly(["enquiry_read", "data_analysis"], "phase", ["enquiry", "task_run"]),
  db_describe_table: readOnly(["enquiry_read", "data_analysis"], "phase", ["enquiry", "task_run"]),
  db_get_table_ddl: readOnly(["enquiry_read", "data_analysis"], "phase", ["enquiry", "task_run"]),
  db_query: readOnly(["enquiry_read", "data_analysis"], "phase", ["enquiry", "task_run"]),
  db_create_table: workspaceMutation(["task_mutation", "data_analysis"], "one_step"),
  db_rename_table: workspaceMutation(["task_mutation", "data_analysis"], "one_step"),
  db_add_columns: workspaceMutation(["task_mutation", "data_analysis"], "one_step"),
  db_insert_rows: workspaceMutation(["task_mutation", "data_analysis"], "one_step"),
  db_update_rows: workspaceMutation(["task_mutation", "data_analysis"], "one_step"),
  db_delete_rows: destructive(["task_mutation", "data_analysis"], "one_step"),
  db_drop_table: destructive(["task_mutation", "data_analysis"], "one_step"),
  db_execute_sql: workspaceMutation(["task_mutation", "data_analysis"], "one_step"),

  pulse: contextMutation(["task_mutation"], "run", ["task_run"]),

  recall_memory: readOnly(["enquiry_read", "memory_control"], "phase", READ_ONLY_PHASES),
  memory_status: readOnly(["enquiry_read", "memory_control"], "phase", READ_ONLY_PHASES),
  memory_set_episodic_enabled: contextMutation(["memory_control"], "one_step", ["task_run"]),
  memory_search: readOnly(["enquiry_read", "memory_control"], "phase", READ_ONLY_PHASES),
  memory_explain: readOnly(["enquiry_read", "memory_control"], "phase", READ_ONLY_PHASES),
  memory_remember: contextMutation(["memory_control"], "one_step", ["task_run"]),
  memory_forget: contextMutation(["memory_control"], "one_step", ["task_run"]),
  memory_feedback: contextMutation(["memory_control"], "one_step", ["task_run"]),

  attachment_restore: readOnly(["attachment_access", "task_discovery"], "phase", ["routing", "task_run"]),
  restore_attachment_context: readOnly(["attachment_access", "task_discovery"], "phase", ["routing", "task_run"]),
  document_list_sections: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "task_run"]),
  document_read_section: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "task_run"]),
  document_query: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "task_run"]),
  dataset_profile: readOnly(["enquiry_read", "data_analysis", "attachment_access"], "phase", ["enquiry", "task_run"]),
  dataset_query: readOnly(["enquiry_read", "data_analysis", "attachment_access"], "phase", ["enquiry", "task_run"]),
  dataset_promote_table: workspaceMutation(["task_mutation", "data_analysis"], "one_step"),
  python_inspect_dataset: readOnly(["data_analysis", "attachment_access"], "phase", ["enquiry", "task_run"]),
  python_execute: workspaceMutation(["command_execution", "data_analysis"], "one_step"),

  attachment_list: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "routing", "task_run"]),
  attachment_inspect: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "routing", "task_run"]),
  attachment_read: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "routing", "task_run"]),
  attachment_query: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "task_run"]),
  attachment_query_table: readOnly(["enquiry_read", "data_analysis", "attachment_access"], "phase", ["enquiry", "task_run"]),
  directory_search: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "task_run"]),
  file_describe: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "task_run"]),
  file_profile_table: readOnly(["enquiry_read", "data_analysis", "attachment_access"], "phase", ["enquiry", "task_run"]),
  file_query_table: readOnly(["enquiry_read", "data_analysis", "attachment_access"], "phase", ["enquiry", "task_run"]),
  file_read_text: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "task_run"]),
  file_query: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "task_run"]),
  file_register_path: contextMutation(["attachment_access"], "one_step", ["task_run"]),
  file_fetch_url: externalMutation(["attachment_access"], "one_step", ["task_run"]),
  file_register_artifact: contextMutation(["attachment_access"], "one_step", ["task_run"]),

  git_context_list_sessions: readOnly(["enquiry_read"], "phase", ["enquiry", "routing", "task_run"]),
  git_context_active: readOnly(["enquiry_read", "task_routing"], "phase", ["enquiry", "routing", "task_run"]),
  git_context_list_tasks: readOnly(["enquiry_read", "task_routing"], "phase", ["enquiry", "routing", "task_run"]),
  git_context_search_tasks: readOnly(["enquiry_read", "task_routing"], "phase", ["enquiry", "routing", "task_run"]),
  git_context_read_task: readOnly(["enquiry_read", "task_routing"], "phase", ["enquiry", "routing", "task_run"]),
  git_context_read_evidence: readOnly(["enquiry_read", "evidence_access"], "phase", ["enquiry", "task_run"]),
  git_context_search_evidence: readOnly(["enquiry_read", "evidence_access"], "phase", ["enquiry", "task_run"]),
  git_context_log: readOnly(["enquiry_read"], "phase", ["enquiry", "task_run"]),
  git_context_activate_task_for_turn: contextMutation(["task_routing"], "single_use", ROUTING_ONLY),
  git_context_create_task_for_turn: contextMutation(["task_routing"], "single_use", ROUTING_ONLY),
  git_context_ask_clarification_for_turn: contextMutation(["task_routing"], "single_use", ROUTING_ONLY),

  workspace_get_state: readOnly(["enquiry_read", "ui_control"], "phase", ["enquiry", "task_run"]),
  workspace_set_layout: workspaceMutation(["ui_control"], "one_step"),
  workspace_focus_window: workspaceMutation(["ui_control"], "one_step"),
  workspace_register_window: contextMutation(["ui_control"], "one_step", ["task_run"]),
  workspace_reuse_or_open_window: workspaceMutation(["ui_control"], "one_step"),
  workspace_close_window: destructive(["ui_control"], "one_step"),
  workspace_cleanup_unused: destructive(["ui_control"], "one_step"),
});

export function getToolTaxonomy(toolName: string): ToolTaxonomyEntry | undefined {
  return TOOL_TAXONOMY[toolName];
}

export function requireToolTaxonomy(toolName: string): ToolTaxonomyEntry {
  const entry = getToolTaxonomy(toolName);
  if (!entry) {
    throw new Error(`Missing tool taxonomy for '${toolName}'.`);
  }
  return entry;
}

export function isReadOnlyTool(toolName: string): boolean {
  return getToolTaxonomy(toolName)?.effect === "read_only";
}

export function isMutationTool(toolName: string): boolean {
  const effect = getToolTaxonomy(toolName)?.effect;
  return effect === "workspace_mutation"
    || effect === "context_mutation"
    || effect === "external_mutation"
    || effect === "destructive";
}

export function isRoutingTool(toolName: string): boolean {
  return getToolTaxonomy(toolName)?.roles.includes("task_routing") ?? false;
}

export function requiresTaskRun(toolName: string): boolean {
  return getToolTaxonomy(toolName)?.requiresTaskRun ?? false;
}

export function canRunBeforeTask(toolName: string): boolean {
  return getToolTaxonomy(toolName)?.canRunBeforeTask ?? false;
}

export function isToolAllowedInPhase(toolName: string, phase: ToolPhase): boolean {
  return getToolTaxonomy(toolName)?.allowedPhases.includes(phase) ?? false;
}

export function missingToolTaxonomy(tools: ToolDefinition[]): string[] {
  return tools
    .map((tool) => tool.name)
    .filter((name) => !getToolTaxonomy(name))
    .sort();
}

export function summarizeToolTaxonomy(toolNames: string[]): ToolTaxonomySummary {
  const known: string[] = [];
  const unknown: string[] = [];
  const effects = zeroRecord(["read_only", "workspace_mutation", "context_mutation", "external_mutation", "destructive"] as const);
  const roles = zeroRecord([
    "conversation_read",
    "enquiry_read",
    "task_routing",
    "task_discovery",
    "task_mutation",
    "verification",
    "evidence_access",
    "command_execution",
    "long_running_process",
    "ui_control",
    "memory_control",
    "attachment_access",
    "data_analysis",
  ] as const);
  const requiresRun: string[] = [];
  const beforeTask: string[] = [];
  const longRunning: string[] = [];

  for (const name of toolNames) {
    const entry = getToolTaxonomy(name);
    if (!entry) {
      unknown.push(name);
      continue;
    }
    known.push(name);
    effects[entry.effect]++;
    for (const role of entry.roles) {
      roles[role]++;
    }
    if (entry.requiresTaskRun) {
      requiresRun.push(name);
    }
    if (entry.canRunBeforeTask) {
      beforeTask.push(name);
    }
    if (entry.lifetime === "background" || entry.roles.includes("long_running_process")) {
      longRunning.push(name);
    }
  }

  return {
    known,
    unknown,
    effects,
    roles,
    requiresTaskRun: requiresRun,
    canRunBeforeTask: beforeTask,
    longRunning,
  };
}

function buildToolTaxonomy(input: Record<string, ToolTaxonomyInput>): Record<string, ToolTaxonomyEntry> {
  const entries: Record<string, ToolTaxonomyEntry> = {};
  for (const [name, entry] of Object.entries(input)) {
    entries[name] = {
      name,
      ...entry,
    };
  }
  return entries;
}

function readOnly(roles: ToolRole[], lifetime: ToolLifetime, allowedPhases: ToolPhase[]): ToolTaxonomyInput {
  return {
    effect: "read_only",
    roles,
    lifetime,
    allowedPhases,
    requiresTaskRun: false,
    canRunBeforeTask: true,
    producesEvidence: roles.some((role) => role === "task_discovery" || role === "evidence_access" || role === "enquiry_read"),
    producesUserArtifact: false,
  };
}

function workspaceMutation(roles: ToolRole[], lifetime: ToolLifetime): ToolTaxonomyInput {
  return {
    effect: "workspace_mutation",
    roles,
    lifetime,
    allowedPhases: TASK_RUN_ONLY,
    requiresTaskRun: true,
    canRunBeforeTask: false,
    producesEvidence: true,
    producesUserArtifact: roles.includes("task_mutation"),
  };
}

function contextMutation(roles: ToolRole[], lifetime: ToolLifetime, allowedPhases: ToolPhase[]): ToolTaxonomyInput {
  return {
    effect: "context_mutation",
    roles,
    lifetime,
    allowedPhases,
    requiresTaskRun: !allowedPhases.includes("routing"),
    canRunBeforeTask: allowedPhases.includes("routing"),
    producesEvidence: true,
    producesUserArtifact: false,
  };
}

function externalMutation(roles: ToolRole[], lifetime: ToolLifetime, allowedPhases: ToolPhase[]): ToolTaxonomyInput {
  return {
    effect: "external_mutation",
    roles,
    lifetime,
    allowedPhases,
    requiresTaskRun: true,
    canRunBeforeTask: false,
    producesEvidence: true,
    producesUserArtifact: false,
  };
}

function destructive(roles: ToolRole[], lifetime: ToolLifetime): ToolTaxonomyInput {
  return {
    effect: "destructive",
    roles,
    lifetime,
    allowedPhases: TASK_RUN_ONLY,
    requiresTaskRun: true,
    canRunBeforeTask: false,
    producesEvidence: true,
    producesUserArtifact: false,
  };
}

function zeroRecord<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}
