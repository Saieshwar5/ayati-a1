import { readFile } from "node:fs/promises";
import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";
import {
  allocatePythonArtifacts,
  buildPythonExecutionEnvironment,
  collectArtifactPaths,
  DEFAULT_MANAGED_PYTHON_INTERPRETER,
  readPythonJsonResult,
  runManagedPythonProcess,
  toRelativeArtifactPath,
  writeExecutionManifest,
  writePythonRequest,
  writePythonScript,
  type PythonSkillRuntimeDeps,
} from "./runtime.js";
import {
  validatePythonExecuteInput,
  validatePythonInspectDatasetInput,
  type PythonExecuteInput,
  type PythonInspectDatasetInput,
} from "./validators.js";

const PYTHON_INSPECT_HELPER = String.raw`import json
import math
import os
import sqlite3
from pathlib import Path

import pandas as pd


def to_safe_value(value):
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
    if value is pd.NaT:
        return None
    if value is None:
        return None
    return value


def frame_to_records(frame):
    records = []
    for row in frame.to_dict(orient="records"):
        safe_row = {}
        for key, value in row.items():
            safe_row[str(key)] = to_safe_value(value)
        records.append(safe_row)
    return records


def summarize_frame(frame, request, resolved_source):
    numeric_columns = list(frame.select_dtypes(include=["number"]).columns)
    categorical_columns = [col for col in frame.columns if col not in numeric_columns]
    profile_columns = bool(request.get("profileColumns", True))
    sample_rows = max(1, int(request.get("sampleRows", 10)))

    numeric_summary = {}
    if profile_columns and numeric_columns:
        described = frame[numeric_columns].describe().transpose().reset_index().rename(columns={"index": "column"})
        numeric_summary = {row["column"]: {k: to_safe_value(v) for k, v in row.items() if k != "column"} for row in described.to_dict(orient="records")}

    categorical_summary = {}
    if profile_columns:
        for column in categorical_columns[:20]:
            series = frame[column].astype("string")
            top_values = series.fillna("<null>").value_counts().head(5).to_dict()
            categorical_summary[str(column)] = {str(k): int(v) for k, v in top_values.items()}

    return {
        "resolvedSource": resolved_source,
        "sourceType": request["sourceType"],
        "rowCount": int(len(frame)),
        "columnCount": int(len(frame.columns)),
        "columns": [
            {
                "name": str(column),
                "dtype": str(frame[column].dtype),
                "nullCount": int(frame[column].isna().sum()),
            }
            for column in frame.columns
        ],
        "sampleRows": frame_to_records(frame.head(sample_rows)),
        "numericSummary": numeric_summary,
        "categoricalSummary": categorical_summary,
        "warnings": [],
    }


def load_from_path(path_str):
    path = Path(path_str)
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(path)
    if suffix == ".tsv":
        return pd.read_csv(path, sep="\t")
    if suffix == ".xlsx":
        return pd.read_excel(path)
    if suffix in (".json", ".jsonl", ".ndjson"):
        if suffix == ".json":
            return pd.read_json(path)
        return pd.read_json(path, lines=True)
    if suffix == ".parquet":
        return pd.read_parquet(path)
    raise ValueError(f"Unsupported dataset extension: {suffix or '<none>'}")


def load_from_sqlite_table(db_path, table_name):
    with sqlite3.connect(db_path) as conn:
        return pd.read_sql_query(f'SELECT * FROM "{table_name}"', conn)


def load_from_sqlite_query(db_path, sql):
    with sqlite3.connect(db_path) as conn:
        return pd.read_sql_query(sql, conn)


def main():
    request_path = Path(os.environ["AYATI_PYTHON_REQUEST_PATH"])
    result_path = Path(os.environ["AYATI_PYTHON_RESULT_PATH"])
    request = json.loads(request_path.read_text())
    source_type = request["sourceType"]

    if source_type == "path":
        frame = load_from_path(request["path"])
        payload = summarize_frame(frame, request, request["path"])
    elif source_type == "sqlite_table":
        frame = load_from_sqlite_table(request["dbPath"], request["table"])
        payload = summarize_frame(frame, request, f'{request["dbPath"]}::{request["table"]}')
    elif source_type == "sqlite_query":
        frame = load_from_sqlite_query(request["dbPath"], request["sql"])
        payload = summarize_frame(frame, request, f'{request["dbPath"]}::query')
    else:
        raise ValueError(f"Unsupported sourceType: {source_type}")

    result_path.write_text(json.dumps(payload, indent=2, default=str))


if __name__ == "__main__":
    main()
`;

export interface PythonSkillDeps extends PythonSkillRuntimeDeps {}

function buildSuccessResult(output: Record<string, unknown>, meta?: Record<string, unknown>): ToolResult {
  return {
    ok: true,
    output: JSON.stringify(output, null, 2),
    ...(meta ? { meta } : {}),
  };
}

function buildFailureResult(error: string, output?: Record<string, unknown>, meta?: Record<string, unknown>): ToolResult {
  return {
    ok: false,
    error,
    ...(output ? { output: JSON.stringify(output, null, 2) } : {}),
    ...(meta ? { meta } : {}),
  };
}

function buildCodeWrapper(userCode: string): string {
  return [
    "import json",
    "import os",
    "from pathlib import Path",
    "",
    'RUN_DIR = Path(os.environ["AYATI_PYTHON_RUN_DIR"])',
    'ARTIFACT_DIR = Path(os.environ["AYATI_PYTHON_ARTIFACT_DIR"])',
    'INPUT_FILES = json.loads(os.environ.get("AYATI_PYTHON_INPUT_FILES", "[]"))',
    'SQLITE_DB_PATHS = json.loads(os.environ.get("AYATI_PYTHON_SQLITE_DB_PATHS", "[]"))',
    "ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)",
    "",
    `USER_CODE = ${JSON.stringify(userCode)}`,
    'exec(compile(USER_CODE, "ayati_python_execute.py", "exec"), globals(), globals())',
    "",
  ].join("\n");
}

async function fileExists(pathValue: string): Promise<boolean> {
  try {
    await readFile(pathValue, "utf-8");
    return true;
  } catch {
    return false;
  }
}

async function executeInspectDataset(
  deps: PythonSkillDeps,
  parsed: PythonInspectDatasetInput,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  const artifacts = await allocatePythonArtifacts(deps, context);
  const requestPayload: Record<string, unknown> = {
    sourceType: parsed.sourceType,
    ...(parsed.path ? { path: parsed.path } : {}),
    ...(parsed.dbPath ? { dbPath: parsed.dbPath } : {}),
    ...(parsed.table ? { table: parsed.table } : {}),
    ...(parsed.sql ? { sql: parsed.sql } : {}),
    sampleRows: parsed.sampleRows ?? 10,
    profileColumns: parsed.profileColumns ?? true,
  };
  await writePythonRequest(artifacts.requestPath, requestPayload);
  await writePythonScript(artifacts.helperPath, PYTHON_INSPECT_HELPER);

  let runtime;
  try {
    runtime = await runManagedPythonProcess({
      deps,
      context,
      artifacts,
      scriptPath: artifacts.helperPath,
      args: [],
      cwd: parsed.cwd,
      timeoutMs: parsed.timeoutMs,
      maxOutputChars: parsed.maxOutputChars,
      extraEnv: {
        AYATI_PYTHON_RESULT_PATH: artifacts.resultPath,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return buildFailureResult(message, undefined, {
      runDir: artifacts.runDir,
      requestPath: artifacts.requestPath,
    });
  }

  let output: Record<string, unknown> | undefined;
  if (runtime.ok) {
    try {
      output = await readPythonJsonResult(artifacts.resultPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildFailureResult(`Python inspect did not produce a readable result: ${message}`, {
        stdoutPreview: runtime.stdoutPreview,
        stderrPreview: runtime.stderrPreview,
      }, {
        runDir: artifacts.runDir,
        resultPath: artifacts.resultPath,
      });
    }
  }

  const relativeArtifacts = [toRelativeArtifactPath(deps.dataDir, artifacts.resultPath)];
  await writeExecutionManifest({
    artifacts,
    runtime,
    relativeArtifacts,
    request: requestPayload,
  });

  const meta = {
    runDir: artifacts.runDir,
    resultPath: artifacts.resultPath,
    manifestPath: artifacts.manifestPath,
    stdoutPath: artifacts.stdoutPath,
    stderrPath: artifacts.stderrPath,
    interpreter: runtime.interpreter,
    durationMs: runtime.durationMs,
  };

  if (!runtime.ok) {
    return buildFailureResult(runtime.error ?? "Python inspect failed.", {
      stdoutPreview: runtime.stdoutPreview,
      stderrPreview: runtime.stderrPreview,
    }, meta);
  }

  return buildSuccessResult({
    ...output,
    artifacts: {
      resultPath: artifacts.resultPath,
      manifestPath: artifacts.manifestPath,
    },
    runtime: {
      interpreter: runtime.interpreter,
      durationMs: runtime.durationMs,
    },
  }, meta);
}

async function executePythonCode(
  deps: PythonSkillDeps,
  parsed: PythonExecuteInput,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  const artifacts = await allocatePythonArtifacts(deps, context);
  const requestPayload: Record<string, unknown> = {
    mode: parsed.mode,
    cwd: parsed.cwd ?? null,
    timeoutMs: parsed.timeoutMs ?? null,
    args: parsed.args ?? [],
    inputFiles: parsed.inputFiles ?? [],
    sqliteDbPaths: parsed.sqliteDbPaths ?? [],
    ...(parsed.mode === "code"
      ? { codePreview: parsed.code?.slice(0, 200) ?? "" }
      : { scriptPath: parsed.scriptPath ?? "" }),
  };
  await writePythonRequest(artifacts.requestPath, requestPayload);

  let scriptPath = artifacts.entryPath;
  let args = parsed.args ?? [];

  if (parsed.mode === "code") {
    await writePythonScript(scriptPath, buildCodeWrapper(parsed.code ?? ""));
  } else {
    if (!parsed.scriptPath || !await fileExists(parsed.scriptPath)) {
      return buildFailureResult(`Python script not found: ${parsed.scriptPath ?? ""}`);
    }
    scriptPath = parsed.scriptPath;
    await writePythonScript(artifacts.entryPath, `# External script executed: ${scriptPath}\n`);
  }

  let runtime;
  try {
    runtime = await runManagedPythonProcess({
      deps,
      context,
      artifacts,
      scriptPath,
      args,
      cwd: parsed.cwd,
      timeoutMs: parsed.timeoutMs,
      maxOutputChars: parsed.maxOutputChars,
      extraEnv: buildPythonExecutionEnvironment(parsed.inputFiles, parsed.sqliteDbPaths),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return buildFailureResult(message, undefined, {
      runDir: artifacts.runDir,
      requestPath: artifacts.requestPath,
    });
  }
  const relativeArtifacts = await collectArtifactPaths(deps, artifacts);
  await writeExecutionManifest({
    artifacts,
    runtime,
    relativeArtifacts,
    request: requestPayload,
  });

  const summary = {
    interpreter: runtime.interpreter,
    cwd: runtime.cwd,
    durationMs: runtime.durationMs,
    exitCode: runtime.exitCode,
    signal: runtime.signal,
    timedOut: runtime.timedOut,
    outputTruncated: runtime.outputTruncated,
    stdoutPreview: runtime.stdoutPreview,
    stderrPreview: runtime.stderrPreview,
    artifacts: relativeArtifacts,
    files: {
      runDir: artifacts.runDir,
      stdoutPath: artifacts.stdoutPath,
      stderrPath: artifacts.stderrPath,
      entryPath: artifacts.entryPath,
      manifestPath: artifacts.manifestPath,
    },
  };

  if (!runtime.ok) {
    return buildFailureResult(runtime.error ?? "Python execution failed.", summary, {
      runDir: artifacts.runDir,
      manifestPath: artifacts.manifestPath,
      interpreter: runtime.interpreter,
    });
  }

  return buildSuccessResult(summary, {
    runDir: artifacts.runDir,
    manifestPath: artifacts.manifestPath,
    interpreter: runtime.interpreter,
  });
}

function createInspectDatasetTool(deps: PythonSkillDeps): ToolDefinition {
  return {
    name: "python_inspect_dataset",
    description: "Inspect a dataset or SQLite source with the managed Python runtime and return schema, samples, and summary statistics.",
    inputSchema: {
      type: "object",
      required: ["sourceType"],
      properties: {
        sourceType: { type: "string", description: "One of path, sqlite_table, or sqlite_query." },
        path: { type: "string", description: "Absolute or cwd-relative dataset path for CSV, XLSX, TSV, JSON, JSONL, or Parquet files." },
        dbPath: { type: "string", description: "Optional SQLite database path. Defaults to data/sqlite/agent.sqlite." },
        table: { type: "string", description: "SQLite table name when sourceType is sqlite_table." },
        sql: { type: "string", description: "SQLite query text when sourceType is sqlite_query." },
        sampleRows: { type: "number", description: "Sample row count to include in the response. Defaults to 10." },
        profileColumns: { type: "boolean", description: "Whether to compute per-column summaries. Defaults to true." },
        cwd: { type: "string", description: "Optional working directory used to resolve relative paths." },
        timeoutMs: { type: "number", description: "Optional timeout override in milliseconds." },
        maxOutputChars: { type: "number", description: "Optional cap for stdout/stderr previews." },
      },
    },
    selectionHints: {
      tags: ["python", "data", "analysis", "csv", "xlsx", "spreadsheet", "dataset", "sqlite", "pandas", "ml"],
      aliases: ["inspect_dataset", "profile_dataset", "inspect_csv", "inspect_xlsx"],
      examples: ["inspect this CSV", "inspect this XLSX", "profile the SQLite table", "show dataset schema"],
      domain: "analysis",
      priority: 55,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = validatePythonInspectDatasetInput(input);
      if ("ok" in parsed) {
        return parsed;
      }
      return await executeInspectDataset(deps, parsed, context);
    },
  };
}

function createPythonExecuteTool(deps: PythonSkillDeps): ToolDefinition {
  return {
    name: "python_execute",
    description: "Run Python code or a Python script with the managed Python runtime for data analysis, charts, or ML workflows.",
    inputSchema: {
      type: "object",
      required: ["mode"],
      properties: {
        mode: { type: "string", description: "One of code or script." },
        code: { type: "string", description: "Inline Python code to execute when mode is code." },
        scriptPath: { type: "string", description: "Absolute or cwd-relative script path when mode is script." },
        args: { type: "array", description: "Optional script arguments." },
        cwd: { type: "string", description: "Optional working directory for execution." },
        timeoutMs: { type: "number", description: "Optional timeout override in milliseconds." },
        maxOutputChars: { type: "number", description: "Optional cap for stdout/stderr previews." },
        inputFiles: { type: "array", description: "Optional dataset file paths exposed through AYATI_PYTHON_INPUT_FILES." },
        sqliteDbPaths: { type: "array", description: "Optional SQLite database paths exposed through AYATI_PYTHON_SQLITE_DB_PATHS." },
      },
    },
    selectionHints: {
      tags: ["python", "analysis", "chart", "visualization", "machine learning", "ml", "dataframe"],
      aliases: ["python_run", "run_python", "python_exec"],
      examples: ["run Python analysis", "make a chart with matplotlib", "train a small model"],
      domain: "analysis",
      priority: 50,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = validatePythonExecuteInput(input);
      if ("ok" in parsed) {
        return parsed;
      }
      return await executePythonCode(deps, parsed, context);
    },
  };
}

const PYTHON_PROMPT_BLOCK = [
  "Managed Python data tools are built in.",
  `Always use the managed interpreter at ${DEFAULT_MANAGED_PYTHON_INTERPRETER} (or AYATI_PYTHON_INTERPRETER when explicitly configured).`,
  "Prefer python_inspect_dataset before python_execute for CSV, JSON, Parquet, SQLite analysis, or ML tasks.",
  "Prefer these Python tools over the generic shell tool whenever the job is primarily dataframe work, statistics, visualization, or machine learning.",
  "python_execute exposes AYATI_PYTHON_RUN_DIR, AYATI_PYTHON_ARTIFACT_DIR, AYATI_PYTHON_INPUT_FILES, and AYATI_PYTHON_SQLITE_DB_PATHS to the Python process.",
  "Write generated charts, reports, and derived files into AYATI_PYTHON_ARTIFACT_DIR so they are captured as run artifacts.",
  "Do not use bare python, python3, or pip through shell when these managed Python tools can do the job.",
].join("\n");

export function createPythonSkill(deps: PythonSkillDeps): SkillDefinition {
  return {
    id: "python",
    version: "1.0.0",
    description: "Managed Python runtime for dataset inspection, analysis, visualization, and ML workflows.",
    promptBlock: PYTHON_PROMPT_BLOCK,
    tools: [
      createInspectDatasetTool(deps),
      createPythonExecuteTool(deps),
    ],
  };
}
