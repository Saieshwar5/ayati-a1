import type {
  ArtifactRef,
  AssertionResult,
  ToolContractAssertion,
  ToolResultV2,
  VerifiedFact,
} from "./assertion-types.js";
import { listTables } from "../database/sqlite-runtime.js";
import { fileArtifact, uniqueArtifacts } from "./artifact-assertions.js";
import { fileExists, readText, sha256File, sha256Text } from "./filesystem-assertions.js";
import { jsonPathCount, readJsonPathValue, readJsonPathValues } from "./json-assertions.js";
import { toolStatusMatches } from "./tool-output-assertions.js";

export interface AssertionContext {
  toolName: string;
  input: unknown;
  result: ToolResultV2;
}

export interface AssertionRunResult {
  status: "passed" | "failed";
  assertions: AssertionResult[];
  facts: VerifiedFact[];
  artifacts: ArtifactRef[];
}

interface WriteOutputRecord {
  filePath?: string;
  requestedPath?: string;
  sha256?: string;
}

interface WriteInputRecord {
  path?: string;
  content?: string;
}

function contextRoot(context: AssertionContext): Record<string, unknown> {
  return {
    toolName: context.toolName,
    input: context.input,
    result: context.result,
    structuredContent: context.result.structuredContent,
  };
}

function assertionId(assertion: ToolContractAssertion, fallback: string): string {
  return assertion.id?.trim() || fallback;
}

function severity(assertion: ToolContractAssertion): AssertionResult["severity"] {
  return assertion.severity ?? "required";
}

function passedResult(
  assertion: ToolContractAssertion,
  fallbackId: string,
  message: string,
  facts: VerifiedFact[] = [],
  artifacts: ArtifactRef[] = [],
  actual?: unknown,
): AssertionResult {
  return {
    id: assertionId(assertion, fallbackId),
    kind: assertion.kind,
    status: "passed",
    severity: severity(assertion),
    message,
    ...(actual !== undefined ? { actual } : {}),
    ...(facts.length > 0 ? { facts } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}

function failedResult(
  assertion: ToolContractAssertion,
  fallbackId: string,
  message: string,
  expected?: unknown,
  actual?: unknown,
): AssertionResult {
  return {
    id: assertionId(assertion, fallbackId),
    kind: assertion.kind,
    status: "failed",
    severity: severity(assertion),
    message,
    ...(expected !== undefined ? { expected } : {}),
    ...(actual !== undefined ? { actual } : {}),
    error: {
      code: "ASSERTION_FAILED",
      category: "state_mismatch",
      retryable: true,
      suggestedNextActions: ["Inspect the failed assertion and retry with corrected tool input or state."],
    },
  };
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pathValues(root: unknown, path: string): unknown[] {
  if (path.trim().startsWith("$")) {
    return readJsonPathValues(root, path);
  }
  return [path];
}

function pathValue(root: unknown, path: string): unknown {
  return path.trim().startsWith("$") ? readJsonPathValue(root, path) : path;
}

function stringValues(root: unknown, path: string): string[] {
  return pathValues(root, path).filter((value): value is string => typeof value === "string" && value.length > 0);
}

function optionalStringValue(root: unknown, path: string | undefined): string | undefined {
  if (!path) return undefined;
  const value = pathValue(root, path);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isWriteOutputRecord(value: unknown): value is WriteOutputRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWriteInputRecord(value: unknown): value is WriteInputRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

async function runWrittenHashesMatch(
  assertion: Extract<ToolContractAssertion, { kind: "written_hashes_match" }>,
  context: AssertionContext,
): Promise<AssertionResult> {
  const root = contextRoot(context);
  const outputRecords = readJsonPathValues(root, assertion.outputFilesPath).filter(isWriteOutputRecord);
  const inputRecords = assertion.inputFilesPath
    ? readJsonPathValues(root, assertion.inputFilesPath).filter(isWriteInputRecord)
    : [];
  const inputByPath = new Map<string, WriteInputRecord>();
  const inputPathField = assertion.inputPathField ?? "path";
  const inputContentField = assertion.inputContentField ?? "content";
  for (const input of inputRecords) {
    const path = recordString(input as Record<string, unknown>, inputPathField);
    if (path) {
      inputByPath.set(path, input);
    }
  }

  const pathField = assertion.pathField ?? "filePath";
  const requestedPathField = assertion.requestedPathField ?? "requestedPath";
  const hashField = assertion.hashField ?? "sha256";
  const artifacts: ArtifactRef[] = [];
  const facts: VerifiedFact[] = [];

  if (outputRecords.length === 0) {
    return failedResult(assertion, "written_hashes_match", "No output file records were available for hash verification.");
  }

  for (const output of outputRecords) {
    const outputRecord = output as Record<string, unknown>;
    const filePath = recordString(outputRecord, pathField);
    const expectedHash = recordString(outputRecord, hashField);
    const requestedPath = recordString(outputRecord, requestedPathField);
    if (!filePath || !expectedHash) {
      return failedResult(
        assertion,
        "written_hashes_match",
        "Output file record is missing file path or hash.",
        { pathField, hashField },
        output,
      );
    }

    const exists = await fileExists(filePath);
    if (!exists) {
      return failedResult(assertion, "written_hashes_match", `Written file does not exist: ${filePath}`, "file exists", "missing");
    }

    const actualHash = await sha256File(filePath);
    if (actualHash !== expectedHash) {
      return failedResult(assertion, "written_hashes_match", `Written file hash mismatch: ${filePath}`, expectedHash, actualHash);
    }

    if (requestedPath && inputByPath.size > 0) {
      const input = inputByPath.get(requestedPath);
      const inputContent = input ? recordString(input as Record<string, unknown>, inputContentField) : undefined;
      if (inputContent === undefined) {
        return failedResult(assertion, "written_hashes_match", `No matching input content found for ${requestedPath}.`);
      }
      const inputHash = sha256Text(inputContent);
      if (inputHash !== actualHash) {
        return failedResult(assertion, "written_hashes_match", `Read-back content does not match requested content: ${requestedPath}`, inputHash, actualHash);
      }
    }

    artifacts.push(fileArtifact(filePath, requestedPath));
    facts.push({
      id: `written_hash_verified:${filePath}`,
      kind: "written_hash_verified",
      message: `Read-back hash verified for ${filePath}.`,
      path: filePath,
      tool: context.toolName,
      data: { sha256: actualHash, requestedPath },
    });
  }

  return passedResult(
    assertion,
    "written_hashes_match",
    `Verified read-back hashes for ${outputRecords.length} written file(s).`,
    facts,
    artifacts,
    outputRecords.length,
  );
}

async function runAssertion(assertion: ToolContractAssertion, context: AssertionContext): Promise<AssertionResult> {
  const root = contextRoot(context);

  switch (assertion.kind) {
    case "tool_status": {
      const passed = toolStatusMatches(context.result, assertion.status);
      return passed
        ? passedResult(assertion, "tool_status", `${context.toolName} operation status is ${assertion.status}.`, [{
            id: `tool_status:${context.toolName}:${assertion.status}`,
            kind: "tool_status",
            message: `${context.toolName} operation status is ${assertion.status}.`,
            tool: context.toolName,
            data: { status: assertion.status },
          }], [], context.result.operationStatus)
        : failedResult(assertion, "tool_status", `${context.toolName} operation status is ${context.result.operationStatus}, expected ${assertion.status}.`, assertion.status, context.result.operationStatus);
    }

    case "json_path_equals": {
      const actual = pathValue(root, assertion.path);
      return valuesEqual(actual, assertion.value)
        ? passedResult(assertion, "json_path_equals", `${assertion.path} matched expected value.`, [], [], actual)
        : failedResult(assertion, "json_path_equals", `${assertion.path} did not match expected value.`, assertion.value, actual);
    }

    case "json_path_exists": {
      const values = pathValues(root, assertion.path);
      return values.length > 0
        ? passedResult(assertion, "json_path_exists", `${assertion.path} exists.`, [], [], values.length)
        : failedResult(assertion, "json_path_exists", `${assertion.path} did not exist.`);
    }

    case "json_path_count_equals": {
      const actual = jsonPathCount(root, assertion.path);
      const expected = jsonPathCount(root, assertion.equalsPath);
      return actual === expected
        ? passedResult(assertion, "json_path_count_equals", `${assertion.path} count matched ${assertion.equalsPath}.`, [], [], actual)
        : failedResult(assertion, "json_path_count_equals", `${assertion.path} count did not match ${assertion.equalsPath}.`, expected, actual);
    }

    case "json_path_number_equals_count": {
      const actual = pathValue(root, assertion.path);
      const expected = jsonPathCount(root, assertion.equalsPath);
      return actual === expected
        ? passedResult(assertion, "json_path_number_equals_count", `${assertion.path} number matched ${assertion.equalsPath} count.`, [], [], actual)
        : failedResult(assertion, "json_path_number_equals_count", `${assertion.path} number did not match ${assertion.equalsPath} count.`, expected, actual);
    }

    case "all_paths_exist": {
      const paths = stringValues(root, assertion.path);
      if (paths.length === 0) {
        return failedResult(assertion, "all_paths_exist", `No paths found at ${assertion.path}.`);
      }
      for (const path of paths) {
        if (!(await fileExists(path))) {
          return failedResult(assertion, "all_paths_exist", `Path does not exist: ${path}`, "exists", "missing");
        }
      }
      return passedResult(assertion, "all_paths_exist", `All ${paths.length} path(s) exist.`, paths.map((path) => ({
        id: `file_exists:${path}`,
        kind: "file_exists",
        message: `File exists: ${path}.`,
        path,
        tool: context.toolName,
      })), paths.map((path) => fileArtifact(path)), paths.length);
    }

    case "file_exists": {
      const path = String(pathValue(root, assertion.path) ?? "");
      return path && await fileExists(path)
        ? passedResult(assertion, "file_exists", `File exists: ${path}.`, [{
            id: `file_exists:${path}`,
            kind: "file_exists",
            message: `File exists: ${path}.`,
            path,
            tool: context.toolName,
          }], [fileArtifact(path)], path)
        : failedResult(assertion, "file_exists", `File does not exist: ${path || assertion.path}.`, "exists", "missing");
    }

    case "file_not_exists": {
      const path = String(pathValue(root, assertion.path) ?? "");
      return path && !(await fileExists(path))
        ? passedResult(assertion, "file_not_exists", `File does not exist: ${path}.`, [{
            id: `file_not_exists:${path}`,
            kind: "file_not_exists",
            message: `File does not exist: ${path}.`,
            path,
            tool: context.toolName,
          }], [], path)
        : failedResult(assertion, "file_not_exists", `File still exists: ${path || assertion.path}.`, "missing", "exists");
    }

    case "file_contains": {
      const path = String(pathValue(root, assertion.path) ?? "");
      if (!path || !(await fileExists(path))) {
        return failedResult(assertion, "file_contains", `File does not exist: ${path || assertion.path}.`, "exists", "missing");
      }
      const content = await readText(path);
      return content.includes(assertion.text)
        ? passedResult(assertion, "file_contains", `File contains expected text: ${path}.`, [{
            id: `file_contains:${path}`,
            kind: "file_contains",
            message: `File contains expected text: ${path}.`,
            path,
            tool: context.toolName,
          }], [fileArtifact(path)], assertion.text)
        : failedResult(assertion, "file_contains", `File does not contain expected text: ${path}.`, assertion.text, "missing");
    }

    case "file_hash_equals": {
      const path = String(pathValue(root, assertion.path) ?? "");
      if (!path || !(await fileExists(path))) {
        return failedResult(assertion, "file_hash_equals", `File does not exist: ${path || assertion.path}.`, "exists", "missing");
      }
      const actual = await sha256File(path);
      return actual === assertion.sha256
        ? passedResult(assertion, "file_hash_equals", `File hash matched: ${path}.`, [{
            id: `file_hash_equals:${path}`,
            kind: "file_hash_equals",
            message: `File hash matched: ${path}.`,
            path,
            tool: context.toolName,
            data: { sha256: actual },
          }], [fileArtifact(path)], actual)
        : failedResult(assertion, "file_hash_equals", `File hash did not match: ${path}.`, assertion.sha256, actual);
    }

    case "file_hash_matches": {
      const path = String(pathValue(root, assertion.path) ?? "");
      const expected = pathValue(root, assertion.sha256Path);
      if (typeof expected !== "string" || expected.length === 0) {
        return failedResult(assertion, "file_hash_matches", `${assertion.sha256Path} did not resolve to a hash string.`);
      }
      if (!path || !(await fileExists(path))) {
        return failedResult(assertion, "file_hash_matches", `File does not exist: ${path || assertion.path}.`, "exists", "missing");
      }
      const actual = await sha256File(path);
      return actual === expected
        ? passedResult(assertion, "file_hash_matches", `File hash matched: ${path}.`, [{
            id: `file_hash_matches:${path}`,
            kind: "file_hash_matches",
            message: `File hash matched: ${path}.`,
            path,
            tool: context.toolName,
            data: { sha256: actual },
          }], [fileArtifact(path)], actual)
        : failedResult(assertion, "file_hash_matches", `File hash did not match: ${path}.`, expected, actual);
    }

    case "sqlite_table_exists": {
      const table = String(pathValue(root, assertion.tablePath) ?? "");
      const dbPath = optionalStringValue(root, assertion.dbPathPath);
      if (!table) {
        return failedResult(assertion, "sqlite_table_exists", `${assertion.tablePath} did not resolve to a table name.`);
      }
      const listed = listTables(dbPath);
      if (!listed.ok) {
        return failedResult(assertion, "sqlite_table_exists", listed.error ?? "Unable to list SQLite tables.");
      }
      const exists = listed.data?.tables.some((entry) => entry.name === table) === true;
      return exists
        ? passedResult(assertion, "sqlite_table_exists", `SQLite table exists: ${table}.`, [{
            id: `sqlite_table_exists:${table}`,
            kind: "sqlite_table_exists",
            message: `SQLite table exists: ${table}.`,
            tool: context.toolName,
            data: { table, dbPath },
          }], [{ kind: "table", id: table, metadata: { dbPath } }], table)
        : failedResult(assertion, "sqlite_table_exists", `SQLite table does not exist: ${table}.`, "exists", "missing");
    }

    case "sqlite_table_not_exists": {
      const table = String(pathValue(root, assertion.tablePath) ?? "");
      const dbPath = optionalStringValue(root, assertion.dbPathPath);
      if (!table) {
        return failedResult(assertion, "sqlite_table_not_exists", `${assertion.tablePath} did not resolve to a table name.`);
      }
      const listed = listTables(dbPath);
      if (!listed.ok) {
        return failedResult(assertion, "sqlite_table_not_exists", listed.error ?? "Unable to list SQLite tables.");
      }
      const exists = listed.data?.tables.some((entry) => entry.name === table) === true;
      return !exists
        ? passedResult(assertion, "sqlite_table_not_exists", `SQLite table does not exist: ${table}.`, [{
            id: `sqlite_table_not_exists:${table}`,
            kind: "sqlite_table_not_exists",
            message: `SQLite table does not exist: ${table}.`,
            tool: context.toolName,
            data: { table, dbPath },
          }], [], table)
        : failedResult(assertion, "sqlite_table_not_exists", `SQLite table still exists: ${table}.`, "missing", "exists");
    }

    case "written_hashes_match":
      return await runWrittenHashesMatch(assertion, context);
  }
}

export async function runAssertions(
  assertions: ToolContractAssertion[],
  context: AssertionContext,
): Promise<AssertionRunResult> {
  const results: AssertionResult[] = [];
  for (const assertion of assertions) {
    results.push(await runAssertion(assertion, context));
  }

  const requiredFailures = results.filter((result) => result.status === "failed" && result.severity === "required");
  const facts = results.flatMap((result) => result.facts ?? []);
  const artifacts = uniqueArtifacts(results.flatMap((result) => result.artifacts ?? []));
  return {
    status: requiredFailures.length === 0 ? "passed" : "failed",
    assertions: results,
    facts,
    artifacts,
  };
}
