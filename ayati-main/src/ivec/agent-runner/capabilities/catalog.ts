import {
  getToolTaxonomy,
  hasMutationEffect,
  isObservationalTool,
  requiresWorkstreamBinding,
} from "../../../skills/tool-taxonomy.js";
import {
  isGitContextRoutingSupportToolName,
  isGitContextTurnRoutingToolName,
} from "../../../skills/builtins/git-context/tool-policy.js";
import type {
  CapabilityCard,
  CapabilityDefinition,
  ModeCapabilityOptions,
} from "./contracts.js";
import type { VirtualModeTransitionTarget } from "../virtual-mode.js";

const OBSERVE_LOCATE: VirtualModeTransitionTarget[] = ["observe.locate"];
const OBSERVE_INVESTIGATE: VirtualModeTransitionTarget[] = ["observe.investigate"];
const CONTEXT_RETRIEVE: VirtualModeTransitionTarget[] = ["context.retrieve"];
const OBSERVE_BOTH: VirtualModeTransitionTarget[] = [
  "observe.locate",
  "observe.investigate",
];
const MUTATION: VirtualModeTransitionTarget[] = ["resolve", "execute"];
const EXECUTE: VirtualModeTransitionTarget[] = ["execute"];
const VALIDATION: VirtualModeTransitionTarget[] = ["validation"];

export const CAPABILITY_DEFINITIONS: readonly CapabilityDefinition[] = [
  capability(
    "context:load",
    "Load bounded optional Hot Context for the current run.",
    "Use when the current request refers to available preferences or other optional context that is not already loaded.",
    CONTEXT_RETRIEVE,
    ["context_load"],
  ),
  capability("utility:calculator", "Calculate exact numeric results.", "Use for arithmetic or formula evaluation.", OBSERVE_INVESTIGATE, ["calculator"]),
  targetlessCapability(
    "system:time",
    "Observe the current date, time, weekday, and UTC offset.",
    "Use when the answer depends on the current time or date. No resource reference is required.",
    ["system_time"],
  ),
  targetlessCapability(
    "system:health",
    "Observe bounded local machine and Ayati process health.",
    "Use when current CPU load, memory, disk, uptime, or daemon-process health is relevant. No resource reference is required.",
    ["system_health"],
  ),

  capability("file:search", "Find files, directories, or matching text.", "Use when the exact filesystem target or location is not yet known.", OBSERVE_LOCATE, ["find_files", "list_directory", "search_in_files"], [], {
    success: ["file:read"],
  }),
  capability("file:read", "Inspect exact paths and read file contents.", "Use after the relevant absolute path is known.", OBSERVE_INVESTIGATE, ["inspect_paths", "read_files"]),
  capability("file:write", "Create directories and write or patch files.", "Use for ordinary contained filesystem creation and edits.", MUTATION, ["create_directory", "write_files", "patch_files"], [], {
    success: ["file:verify"],
    failure: ["file:read"],
  }),
  capability("file:copy", "Copy one file, directory, or symbolic link.", "Use when an existing path should be duplicated without changing the source.", MUTATION, ["copy"], [], {
    success: ["file:verify"],
    failure: ["file:read"],
  }),
  capability("file:permissions", "Set exact permissions on regular files.", "Use only when the requested result requires explicit file mode changes.", MUTATION, ["set_permissions"], [], {
    success: ["file:verify"],
    failure: ["file:read"],
  }),
  capability("file:verify", "Verify files and run bounded checks.", "Use after edits to inspect outputs and run relevant tests or builds.", EXECUTE, ["inspect_paths", "read_files", "process_run"]),
  capability(
    "task:validation",
    "Check important verified current-run responsibility outcomes before the final response.",
    "Use only after the current responsibility appears fulfilled; validation runs no action tools.",
    VALIDATION,
    [],
  ),
  capability("file:move", "Move one exact filesystem target.", "Use only for an explicitly requested move or rename.", MUTATION, ["move"]),
  capability("file:delete", "Delete one exact filesystem target.", "Use only for an explicitly authorized destructive deletion.", MUTATION, ["delete"]),

  capability("process:command", "Run a bounded foreground command.", "Use for builds, tests, formatting, or other finite commands.", MUTATION, ["process_run"], [], {
    success: ["file:verify"],
    failure: ["file:read"],
  }),
  capability("process:session", "Control one long-running process session.", "Use for servers or interactive commands that need start, poll, input, and stop.", MUTATION, [
    "process_start",
    "process_poll",
    "process_send_input",
    "process_stop",
  ]),

  capability("database:read", "Inspect database schema and query rows.", "Use for read-only database discovery and analysis.", OBSERVE_INVESTIGATE, [
    "db_list_tables",
    "db_describe_table",
    "db_get_table_ddl",
    "db_query",
  ]),
  capability("database:schema", "Create or change database schema.", "Use for table creation, rename, or adding columns.", MUTATION, [
    "db_create_table",
    "db_rename_table",
    "db_add_columns",
  ], [], {
    success: ["database:read"],
  }),
  capability("database:rows", "Insert or update database rows.", "Use for non-destructive row mutations.", MUTATION, [
    "db_insert_rows",
    "db_update_rows",
  ], [], {
    success: ["database:read"],
  }),
  capability("database:destructive", "Delete rows or drop tables.", "Use only for explicitly authorized destructive database work.", MUTATION, [
    "db_delete_rows",
    "db_drop_table",
  ]),
  capability("database:raw", "Execute exact mutation SQL.", "Use only when the structured database capabilities cannot express the authorized change.", MUTATION, ["db_execute_sql"], [], {
    success: ["database:read"],
  }),

  capability("pulse:manage", "Create or update Pulse automation.", "Use for reminders and scheduled work.", MUTATION, ["pulse"]),

  capability("memory:read", "Search and explain personal or episodic memory.", "Use when earlier learned facts or memory state are needed.", OBSERVE_BOTH, [
    "recall_memory",
    "memory_status",
    "memory_search",
    "memory_explain",
  ]),
  capability("memory:settings", "Change episodic-memory settings.", "Use only when the user requests a memory setting change.", MUTATION, ["memory_set_episodic_enabled"]),
  capability("memory:write", "Remember facts or record memory feedback.", "Use when the user asks Ayati to retain or correct a fact.", MUTATION, [
    "memory_remember",
    "memory_feedback",
  ]),
  capability("memory:delete", "Forget stored memory.", "Use only for an explicit memory deletion request.", MUTATION, ["memory_forget"]),

  capability("attachment:browse", "List and inspect admitted attachments.", "Use to identify the exact attachment before reading it.", OBSERVE_LOCATE, [
    "attachment_list",
    "attachment_inspect",
  ], [], {
    success: ["attachment:read"],
  }),
  capability("attachment:read", "Read or query text and directories in an attachment.", "Use after the exact admitted attachment is known.", OBSERVE_INVESTIGATE, [
    "attachment_read",
    "file_read_text",
    "directory_search",
  ], [
    "attachment_query",
    "file_describe",
    "file_query",
  ]),
  capability("attachment:table", "Profile and query attached tabular data.", "Use for CSV, spreadsheet, or other table-shaped attachments.", OBSERVE_INVESTIGATE, [
    "attachment_query_table",
    "file_profile_table",
    "file_query_table",
  ]),
  capability("attachment:restore", "Restore a durable attachment into the bound run.", "Use when a known attachment must be re-admitted to current bound work.", EXECUTE, ["attachment_restore"], [], {
    success: ["attachment:read"],
  }),
  capability("document:read", "Navigate and query structured documents.", "Use for PDFs and documents with sections or semantic queries.", OBSERVE_INVESTIGATE, [
    "document_list_sections",
    "document_read_section",
    "document_query",
  ]),
  capability("dataset:inspect", "Profile and query a prepared dataset.", "Use for read-only analysis of structured data.", OBSERVE_INVESTIGATE, [
    "dataset_profile",
    "dataset_query",
    "python_inspect_dataset",
  ]),
  capability("dataset:promote", "Promote a prepared table to a durable output.", "Use when an inspected table should become a bound deliverable.", MUTATION, ["dataset_promote_table"]),
  capability("python:execute", "Run bounded Python analysis.", "Use when deterministic dataset tools are insufficient for the authorized analysis.", MUTATION, ["python_execute"]),

  capability("artifact:register", "Register an existing path or produced artifact.", "Use to make a bound filesystem output durable and addressable.", MUTATION, [
    "file_register_path",
    "file_register_artifact",
  ]),
  capability("artifact:fetch", "Fetch a URL into a bound resource.", "Use for an explicitly requested external download.", MUTATION, ["file_fetch_url"]),

  unboundCapability(
    "workstream:search",
    "Search candidate workstreams.",
    "Use in observe.locate when the durable owner is unknown. Verified current-run results can later support workstream routing.",
    OBSERVE_LOCATE,
    ["git_context_find_workstreams"],
  ),
  unboundCapability(
    "workstream:read",
    "Read one exact workstream candidate.",
    "Use in observe.investigate to answer a read-only workstream question or inspect an exact routing candidate.",
    OBSERVE_INVESTIGATE,
    ["git_context_read_workstream"],
  ),
  unboundCapability(
    "resource:ownership",
    "Find workstreams that own a resource.",
    "Use in an observation mode to identify exact durable resource ownership before reporting or routing.",
    OBSERVE_BOTH,
    ["git_context_find_resources"],
  ),
  capability("resource:binding", "Bind resources to the active workstream.", "Use after ownership is resolved and the run is bound.", MUTATION, ["git_context_bind_resources"]),
  capability("workstream:preferences", "Update an explicit workstream preference.", "Use only for an explicit star or preference change.", EXECUTE, ["git_context_set_workstream_star"]),
  capability("history:read", "Search, page, and read exact older agent-stream history.", "Use when exact older discussion or evidence is required. Search by topic when possible; page chronologically only when sequence context matters.", OBSERVE_BOTH, [
    "agent_history_search",
    "agent_conversation_read",
    "agent_history_read",
  ]),

  capability("workspace:inspect", "Inspect UI workspace state.", "Use before changing windows or layout.", OBSERVE_INVESTIGATE, ["workspace_get_state"]),
  capability("workspace:arrange", "Arrange, focus, or register workspace windows.", "Use for ordinary authorized UI workspace changes.", MUTATION, [
    "workspace_set_layout",
    "workspace_focus_window",
    "workspace_register_window",
  ], [], {
    success: ["workspace:inspect"],
  }),
  capability("workspace:open", "Reuse or open a workspace window.", "Use when an application window must be opened or reused.", MUTATION, ["workspace_reuse_or_open_window"], [], {
    success: ["workspace:inspect"],
  }),
  capability("workspace:cleanup", "Close or remove unused workspace windows.", "Use only for explicitly authorized destructive UI cleanup.", MUTATION, [
    "workspace_close_window",
    "workspace_cleanup_unused",
  ], [], {
    success: ["workspace:inspect"],
  }),
];

export const HIDDEN_LIFECYCLE_TOOL_NAMES = new Set([
  "git_context_activate_workstream",
  "git_context_create_workstream",
  "git_context_inspect_resource",
]);

export class CapabilityCatalog {
  private readonly byId = new Map<string, CapabilityDefinition>();
  private readonly byTool = new Map<string, CapabilityDefinition[]>();

  constructor(definitions: readonly CapabilityDefinition[] = CAPABILITY_DEFINITIONS) {
    for (const definition of definitions) {
      validateDefinitionShape(definition);
      if (this.byId.has(definition.id)) {
        throw new Error(`Duplicate capability id '${definition.id}'.`);
      }
      this.byId.set(definition.id, copyDefinition(definition));
    }
    this.validateReferences();
    for (const definition of this.byId.values()) {
      for (const tool of [...definition.coreTools, ...(definition.optionalTools ?? [])]) {
        const existing = this.byTool.get(tool) ?? [];
        existing.push(definition);
        this.byTool.set(tool, existing);
      }
    }
  }

  get(id: string): CapabilityDefinition | undefined {
    const definition = this.byId.get(id);
    return definition ? copyDefinition(definition) : undefined;
  }

  list(): CapabilityDefinition[] {
    return [...this.byId.values()].map(copyDefinition);
  }

  listForMode(
    mode: VirtualModeTransitionTarget,
    availableTools?: ReadonlySet<string>,
  ): CapabilityDefinition[] {
    return this.list().filter((definition) => (
      definition.allowedModes.includes(mode)
      && (!availableTools || definition.coreTools.every((tool) => availableTools.has(tool)))
    ));
  }

  cardsForModes(
    modes: VirtualModeTransitionTarget[],
    availableTools?: ReadonlySet<string>,
  ): CapabilityCard[] {
    const allowed = new Set(modes);
    return this.list()
      .filter((definition) => (
        definition.allowedModes.some((mode) => allowed.has(mode))
        && (!availableTools || definition.coreTools.every((tool) => availableTools.has(tool)))
      ))
      .map(({ id, summary, whenToUse, allowedModes }) => ({
        id,
        summary,
        whenToUse,
        allowedModes: [...allowedModes],
      }));
  }

  capabilitiesForTool(toolName: string): CapabilityDefinition[] {
    return (this.byTool.get(toolName) ?? []).map(copyDefinition);
  }

  requiresReferenceTarget(capabilityIds: string[]): boolean {
    return capabilityIds.some(
      (id) => this.byId.get(id)?.targetRequirement !== "none",
    );
  }

  modeOptions(availableTools?: ReadonlySet<string>): ModeCapabilityOptions {
    return {
      "context.retrieve": this.listForMode("context.retrieve", availableTools).map(({ id }) => id),
      "observe.locate": this.listForMode("observe.locate", availableTools).map(({ id }) => id),
      "observe.investigate": this.listForMode("observe.investigate", availableTools).map(({ id }) => id),
      "workstream.route": this.listForMode("workstream.route", availableTools).map(({ id }) => id),
      resolve: this.listForMode("resolve", availableTools).map(({ id }) => id),
      execute: this.listForMode("execute", availableTools).map(({ id }) => id),
      validation: this.listForMode("validation", availableTools).map(({ id }) => id),
    };
  }

  private validateReferences(): void {
    for (const definition of this.byId.values()) {
      for (const next of [
        ...(definition.suggestedNext?.success ?? []),
        ...(definition.suggestedNext?.failure ?? []),
      ]) {
        if (!this.byId.has(next)) {
          throw new Error(`Capability '${definition.id}' recommends unknown capability '${next}'.`);
        }
      }
    }
  }
}

function capability(
  id: string,
  summary: string,
  whenToUse: string,
  allowedModes: VirtualModeTransitionTarget[],
  coreTools: string[],
  optionalTools: string[] = [],
  suggestedNext?: CapabilityDefinition["suggestedNext"],
): CapabilityDefinition {
  return {
    id,
    summary,
    whenToUse,
    allowedModes,
    coreTools,
    ...(optionalTools.length > 0 ? { optionalTools } : {}),
    ...(suggestedNext ? { suggestedNext } : {}),
  };
}

function unboundCapability(
  id: string,
  summary: string,
  whenToUse: string,
  allowedModes: VirtualModeTransitionTarget[],
  coreTools: string[],
): CapabilityDefinition {
  return {
    ...capability(id, summary, whenToUse, allowedModes, coreTools),
    authority: "unbound",
  };
}

function targetlessCapability(
  id: string,
  summary: string,
  whenToUse: string,
  coreTools: string[],
): CapabilityDefinition {
  return {
    ...capability(
      id,
      summary,
      whenToUse,
      OBSERVE_INVESTIGATE,
      coreTools,
    ),
    targetRequirement: "none",
  };
}

function validateDefinitionShape(definition: CapabilityDefinition): void {
  if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(definition.id)) {
    throw new Error(`Capability id '${definition.id}' must use a small domain:action identifier.`);
  }
  if (definition.summary.trim().length === 0 || definition.whenToUse.trim().length === 0) {
    throw new Error(`Capability '${definition.id}' requires a summary and usage guidance.`);
  }
  if (definition.allowedModes.length === 0) {
    throw new Error(`Capability '${definition.id}' requires at least one mode.`);
  }
  if (definition.coreTools.length === 0 && definition.id !== "task:validation") {
    throw new Error(`Capability '${definition.id}' requires at least one core tool.`);
  }
  if (
    definition.targetRequirement === "none"
    && (
      definition.allowedModes.length !== 1
      || definition.allowedModes[0] !== "observe.investigate"
    )
  ) {
    throw new Error(
      `Targetless capability '${definition.id}' must be observe.investigate-only.`,
    );
  }
  if (
    definition.id === "task:validation"
    && (
      definition.allowedModes.length !== 1
      || definition.allowedModes[0] !== "validation"
      || (definition.optionalTools?.length ?? 0) > 0
    )
  ) {
    throw new Error("Capability 'task:validation' must remain a validation-only proof surface with no executable tools.");
  }
  const allTools = [...definition.coreTools, ...(definition.optionalTools ?? [])];
  if (new Set(allTools).size !== allTools.length) {
    throw new Error(`Capability '${definition.id}' contains duplicate tool names.`);
  }
  if (allTools.some((tool) => isGitContextTurnRoutingToolName(tool) || isGitContextRoutingSupportToolName(tool))) {
    throw new Error(`Capability '${definition.id}' exposes a hidden lifecycle tool.`);
  }
  if (
    definition.allowedModes.some((mode) => (
      mode === "observe.locate"
      || mode === "observe.investigate"
      || mode === "workstream.route"
      || mode === "validation"
    ))
    && allTools.some((tool) => !isObservationalTool(tool))
  ) {
    throw new Error(`Observational capability '${definition.id}' contains a non-read-only tool.`);
  }
  if (
    definition.allowedModes.includes("resolve")
    && !definition.coreTools.some((tool) => requiresWorkstreamBinding(tool) && hasMutationEffect(tool))
  ) {
    throw new Error(`Resolve capability '${definition.id}' requires a binding-required mutation core tool.`);
  }
  const destructive = allTools.filter((tool) => getToolTaxonomy(tool)?.effect === "destructive");
  if (destructive.length > 0 && destructive.length !== allTools.length) {
    throw new Error(`Destructive capability '${definition.id}' cannot mix destructive and non-destructive tools.`);
  }
}

function copyDefinition(definition: CapabilityDefinition): CapabilityDefinition {
  return {
    ...definition,
    allowedModes: [...definition.allowedModes],
    coreTools: [...definition.coreTools],
    ...(definition.optionalTools ? { optionalTools: [...definition.optionalTools] } : {}),
    ...(definition.authority ? { authority: definition.authority } : {}),
    ...(definition.suggestedNext
      ? {
          suggestedNext: {
            ...(definition.suggestedNext.success
              ? { success: [...definition.suggestedNext.success] }
              : {}),
            ...(definition.suggestedNext.failure
              ? { failure: [...definition.suggestedNext.failure] }
              : {}),
          },
        }
      : {}),
  };
}
