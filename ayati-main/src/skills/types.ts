import type { AgentUiContext } from "../ui/context.js";
import type { TaskAssetRecord } from "../context-engine/index.js";

export interface SkillPromptBlock {
  id: string;
  content: string;
}

export interface ToolSelectionHints {
  tags?: string[];
  aliases?: string[];
  examples?: string[];
  domain?: string;
  priority?: number;
}

export interface ToolExecutionContext {
  clientId?: string;
  runId?: string;
  sessionId?: string;
  taskAssets?: TaskAssetRecord[];
  stepNumber?: number;
  uiContext?: AgentUiContext;
}

export type JsonSchema = Record<string, unknown>;

export type ToolDomain =
  | "general"
  | "filesystem"
  | "shell"
  | "calculator"
  | "ui"
  | "memory"
  | "database"
  | "documents"
  | "python"
  | "pulse"
  | "attachments"
  | "datasets"
  | "recall"
  | "files";

export interface ToolAnnotations {
  domain: ToolDomain;
  readOnly: boolean;
  mutatesWorkspace: boolean;
  mutatesExternalWorld: boolean;
  destructive: boolean;
  idempotent: boolean;
  retrySafe: boolean;
  longRunning: boolean;
}

export type ToolOperationStatus = "succeeded" | "failed" | "partial" | "pending";

export type ToolErrorCategory =
  | "validation"
  | "missing_path"
  | "permission"
  | "conflict"
  | "semantic"
  | "transient"
  | "timeout"
  | "unknown";

export interface ToolStructuredError {
  category: ToolErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  recoverable: boolean;
  target?: string;
  expected?: unknown;
  actual?: unknown;
  suggestedNextActions: string[];
}

export interface ArtifactRef {
  kind: "file" | "directory" | "table" | "memory" | "url" | "window" | "unknown";
  path?: string;
  uri?: string;
  id?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface Condition {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  target?: string;
}

export interface VerifiedFact {
  id?: string;
  kind: string;
  message: string;
  path?: string;
  tool?: string;
  data?: Record<string, unknown>;
}

export interface AssertionResult {
  id: string;
  kind: string;
  status: "passed" | "failed" | "skipped";
  severity: "required" | "warning" | "info";
  message: string;
  expected?: unknown;
  actual?: unknown;
  artifacts?: ArtifactRef[];
  facts?: VerifiedFact[];
  error?: {
    code: string;
    category: ToolErrorCategory | "state_mismatch";
    retryable: boolean;
    suggestedNextActions: string[];
  };
}

export interface ToolContractVerification {
  status: "passed" | "failed" | "skipped";
  summary: string;
  assertions: AssertionResult[];
  facts: VerifiedFact[];
  artifacts: ArtifactRef[];
}

export interface ToolResultV2 {
  transportOk: boolean;
  operationStatus: ToolOperationStatus;
  code: string;
  message: string;
  structuredContent?: unknown;
  artifacts?: ArtifactRef[];
  conditions?: Condition[];
  error?: ToolStructuredError;
  diagnostics?: Record<string, unknown>;
  verification?: ToolContractVerification;
}

export type ToolContractAssertion =
  | { id?: string; kind: "tool_status"; status: ToolOperationStatus; severity?: AssertionResult["severity"] }
  | { id?: string; kind: "json_path_equals"; path: string; value: unknown; severity?: AssertionResult["severity"] }
  | { id?: string; kind: "json_path_exists"; path: string; severity?: AssertionResult["severity"] }
  | { id?: string; kind: "json_path_count_equals"; path: string; equalsPath: string; severity?: AssertionResult["severity"] }
  | { id?: string; kind: "json_path_number_equals_count"; path: string; equalsPath: string; severity?: AssertionResult["severity"] }
  | { id?: string; kind: "all_paths_exist"; path: string; severity?: AssertionResult["severity"] }
  | { id?: string; kind: "file_exists"; path: string; severity?: AssertionResult["severity"] }
  | { id?: string; kind: "file_not_exists"; path: string; severity?: AssertionResult["severity"] }
  | { id?: string; kind: "file_contains"; path: string; text: string; severity?: AssertionResult["severity"] }
  | { id?: string; kind: "file_hash_equals"; path: string; sha256: string; severity?: AssertionResult["severity"] }
  | { id?: string; kind: "file_hash_matches"; path: string; sha256Path: string; severity?: AssertionResult["severity"] }
  | { id?: string; kind: "sqlite_table_exists"; tablePath: string; dbPathPath?: string; severity?: AssertionResult["severity"] }
  | { id?: string; kind: "sqlite_table_not_exists"; tablePath: string; dbPathPath?: string; severity?: AssertionResult["severity"] }
  | {
      id?: string;
      kind: "written_hashes_match";
      outputFilesPath: string;
      inputFilesPath?: string;
      pathField?: string;
      requestedPathField?: string;
      hashField?: string;
      inputPathField?: string;
      inputContentField?: string;
      severity?: AssertionResult["severity"];
    };

export interface ArtifactExtractor {
  kind: ArtifactRef["kind"];
  path: string;
  source?: "result" | "input" | "structuredContent";
}

export interface ProgressFactExtractor {
  kind: string;
  path: string;
  message?: string;
}

export interface ToolResultContract {
  operationStatusPath: string;
  successWhen: ToolContractAssertion[];
  failureWhen?: ToolContractAssertion[];
  artifacts?: ArtifactExtractor[];
  progressFacts?: ProgressFactExtractor[];
}

export interface ToolErrorContract {
  codes: Record<string, {
    category: ToolErrorCategory;
    retryable: boolean;
    recoverable: boolean;
    suggestedNextActions: string[];
  }>;
}

export interface ToolResult {
  ok: boolean;
  output?: string;
  rawOutput?: string;
  error?: string;
  meta?: Record<string, unknown>;
  v2?: ToolResultV2;
}

export interface ToolObservationPolicy {
  outputImportance: "none" | "operation_summary" | "decision_context";
  maxObservationChars?: number;
  rawStorage?: "never" | "when_truncated" | "always";
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
  resultContract?: ToolResultContract;
  errorContract?: ToolErrorContract;
  observationPolicy?: ToolObservationPolicy;
  selectionHints?: ToolSelectionHints;
  execute(input: unknown, context?: ToolExecutionContext): Promise<ToolResult>;
}

export interface SkillDefinition {
  id: string;
  version: string;
  description: string;
  promptBlock: string;
  tools: ToolDefinition[];
}

export interface SkillsProvider {
  getAllSkills(): Promise<SkillDefinition[]>;
  getAllSkillBlocks(): Promise<SkillPromptBlock[]>;
  getAllTools(): Promise<ToolDefinition[]>;
}
