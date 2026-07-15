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
  loadGroups: string[];
  loadPriority: number;
  nextOnSuccess: string[];
  nextOnFailure: string[];
}

export interface ToolTaxonomySummary {
  known: string[];
  unknown: string[];
  effects: Record<ToolEffect, number>;
  roles: Record<ToolRole, number>;
  requiresTaskRun: string[];
  canRunBeforeTask: string[];
  longRunning: string[];
  lifetimes: Record<ToolLifetime, number>;
}

type ToolTaxonomyInput = Omit<ToolTaxonomyEntry, "name" | "loadGroups" | "loadPriority" | "nextOnSuccess" | "nextOnFailure"> & {
  loadGroups?: string[];
  loadPriority?: number;
  nextOnSuccess?: string[];
  nextOnFailure?: string[];
};

const READ_ONLY_PHASES: ToolPhase[] = ["conversation", "enquiry", "routing", "task_run"];
const TASK_RUN_ONLY: ToolPhase[] = ["task_run"];
const ROUTING_ONLY: ToolPhase[] = ["routing"];

export const TOOL_TAXONOMY: Readonly<Record<string, ToolTaxonomyEntry>> = buildToolTaxonomy({
  calculator: readOnly(["conversation_read", "enquiry_read"], "one_step", READ_ONLY_PHASES, {
    loadGroups: ["utility:calculator"],
  }),

  find_files: readOnly(["enquiry_read", "task_discovery"], "one_step", ["enquiry", "routing", "task_run"], {
    loadGroups: ["file:read", "file:search", "file:refactor"],
    nextOnSuccess: ["inspect_paths", "read_files", "patch_files", "write_files"],
    nextOnFailure: ["list_directory", "search_in_files"],
  }),
  inspect_paths: readOnly(["enquiry_read", "task_discovery"], "run", ["enquiry", "routing", "task_run"], {
    loadGroups: ["file:read", "file:search", "file:verify", "file:refactor"],
    nextOnSuccess: ["read_files", "search_in_files", "list_directory"],
    nextOnFailure: ["find_files", "list_directory"],
  }),
  search_in_files: readOnly(["enquiry_read", "task_discovery"], "run", ["enquiry", "routing", "task_run"], {
    loadGroups: ["file:read", "file:search", "file:refactor", "file:verify"],
    nextOnSuccess: ["inspect_paths", "read_files", "patch_files"],
    nextOnFailure: ["find_files", "list_directory"],
  }),
  list_directory: readOnly(["enquiry_read", "task_discovery"], "run", ["enquiry", "routing", "task_run"], {
    loadGroups: ["file:read", "file:create"],
  }),
  read_files: readOnly(["enquiry_read", "task_discovery", "evidence_access"], "run", ["enquiry", "routing", "task_run"], {
    loadGroups: ["file:read", "file:verify", "file:refactor"],
    nextOnSuccess: ["patch_files", "write_files", "search_in_files"],
    nextOnFailure: ["find_files", "list_directory"],
  }),
  write_files: workspaceMutation(["task_mutation"], "run", TASK_RUN_ONLY, {
    loadGroups: ["file:write", "file:create", "file:refactor"],
    nextOnSuccess: ["read_files", "shell_run_script"],
    nextOnFailure: ["create_directory", "write_files"],
  }),
  patch_files: workspaceMutation(["task_mutation"], "run", TASK_RUN_ONLY, {
    loadGroups: ["file:write", "file:refactor"],
    nextOnSuccess: ["read_files", "shell_run_script"],
    nextOnFailure: ["read_files", "search_in_files", "write_files"],
  }),
  create_directory: workspaceMutation(["task_mutation"], "one_step", TASK_RUN_ONLY, {
    loadGroups: ["file:create"],
  }),
  move: workspaceMutation(["task_mutation"], "one_step", TASK_RUN_ONLY, {
    loadGroups: ["file:move-delete"],
  }),
  delete: destructive(["task_mutation"], "one_step", TASK_RUN_ONLY, {
    loadGroups: ["file:move-delete"],
  }),

  shell: workspaceMutation(["command_execution"], "run", TASK_RUN_ONLY, {
    loadGroups: ["shell:command"],
    nextOnSuccess: ["search_in_files", "read_files"],
    nextOnFailure: ["search_in_files", "read_files"],
  }),
  shell_run_script: workspaceMutation(["command_execution", "verification"], "run", TASK_RUN_ONLY, {
    loadGroups: ["shell:command", "file:verify"],
    nextOnSuccess: ["search_in_files", "read_files"],
    nextOnFailure: ["search_in_files", "read_files"],
  }),
  shell_session_start: workspaceMutation(["command_execution", "long_running_process"], "background"),
  shell_session_write: workspaceMutation(["command_execution", "long_running_process"], "background"),
  shell_session_close: workspaceMutation(["command_execution", "long_running_process"], "single_use", TASK_RUN_ONLY, {
    loadGroups: ["shell:session"],
  }),

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

  attachment_restore: readOnly(["attachment_access", "task_discovery"], "phase", ["routing", "task_run"], {
    loadGroups: ["attachment:basic"],
    nextOnSuccess: ["attachment_list", "attachment_read", "document_query", "dataset_profile"],
    nextOnFailure: ["attachment_list"],
  }),
  restore_attachment_context: readOnly(["attachment_access", "task_discovery"], "phase", ["routing", "task_run"], {
    loadGroups: ["attachment:basic"],
    nextOnSuccess: ["attachment_list", "attachment_read", "document_query", "dataset_profile"],
    nextOnFailure: ["attachment_list"],
  }),
  document_list_sections: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "task_run"], {
    loadGroups: ["document:qa"],
    nextOnSuccess: ["document_read_section", "document_query"],
    nextOnFailure: ["attachment_query"],
  }),
  document_read_section: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "task_run"], {
    loadGroups: ["document:qa"],
  }),
  document_query: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "task_run"], {
    loadGroups: ["document:qa"],
    nextOnSuccess: ["document_read_section"],
    nextOnFailure: ["document_list_sections", "attachment_query"],
  }),
  dataset_profile: readOnly(["enquiry_read", "data_analysis", "attachment_access"], "phase", ["enquiry", "task_run"], {
    loadGroups: ["data:inspect"],
    nextOnSuccess: ["dataset_query", "python_execute"],
    nextOnFailure: ["attachment_query_table", "file_profile_table"],
  }),
  dataset_query: readOnly(["enquiry_read", "data_analysis", "attachment_access"], "phase", ["enquiry", "task_run"], {
    loadGroups: ["data:inspect"],
    nextOnSuccess: ["python_execute"],
    nextOnFailure: ["dataset_profile", "file_query_table"],
  }),
  dataset_promote_table: workspaceMutation(["task_mutation", "data_analysis"], "one_step"),
  python_inspect_dataset: readOnly(["data_analysis", "attachment_access"], "phase", ["enquiry", "task_run"], {
    loadGroups: ["data:inspect"],
    nextOnSuccess: ["python_execute"],
    nextOnFailure: ["dataset_profile"],
  }),
  python_execute: workspaceMutation(["command_execution", "data_analysis"], "one_step", TASK_RUN_ONLY, {
    loadGroups: ["data:execute"],
  }),

  attachment_list: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "routing", "task_run"], { loadGroups: ["attachment:basic"] }),
  attachment_inspect: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "routing", "task_run"], { loadGroups: ["attachment:basic"] }),
  attachment_read: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "routing", "task_run"], { loadGroups: ["attachment:basic"] }),
  attachment_query: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "task_run"], { loadGroups: ["attachment:basic"] }),
  attachment_query_table: readOnly(["enquiry_read", "data_analysis", "attachment_access"], "phase", ["enquiry", "task_run"], { loadGroups: ["attachment:basic", "data:inspect"] }),
  directory_search: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "task_run"], { loadGroups: ["attachment:basic"] }),
  file_describe: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "task_run"], { loadGroups: ["attachment:basic"] }),
  file_profile_table: readOnly(["enquiry_read", "data_analysis", "attachment_access"], "phase", ["enquiry", "task_run"], { loadGroups: ["attachment:basic", "data:inspect"] }),
  file_query_table: readOnly(["enquiry_read", "data_analysis", "attachment_access"], "phase", ["enquiry", "task_run"], { loadGroups: ["attachment:basic", "data:inspect"] }),
  file_read_text: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "task_run"], { loadGroups: ["attachment:basic"] }),
  file_query: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "task_run"], { loadGroups: ["attachment:basic"] }),
  file_register_path: contextMutation(["attachment_access"], "one_step", ["task_run"]),
  file_fetch_url: externalMutation(["attachment_access"], "one_step", ["task_run"]),
  file_register_artifact: contextMutation(["attachment_access"], "one_step", ["task_run"]),

  git_context_activate_task: contextMutation(["task_routing"], "single_use", ROUTING_ONLY, { loadGroups: ["task:routing"] }),
  git_context_create_task: contextMutation(["task_routing"], "single_use", ROUTING_ONLY, { loadGroups: ["task:routing"] }),

  workspace_get_state: readOnly(["enquiry_read", "ui_control"], "phase", ["enquiry", "task_run"], { loadGroups: ["ui:workspace"] }),
  workspace_set_layout: workspaceMutation(["ui_control"], "one_step", TASK_RUN_ONLY, { loadGroups: ["ui:workspace"] }),
  workspace_focus_window: workspaceMutation(["ui_control"], "one_step", TASK_RUN_ONLY, { loadGroups: ["ui:workspace"] }),
  workspace_register_window: contextMutation(["ui_control"], "one_step", ["task_run"], { loadGroups: ["ui:workspace"] }),
  workspace_reuse_or_open_window: workspaceMutation(["ui_control"], "one_step", TASK_RUN_ONLY, { loadGroups: ["ui:workspace"] }),
  workspace_close_window: destructive(["ui_control"], "one_step", TASK_RUN_ONLY, { loadGroups: ["ui:workspace"] }),
  workspace_cleanup_unused: destructive(["ui_control"], "one_step", TASK_RUN_ONLY, { loadGroups: ["ui:workspace"] }),
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

export function getToolLoadGroups(toolName: string): string[] {
  return getToolTaxonomy(toolName)?.loadGroups ?? [];
}

export function getToolLoadPriority(toolName: string): number | undefined {
  return getToolTaxonomy(toolName)?.loadPriority;
}

export function getToolNextOnSuccess(toolName: string): string[] {
  return getToolTaxonomy(toolName)?.nextOnSuccess ?? [];
}

export function getToolNextOnFailure(toolName: string): string[] {
  return getToolTaxonomy(toolName)?.nextOnFailure ?? [];
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
  const lifetimes = zeroRecord(["single_use", "one_step", "phase", "run", "session", "background"] as const);

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
    lifetimes[entry.lifetime]++;
  }

  return {
    known,
    unknown,
    effects,
    roles,
    requiresTaskRun: requiresRun,
    canRunBeforeTask: beforeTask,
    longRunning,
    lifetimes,
  };
}

function buildToolTaxonomy(input: Record<string, ToolTaxonomyInput>): Record<string, ToolTaxonomyEntry> {
  const entries: Record<string, ToolTaxonomyEntry> = {};
  for (const [name, entry] of Object.entries(input)) {
    entries[name] = {
      name,
      ...entry,
      loadGroups: normalizeStrings([
        ...(entry.loadGroups ?? []),
        ...defaultLoadGroups(name, entry),
      ]),
      loadPriority: entry.loadPriority ?? defaultLoadPriority(entry),
      nextOnSuccess: normalizeStrings(entry.nextOnSuccess ?? []),
      nextOnFailure: normalizeStrings(entry.nextOnFailure ?? []),
    };
  }
  return entries;
}

function readOnly(
  roles: ToolRole[],
  lifetime: ToolLifetime,
  allowedPhases: ToolPhase[],
  options: Partial<Pick<ToolTaxonomyInput, "loadGroups" | "loadPriority" | "nextOnSuccess" | "nextOnFailure">> = {},
): ToolTaxonomyInput {
  return {
    effect: "read_only",
    roles,
    lifetime,
    allowedPhases,
    requiresTaskRun: false,
    canRunBeforeTask: true,
    producesEvidence: roles.some((role) => role === "task_discovery" || role === "evidence_access" || role === "enquiry_read"),
    producesUserArtifact: false,
    ...options,
  };
}

function workspaceMutation(
  roles: ToolRole[],
  lifetime: ToolLifetime,
  allowedPhases: ToolPhase[] = TASK_RUN_ONLY,
  options: Partial<Pick<ToolTaxonomyInput, "loadGroups" | "loadPriority" | "nextOnSuccess" | "nextOnFailure">> = {},
): ToolTaxonomyInput {
  return {
    effect: "workspace_mutation",
    roles,
    lifetime,
    allowedPhases,
    requiresTaskRun: true,
    canRunBeforeTask: false,
    producesEvidence: true,
    producesUserArtifact: roles.includes("task_mutation"),
    ...options,
  };
}

function contextMutation(
  roles: ToolRole[],
  lifetime: ToolLifetime,
  allowedPhases: ToolPhase[],
  options: Partial<Pick<ToolTaxonomyInput, "loadGroups" | "loadPriority" | "nextOnSuccess" | "nextOnFailure">> = {},
): ToolTaxonomyInput {
  return {
    effect: "context_mutation",
    roles,
    lifetime,
    allowedPhases,
    requiresTaskRun: !allowedPhases.includes("routing"),
    canRunBeforeTask: allowedPhases.includes("routing"),
    producesEvidence: true,
    producesUserArtifact: false,
    ...options,
  };
}

function externalMutation(
  roles: ToolRole[],
  lifetime: ToolLifetime,
  allowedPhases: ToolPhase[],
  options: Partial<Pick<ToolTaxonomyInput, "loadGroups" | "loadPriority" | "nextOnSuccess" | "nextOnFailure">> = {},
): ToolTaxonomyInput {
  return {
    effect: "external_mutation",
    roles,
    lifetime,
    allowedPhases,
    requiresTaskRun: true,
    canRunBeforeTask: false,
    producesEvidence: true,
    producesUserArtifact: false,
    ...options,
  };
}

function destructive(
  roles: ToolRole[],
  lifetime: ToolLifetime,
  allowedPhases: ToolPhase[] = TASK_RUN_ONLY,
  options: Partial<Pick<ToolTaxonomyInput, "loadGroups" | "loadPriority" | "nextOnSuccess" | "nextOnFailure">> = {},
): ToolTaxonomyInput {
  return {
    effect: "destructive",
    roles,
    lifetime,
    allowedPhases,
    requiresTaskRun: true,
    canRunBeforeTask: false,
    producesEvidence: true,
    producesUserArtifact: false,
    ...options,
  };
}

function defaultLoadGroups(name: string, entry: ToolTaxonomyInput): string[] {
  const groups: string[] = [];
  if (entry.roles.includes("memory_control")) groups.push("memory:control");
  if (entry.roles.includes("data_analysis")) groups.push(entry.effect === "read_only" ? "data:inspect" : "data:execute");
  if (entry.effect === "destructive") groups.push("tool:risky");
  if (entry.effect === "external_mutation") groups.push("tool:external");
  if (entry.roles.includes("long_running_process")) groups.push("shell:session");
  if (name.startsWith("db_")) groups.push(entry.effect === "read_only" ? "database:read" : "database:write");
  if (name === "pulse") groups.push("pulse:control");
  return groups;
}

function defaultLoadPriority(entry: ToolTaxonomyInput): number {
  if (entry.roles.includes("task_routing")) return 100;
  if (entry.roles.includes("task_mutation") && entry.lifetime === "run") return 90;
  if (entry.roles.includes("task_discovery") && entry.lifetime === "run") return 85;
  if (entry.lifetime === "run") return 80;
  if (entry.lifetime === "background") return 75;
  if (entry.lifetime === "phase") return 60;
  if (entry.lifetime === "session") return 55;
  if (entry.lifetime === "one_step") return 40;
  return 35;
}

function normalizeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function zeroRecord<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}
