import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../types.js";

export type ExternalSkillType = "cli" | "shell";
export type ExternalSkillRuntime = "direct" | "plugin";
export type ExternalSkillSource = "project" | "global";
export type ExternalToolBackend = "command" | "shell" | "http" | "curl" | "plugin" | "node";
export type ExternalActivationScope = "step" | "run" | "session";
export type ExternalCommandOutputMode = "text" | "json-stdout" | "envelope";
export type SkillSearchKind = "tool" | "workflow" | "any";

export interface ExternalSkillMeta {
  id: string;
  type: ExternalSkillType;
  runtime: ExternalSkillRuntime;
  source: ExternalSkillSource;
  resolvedFrom: string;
  plugin?: string;
  command?: string;
  commands?: string[];
  aliases?: string[];
  description: string;
  skillFilePath: string;
  skillDir: string;
  installed: boolean;
  start?: string;
  stop?: string;
}

export interface ExternalSkillManifest {
  id?: string;
  name?: string;
  type?: ExternalSkillType;
  runtime?: ExternalSkillRuntime;
  plugin?: string;
  command?: string;
  commands?: string[];
  aliases?: string[];
  description?: string;
  dependency?: { check?: string; install?: string };
  start?: string;
  stop?: string;
}

export interface ExternalSkillScanRoot {
  skillsDir: string;
  source?: ExternalSkillSource;
}

export interface SecretRefConfig {
  required?: boolean;
  secretRefs?: string[];
}

export interface ExternalDependencyCheck {
  type?: "command";
  command: string;
  args?: string[];
}

export interface ExternalExecutionPolicy {
  capabilities?: string[];
  defaultMode?: "allow" | "ask" | "deny";
  timeoutMs?: number;
  retryPolicy?: "none" | "same_call_once_on_timeout";
  redactedFields?: string[];
}

export interface ExternalToolUsage {
  whenToUse?: string;
  notFor?: string;
  preconditions?: string[];
  returns?: string;
}

export interface ExternalCommandArgSpec {
  flag?: string;
  value?: string;
  from?: string;
  joinWith?: string;
  repeat?: boolean;
}

export interface ExternalPluginIntegration {
  name: string;
  required?: boolean;
}

export interface ExternalToolManifest {
  id: string;
  title?: string;
  description: string;
  usage?: ExternalToolUsage;
  aliases?: string[];
  tags?: string[];
  triggers?: string[];
  action?: string;
  object?: string;
  provider?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execution: ExternalExecutionSpec;
  auth?: SecretRefConfig;
  policy?: ExternalExecutionPolicy;
  examples?: Array<{
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
  }>;
}

export type ExternalExecutionSpec =
  | {
    backend: "command";
    command: string;
    argsTemplate?: string[];
    args?: ExternalCommandArgSpec[];
    cwdTemplate?: string;
    env?: Record<string, string>;
    outputMode?: ExternalCommandOutputMode;
  }
  | {
    backend: "shell";
    command: string;
    argsTemplate?: string[];
    args?: ExternalCommandArgSpec[];
    cwdTemplate?: string;
    env?: Record<string, string>;
    outputMode?: ExternalCommandOutputMode;
  }
  | {
    backend: "http";
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    headers?: Record<string, string>;
    bodyTemplate?: Record<string, unknown> | string;
    allowedDomains?: string[];
  }
  | {
    backend: "curl";
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    headers?: Record<string, string>;
    bodyTemplate?: Record<string, unknown> | string;
    allowedDomains?: string[];
  }
  | {
    backend: "plugin";
    target: string;
  }
  | {
    backend: "node";
    handler: string;
  };

export interface StructuredSkillManifest {
  id: string;
  version?: string;
  title?: string;
  description: string;
  kind?: "external-skill";
  status?: "active" | "disabled";
  owner?: string;
  source?: { type?: string; path?: string };
  domains?: string[];
  tags?: string[];
  aliases?: string[];
  triggers?: string[];
  activation?: {
    defaultScope?: ExternalActivationScope;
    maxActiveTools?: number;
    brief?: string;
    workflow?: string[];
    rules?: string[];
  };
  integration?: {
    plugin?: ExternalPluginIntegration;
  };
  auth?: SecretRefConfig;
  dependencies?: {
    checks?: ExternalDependencyCheck[];
  };
  policy?: ExternalExecutionPolicy;
  toolFiles?: string[];
  adapter?: {
    entry: string;
  };
  docs?: {
    main?: string;
  };
  card?: {
    summary?: string;
    whenToUse?: string;
    roleLabel?: string;
    useFor?: string[];
    notFor?: string[];
    workflowHint?: string;
    pairedSkillId?: string;
  };
}

export interface NormalizedExternalTool {
  id: string;
  skillId: string;
  title: string;
  description: string;
  usage: ExternalToolUsage;
  aliases: string[];
  tags: string[];
  triggers: string[];
  action?: string;
  object?: string;
  provider?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execution: ExternalExecutionSpec;
  auth: SecretRefConfig;
  policy: ExternalExecutionPolicy;
  examples: Array<{
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
  }>;
}

export interface NormalizedExternalSkill {
  id: string;
  title: string;
  description: string;
  cardSummary: string;
  cardWhenToUse: string;
  roleLabel?: string;
  useFor: string[];
  notFor: string[];
  workflowHint?: string;
  pairedSkillId?: string;
  activationBrief: string;
  activationWorkflow: string[];
  activationRules: string[];
  source: ExternalSkillSource;
  resolvedFrom: string;
  skillDir: string;
  manifestPath?: string;
  docsPath?: string;
  adapterPath?: string;
  installed: boolean;
  workflowOnly: boolean;
  legacy: boolean;
  domains: string[];
  tags: string[];
  aliases: string[];
  triggers: string[];
  toolFiles: string[];
  tools: NormalizedExternalTool[];
  dependencyChecks: ExternalDependencyCheck[];
  policy: ExternalExecutionPolicy;
  auth: SecretRefConfig;
  legacyCommands: string[];
  defaultActivationScope: ExternalActivationScope;
  maxActiveTools?: number;
  integration?: {
    plugin?: ExternalPluginIntegration;
  };
}

export interface ReadinessReason {
  code:
    | "missing_dependency"
    | "missing_secret"
    | "policy_denied"
    | "policy_requires_approval"
    | "unsupported_backend"
    | "missing_adapter"
    | "missing_http_allowlist"
    | "workflow_only"
    | "missing_plugin_runtime";
  message: string;
}

export interface ToolReadinessState {
  skillId: string;
  toolId: string;
  toolName: string;
  activatable: boolean;
  reasons: ReadinessReason[];
}

export interface SkillReadinessState {
  skillId: string;
  workflowOnly: boolean;
  activatable: boolean;
  reasons: ReadinessReason[];
  tools: ToolReadinessState[];
}

export interface SkillSearchResult {
  type: "tool" | "workflow";
  score: number;
  skillId: string;
  toolId?: string;
  toolName?: string;
  title: string;
  description: string;
  workflowOnly: boolean;
  matchReasons: string[];
  domains: string[];
  tags: string[];
}

export interface ExternalToolWindowEntry {
  groupId: string;
  skillId: string;
  toolId: string;
  toolName: string;
  title: string;
  scope: "run";
  runId?: string;
  sessionId?: string;
  activatedAtStep?: number;
  lastTouchedAtStep?: number;
  order: number;
}

export interface SkillActivationRecord {
  skillId: string;
  scope: "run";
  status?: "activated" | "already_active";
  activatedTools: ExternalToolWindowEntry[];
  evictedTools: ExternalToolWindowEntry[];
  evictedSkills?: string[];
  windowSize: number;
  activationBrief?: string;
}

export interface ResolvedSecret {
  ok: boolean;
  ref: string;
  env?: Record<string, string>;
  value?: string;
  source?: string;
  missing?: boolean;
  error?: string;
}

export interface SecretResolver {
  resolve(ref: string): Promise<ResolvedSecret>;
  inspect(ref: string): Promise<{
    ok: boolean;
    ref: string;
    source?: string;
    env?: string;
    missing?: boolean;
    error?: string;
  }>;
}

export interface SkillAdapterContext {
  secrets: SecretResolver;
  command: {
    run(input: {
      command: string;
      args?: string[];
      timeoutMs?: number;
      env?: Record<string, string>;
    }): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null; error?: string }>;
  };
  http: {
    request(input: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      body?: string;
      timeoutMs?: number;
    }): Promise<{ ok: boolean; status: number; body: string; error?: string }>;
  };
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

export interface BrokerExecutionRequest {
  input: unknown;
  tool: NormalizedExternalTool;
  skill: NormalizedExternalSkill;
  context?: ToolExecutionContext;
}

export type BrokerExecutionResult = ToolResult;

export type SkillAdapterHandler = (
  ctx: SkillAdapterContext,
  req: BrokerExecutionRequest,
) => Promise<BrokerExecutionResult>;

export interface SkillAdapterModule {
  [handler: string]: SkillAdapterHandler;
}

export interface ExternalSkillCatalog {
  generatedAt: string;
  roots: ExternalSkillScanRoot[];
  skills: NormalizedExternalSkill[];
}
