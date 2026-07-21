import type { ToolDefinition } from "./types.js";

export type ToolPurpose = "list" | "read" | "search" | "control" | "mutation";

export type ToolEffect =
  | "read_only"
  | "workspace_mutation"
  | "context_mutation"
  | "external_mutation"
  | "destructive";

export type ToolRole =
  | "conversation_read"
  | "enquiry_read"
  | "workstream_routing"
  | "workstream_discovery"
  | "workstream_preference"
  | "workstream_mutation"
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
  | "workstream_bound"
  | "verification"
  | "finalization";

export interface ToolTaxonomyEntry {
  name: string;
  purpose: ToolPurpose;
  effect: ToolEffect;
  roles: ToolRole[];
  lifetime: ToolLifetime;
  allowedPhases: ToolPhase[];
  requiresWorkstreamBinding: boolean;
  canRunBeforeWorkstream: boolean;
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
  purposes: Record<ToolPurpose, number>;
  effects: Record<ToolEffect, number>;
  roles: Record<ToolRole, number>;
  requiresWorkstreamBinding: string[];
  canRunBeforeWorkstream: string[];
  longRunning: string[];
  lifetimes: Record<ToolLifetime, number>;
}

type ToolTaxonomyInput = Omit<ToolTaxonomyEntry, "name" | "loadGroups" | "loadPriority" | "nextOnSuccess" | "nextOnFailure"> & {
  loadGroups?: string[];
  loadPriority?: number;
  nextOnSuccess?: string[];
  nextOnFailure?: string[];
};

const READ_ONLY_PHASES: ToolPhase[] = ["conversation", "enquiry", "routing", "workstream_bound"];
const WORKSTREAM_BOUND_ONLY: ToolPhase[] = ["workstream_bound"];
const ROUTING_ONLY: ToolPhase[] = ["routing"];

export const NATIVE_CONTROL_TOOL_NAMES = [
  "decision_load_tools",
  "workstream_resolve",
  "ask_user_feedback",
  "workstream_completion",
] as const;

const NATIVE_CONTROL_TOOLS = new Set<string>(NATIVE_CONTROL_TOOL_NAMES);

export const TOOL_TAXONOMY: Readonly<Record<string, ToolTaxonomyEntry>> = buildToolTaxonomy({
  calculator: readOnly(["conversation_read", "enquiry_read"], "one_step", READ_ONLY_PHASES, {
    loadGroups: ["utility:calculator"],
  }),

  find_files: search(["enquiry_read", "workstream_discovery"], "one_step", ["enquiry", "routing", "workstream_bound"], {
    loadGroups: ["file:read", "file:search", "file:refactor"],
    nextOnSuccess: ["inspect_paths", "read_files", "patch_files", "write_files"],
    nextOnFailure: ["list_directory", "search_in_files"],
  }),
  inspect_paths: readOnly(["enquiry_read", "workstream_discovery"], "run", ["enquiry", "routing", "workstream_bound"], {
    loadGroups: ["file:read", "file:search", "file:verify", "file:refactor"],
    nextOnSuccess: ["read_files", "search_in_files", "list_directory"],
    nextOnFailure: ["find_files", "list_directory"],
  }),
  search_in_files: search(["enquiry_read", "workstream_discovery"], "run", ["enquiry", "routing", "workstream_bound"], {
    loadGroups: ["file:read", "file:search", "file:refactor", "file:verify"],
    nextOnSuccess: ["inspect_paths", "read_files", "patch_files"],
    nextOnFailure: ["find_files", "list_directory"],
  }),
  list_directory: list(["enquiry_read", "workstream_discovery"], "run", ["enquiry", "routing", "workstream_bound"], {
    loadGroups: ["file:read", "file:create"],
  }),
  read_files: readOnly(["enquiry_read", "workstream_discovery", "evidence_access"], "run", ["enquiry", "routing", "workstream_bound"], {
    loadGroups: ["file:read", "file:verify", "file:refactor"],
    nextOnSuccess: ["patch_files", "write_files", "search_in_files"],
    nextOnFailure: ["find_files", "list_directory"],
  }),
  write_files: workspaceMutation(["workstream_mutation"], "run", WORKSTREAM_BOUND_ONLY, {
    loadGroups: ["file:write", "file:create", "file:refactor"],
    nextOnSuccess: ["read_files", "process_run"],
    nextOnFailure: ["create_directory", "write_files"],
  }),
  patch_files: workspaceMutation(["workstream_mutation"], "run", WORKSTREAM_BOUND_ONLY, {
    loadGroups: ["file:write", "file:refactor"],
    nextOnSuccess: ["read_files", "process_run"],
    nextOnFailure: ["read_files", "search_in_files", "write_files"],
  }),
  create_directory: workspaceMutation(["workstream_mutation"], "one_step", WORKSTREAM_BOUND_ONLY, {
    loadGroups: ["file:create"],
  }),
  move: workspaceMutation(["workstream_mutation"], "one_step", WORKSTREAM_BOUND_ONLY, {
    loadGroups: ["file:move-delete"],
  }),
  delete: destructive(["workstream_mutation"], "one_step", WORKSTREAM_BOUND_ONLY, {
    loadGroups: ["file:move-delete"],
  }),

  process_run: workspaceMutation(["command_execution", "verification"], "run", WORKSTREAM_BOUND_ONLY, {
    loadGroups: ["process:command", "file:verify"],
    nextOnSuccess: ["search_in_files", "read_files"],
    nextOnFailure: ["search_in_files", "read_files"],
  }),
  process_start: workspaceMutation(["command_execution", "long_running_process"], "background", WORKSTREAM_BOUND_ONLY, {
    loadGroups: ["process:session"],
  }),
  process_poll: control(["evidence_access", "long_running_process"], "background", WORKSTREAM_BOUND_ONLY, {
    loadGroups: ["process:session"],
  }),
  process_send_input: workspaceMutation(["command_execution", "long_running_process"], "background", WORKSTREAM_BOUND_ONLY, {
    loadGroups: ["process:session"],
  }),
  process_stop: control(["command_execution", "long_running_process"], "single_use", WORKSTREAM_BOUND_ONLY, {
    loadGroups: ["process:session"],
  }),

  db_list_tables: search(["enquiry_read", "data_analysis"], "phase", ["enquiry", "workstream_bound"]),
  db_describe_table: readOnly(["enquiry_read", "data_analysis"], "phase", ["enquiry", "workstream_bound"]),
  db_get_table_ddl: readOnly(["enquiry_read", "data_analysis"], "phase", ["enquiry", "workstream_bound"]),
  db_query: readOnly(["enquiry_read", "data_analysis"], "phase", ["enquiry", "workstream_bound"]),
  db_create_table: workspaceMutation(["workstream_mutation", "data_analysis"], "one_step"),
  db_rename_table: workspaceMutation(["workstream_mutation", "data_analysis"], "one_step"),
  db_add_columns: workspaceMutation(["workstream_mutation", "data_analysis"], "one_step"),
  db_insert_rows: workspaceMutation(["workstream_mutation", "data_analysis"], "one_step"),
  db_update_rows: workspaceMutation(["workstream_mutation", "data_analysis"], "one_step"),
  db_delete_rows: destructive(["workstream_mutation", "data_analysis"], "one_step"),
  db_drop_table: destructive(["workstream_mutation", "data_analysis"], "one_step"),
  db_execute_sql: workspaceMutation(["workstream_mutation", "data_analysis"], "one_step"),

  pulse: contextMutation(["workstream_mutation"], "run", ["workstream_bound"]),

  recall_memory: search(["enquiry_read", "memory_control"], "phase", READ_ONLY_PHASES),
  memory_status: readOnly(["enquiry_read", "memory_control"], "phase", READ_ONLY_PHASES),
  memory_set_episodic_enabled: control(["memory_control"], "one_step", ["workstream_bound"]),
  memory_search: search(["enquiry_read", "memory_control"], "phase", READ_ONLY_PHASES),
  memory_explain: readOnly(["enquiry_read", "memory_control"], "phase", READ_ONLY_PHASES),
  memory_remember: contextMutation(["memory_control"], "one_step", ["workstream_bound"]),
  memory_forget: contextMutation(["memory_control"], "one_step", ["workstream_bound"]),
  memory_feedback: contextMutation(["memory_control"], "one_step", ["workstream_bound"]),

  attachment_restore: control(["attachment_access", "workstream_discovery"], "phase", ["routing", "workstream_bound"], {
    loadGroups: ["attachment:basic"],
    nextOnSuccess: ["attachment_list", "attachment_read", "document_query", "dataset_profile"],
    nextOnFailure: ["attachment_list"],
  }),
  document_list_sections: search(["enquiry_read", "attachment_access"], "phase", ["enquiry", "workstream_bound"], {
    loadGroups: ["document:qa"],
    nextOnSuccess: ["document_read_section", "document_query"],
    nextOnFailure: ["attachment_query"],
  }),
  document_read_section: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "workstream_bound"], {
    loadGroups: ["document:qa"],
  }),
  document_query: search(["enquiry_read", "attachment_access"], "phase", ["enquiry", "workstream_bound"], {
    loadGroups: ["document:qa"],
    nextOnSuccess: ["document_read_section"],
    nextOnFailure: ["document_list_sections", "attachment_query"],
  }),
  dataset_profile: readOnly(["enquiry_read", "data_analysis", "attachment_access"], "phase", ["enquiry", "workstream_bound"], {
    loadGroups: ["data:inspect"],
    nextOnSuccess: ["dataset_query", "python_execute"],
    nextOnFailure: ["attachment_query_table", "file_profile_table"],
  }),
  dataset_query: search(["enquiry_read", "data_analysis", "attachment_access"], "phase", ["enquiry", "workstream_bound"], {
    loadGroups: ["data:inspect"],
    nextOnSuccess: ["python_execute"],
    nextOnFailure: ["dataset_profile", "file_query_table"],
  }),
  dataset_promote_table: workspaceMutation(["workstream_mutation", "data_analysis"], "one_step"),
  python_inspect_dataset: readOnly(["data_analysis", "attachment_access"], "phase", ["enquiry", "workstream_bound"], {
    loadGroups: ["data:inspect"],
    nextOnSuccess: ["python_execute"],
    nextOnFailure: ["dataset_profile"],
  }),
  python_execute: workspaceMutation(["command_execution", "data_analysis"], "one_step", WORKSTREAM_BOUND_ONLY, {
    loadGroups: ["data:execute"],
  }),

  attachment_list: search(["enquiry_read", "attachment_access"], "phase", ["enquiry", "routing", "workstream_bound"], { loadGroups: ["attachment:basic"] }),
  attachment_inspect: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "routing", "workstream_bound"], { loadGroups: ["attachment:basic"] }),
  attachment_read: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "routing", "workstream_bound"], { loadGroups: ["attachment:basic"] }),
  attachment_query: search(["enquiry_read", "attachment_access"], "phase", ["enquiry", "workstream_bound"], { loadGroups: ["attachment:basic"] }),
  attachment_query_table: search(["enquiry_read", "data_analysis", "attachment_access"], "phase", ["enquiry", "workstream_bound"], { loadGroups: ["attachment:basic", "data:inspect"] }),
  directory_search: search(["enquiry_read", "attachment_access"], "phase", ["enquiry", "workstream_bound"], { loadGroups: ["attachment:basic"] }),
  file_describe: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "workstream_bound"], { loadGroups: ["attachment:basic"] }),
  file_profile_table: readOnly(["enquiry_read", "data_analysis", "attachment_access"], "phase", ["enquiry", "workstream_bound"], { loadGroups: ["attachment:basic", "data:inspect"] }),
  file_query_table: search(["enquiry_read", "data_analysis", "attachment_access"], "phase", ["enquiry", "workstream_bound"], { loadGroups: ["attachment:basic", "data:inspect"] }),
  file_read_text: readOnly(["enquiry_read", "attachment_access"], "phase", ["enquiry", "workstream_bound"], { loadGroups: ["attachment:basic"] }),
  file_query: search(["enquiry_read", "attachment_access"], "phase", ["enquiry", "workstream_bound"], { loadGroups: ["attachment:basic"] }),
  file_register_path: control(["attachment_access"], "one_step", ["workstream_bound"]),
  file_fetch_url: externalMutation(["attachment_access"], "one_step", ["workstream_bound"]),
  file_register_artifact: control(["attachment_access"], "one_step", ["workstream_bound"]),

  git_context_activate_workstream: control(["workstream_routing"], "single_use", ROUTING_ONLY, { loadGroups: ["workstream:routing"] }),
  git_context_create_workstream: control(["workstream_routing"], "single_use", ROUTING_ONLY, { loadGroups: ["workstream:routing"] }),
  git_context_find_workstreams: search(["enquiry_read", "workstream_discovery"], "run", READ_ONLY_PHASES, { loadGroups: ["workstream:discovery"] }),
  git_context_read_workstream: readOnly(["enquiry_read", "workstream_discovery", "evidence_access"], "run", READ_ONLY_PHASES, { loadGroups: ["workstream:discovery"] }),
  git_context_find_resources: search(["enquiry_read", "workstream_discovery", "evidence_access"], "run", READ_ONLY_PHASES, { loadGroups: ["resource:discovery"] }),
  git_context_inspect_resource: control(["workstream_routing"], "one_step", ["routing"], { loadGroups: ["resource:discovery"] }),
  git_context_bind_resources: control(["workstream_mutation"], "one_step", ["workstream_bound"], { loadGroups: ["resource:binding"] }),
  git_context_set_workstream_star: control(["workstream_preference"], "one_step", ["routing", "workstream_bound"], { loadGroups: ["workstream:preferences"] }),
  agent_history_search: search(["conversation_read", "enquiry_read", "evidence_access"], "run", READ_ONLY_PHASES, { loadGroups: ["agent-history"] }),
  agent_history_read: readOnly(["conversation_read", "enquiry_read", "evidence_access"], "run", READ_ONLY_PHASES, { loadGroups: ["agent-history"] }),

  workspace_get_state: readOnly(["enquiry_read", "ui_control"], "phase", ["enquiry", "workstream_bound"], { loadGroups: ["ui:workspace"] }),
  workspace_set_layout: workspaceMutation(["ui_control"], "one_step", WORKSTREAM_BOUND_ONLY, { loadGroups: ["ui:workspace"] }),
  workspace_focus_window: workspaceMutation(["ui_control"], "one_step", WORKSTREAM_BOUND_ONLY, { loadGroups: ["ui:workspace"] }),
  workspace_register_window: control(["ui_control"], "one_step", ["workstream_bound"], { loadGroups: ["ui:workspace"] }),
  workspace_reuse_or_open_window: workspaceMutation(["ui_control"], "one_step", WORKSTREAM_BOUND_ONLY, { loadGroups: ["ui:workspace"] }),
  workspace_close_window: destructive(["ui_control"], "one_step", WORKSTREAM_BOUND_ONLY, { loadGroups: ["ui:workspace"] }),
  workspace_cleanup_unused: destructive(["ui_control"], "one_step", WORKSTREAM_BOUND_ONLY, { loadGroups: ["ui:workspace"] }),
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

export function getToolPurpose(toolName: string): ToolPurpose | undefined {
  if (isNativeControlToolName(toolName)) {
    return "control";
  }
  return getToolTaxonomy(toolName)?.purpose;
}

export function isNativeControlToolName(toolName: string): boolean {
  return NATIVE_CONTROL_TOOLS.has(toolName);
}

export function isObservationalTool(toolName: string): boolean {
  const taxonomy = getToolTaxonomy(toolName);
  return taxonomy?.effect === "read_only"
    && (taxonomy.purpose === "list" || taxonomy.purpose === "read" || taxonomy.purpose === "search");
}

export function hasMutationEffect(toolName: string): boolean {
  const effect = getToolTaxonomy(toolName)?.effect;
  return effect === "workspace_mutation"
    || effect === "context_mutation"
    || effect === "external_mutation"
    || effect === "destructive";
}

export function isRoutingTool(toolName: string): boolean {
  return getToolTaxonomy(toolName)?.roles.includes("workstream_routing") ?? false;
}

export function requiresWorkstreamBinding(toolName: string): boolean {
  return getToolTaxonomy(toolName)?.requiresWorkstreamBinding ?? false;
}

export function canRunBeforeWorkstream(toolName: string): boolean {
  return getToolTaxonomy(toolName)?.canRunBeforeWorkstream ?? false;
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
  const purposes = zeroRecord(["list", "read", "search", "control", "mutation"] as const);
  const effects = zeroRecord(["read_only", "workspace_mutation", "context_mutation", "external_mutation", "destructive"] as const);
  const roles = zeroRecord([
    "conversation_read",
    "enquiry_read",
    "workstream_routing",
    "workstream_discovery",
    "workstream_preference",
    "workstream_mutation",
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
    purposes[entry.purpose]++;
    effects[entry.effect]++;
    for (const role of entry.roles) {
      roles[role]++;
    }
    if (entry.requiresWorkstreamBinding) {
      requiresRun.push(name);
    }
    if (entry.canRunBeforeWorkstream) {
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
    purposes,
    effects,
    roles,
    requiresWorkstreamBinding: requiresRun,
    canRunBeforeWorkstream: beforeTask,
    longRunning,
    lifetimes,
  };
}

function buildToolTaxonomy(input: Record<string, ToolTaxonomyInput>): Record<string, ToolTaxonomyEntry> {
  const entries: Record<string, ToolTaxonomyEntry> = {};
  for (const [name, entry] of Object.entries(input)) {
    const built: ToolTaxonomyEntry = {
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
    assertPurposeEffectConsistency(built);
    entries[name] = built;
  }
  return entries;
}

function assertPurposeEffectConsistency(entry: ToolTaxonomyEntry): void {
  const observationalPurpose = entry.purpose === "list"
    || entry.purpose === "read"
    || entry.purpose === "search";
  if (observationalPurpose !== (entry.effect === "read_only")) {
    throw new Error(`Tool '${entry.name}' has inconsistent purpose '${entry.purpose}' and effect '${entry.effect}'.`);
  }
  if (entry.purpose === "control" && entry.effect !== "context_mutation") {
    throw new Error(`Control tool '${entry.name}' must declare a context_mutation effect.`);
  }
  if (entry.roles.includes("workstream_routing") && entry.purpose !== "control") {
    throw new Error(`Workstream-routing tool '${entry.name}' must have control purpose.`);
  }
  if (entry.requiresWorkstreamBinding && entry.canRunBeforeWorkstream) {
    throw new Error(`Tool '${entry.name}' cannot require workstream binding and run before workstream binding.`);
  }
}

function readOnly(
  roles: ToolRole[],
  lifetime: ToolLifetime,
  allowedPhases: ToolPhase[],
  options: Partial<Pick<ToolTaxonomyInput, "loadGroups" | "loadPriority" | "nextOnSuccess" | "nextOnFailure">> = {},
): ToolTaxonomyInput {
  const canRunBeforeWorkstream = allowedPhases.some((phase) => phase === "conversation" || phase === "enquiry" || phase === "routing");
  return {
    purpose: "read",
    effect: "read_only",
    roles,
    lifetime,
    allowedPhases,
    requiresWorkstreamBinding: !canRunBeforeWorkstream,
    canRunBeforeWorkstream,
    producesEvidence: roles.some((role) => role === "workstream_discovery" || role === "evidence_access" || role === "enquiry_read"),
    producesUserArtifact: false,
    ...options,
  };
}

function search(
  roles: ToolRole[],
  lifetime: ToolLifetime,
  allowedPhases: ToolPhase[],
  options: Partial<Pick<ToolTaxonomyInput, "loadGroups" | "loadPriority" | "nextOnSuccess" | "nextOnFailure">> = {},
): ToolTaxonomyInput {
  return {
    ...readOnly(roles, lifetime, allowedPhases, options),
    purpose: "search",
  };
}

function list(
  roles: ToolRole[],
  lifetime: ToolLifetime,
  allowedPhases: ToolPhase[],
  options: Partial<Pick<ToolTaxonomyInput, "loadGroups" | "loadPriority" | "nextOnSuccess" | "nextOnFailure">> = {},
): ToolTaxonomyInput {
  return {
    ...readOnly(roles, lifetime, allowedPhases, options),
    purpose: "list",
  };
}

function workspaceMutation(
  roles: ToolRole[],
  lifetime: ToolLifetime,
  allowedPhases: ToolPhase[] = WORKSTREAM_BOUND_ONLY,
  options: Partial<Pick<ToolTaxonomyInput, "loadGroups" | "loadPriority" | "nextOnSuccess" | "nextOnFailure">> = {},
): ToolTaxonomyInput {
  return {
    purpose: "mutation",
    effect: "workspace_mutation",
    roles,
    lifetime,
    allowedPhases,
    requiresWorkstreamBinding: true,
    canRunBeforeWorkstream: false,
    producesEvidence: true,
    producesUserArtifact: roles.includes("workstream_mutation"),
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
    purpose: "mutation",
    effect: "context_mutation",
    roles,
    lifetime,
    allowedPhases,
    requiresWorkstreamBinding: !allowedPhases.includes("routing"),
    canRunBeforeWorkstream: allowedPhases.includes("routing"),
    producesEvidence: true,
    producesUserArtifact: false,
    ...options,
  };
}

function control(
  roles: ToolRole[],
  lifetime: ToolLifetime,
  allowedPhases: ToolPhase[],
  options: Partial<Pick<ToolTaxonomyInput, "loadGroups" | "loadPriority" | "nextOnSuccess" | "nextOnFailure">> = {},
): ToolTaxonomyInput {
  return {
    ...contextMutation(roles, lifetime, allowedPhases, options),
    purpose: "control",
  };
}

function externalMutation(
  roles: ToolRole[],
  lifetime: ToolLifetime,
  allowedPhases: ToolPhase[],
  options: Partial<Pick<ToolTaxonomyInput, "loadGroups" | "loadPriority" | "nextOnSuccess" | "nextOnFailure">> = {},
): ToolTaxonomyInput {
  return {
    purpose: "mutation",
    effect: "external_mutation",
    roles,
    lifetime,
    allowedPhases,
    requiresWorkstreamBinding: true,
    canRunBeforeWorkstream: false,
    producesEvidence: true,
    producesUserArtifact: false,
    ...options,
  };
}

function destructive(
  roles: ToolRole[],
  lifetime: ToolLifetime,
  allowedPhases: ToolPhase[] = WORKSTREAM_BOUND_ONLY,
  options: Partial<Pick<ToolTaxonomyInput, "loadGroups" | "loadPriority" | "nextOnSuccess" | "nextOnFailure">> = {},
): ToolTaxonomyInput {
  return {
    purpose: "mutation",
    effect: "destructive",
    roles,
    lifetime,
    allowedPhases,
    requiresWorkstreamBinding: true,
    canRunBeforeWorkstream: false,
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
  if (entry.roles.includes("long_running_process")) groups.push("process:session");
  if (name.startsWith("db_")) groups.push(entry.effect === "read_only" ? "database:read" : "database:write");
  if (name === "pulse") groups.push("pulse:control");
  return groups;
}

function defaultLoadPriority(entry: ToolTaxonomyInput): number {
  if (entry.roles.includes("workstream_routing")) return 100;
  if (entry.roles.includes("workstream_mutation") && entry.lifetime === "run") return 90;
  if (entry.roles.includes("workstream_discovery") && entry.lifetime === "run") return 85;
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
