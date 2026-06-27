import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { executeSql } from "../database/sqlite-runtime.js";
import { loadAyatiRuntimeConfig } from "../config/runtime-config.js";
import { ensureManagedPythonInterpreter, resolveManagedPythonInterpreter } from "../skills/builtins/python/runtime.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  label: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorSection {
  title: string;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  projectRoot: string;
  generatedAt: string;
  sections: DoctorSection[];
}

export interface DoctorOptions {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

const REQUIRED_NODE_PACKAGES = [
  "xlsx",
  "cheerio",
  "@lancedb/lancedb",
  "openai",
] as const;

const PYTHON_IMPORTS = [
  "pandas",
  "numpy",
  "pyarrow",
  "openpyxl",
  "matplotlib",
  "sklearn",
  "scipy",
  "seaborn",
] as const;

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const projectRoot = resolve(options.projectRoot);
  const dataDir = resolve(projectRoot, "data");
  const config = loadAyatiRuntimeConfig(env);
  const sections: DoctorSection[] = [];

  sections.push({
    title: "Runtime",
    checks: [
      {
        label: "node",
        status: "ok",
        detail: process.version,
      },
      ...REQUIRED_NODE_PACKAGES.map(checkNodePackage),
      await checkSqlite(dataDir),
    ],
  });

  sections.push({
    title: "Writable Data",
    checks: await Promise.all([
      checkWritableDir(dataDir),
      checkWritableDir(resolve(dataDir, "files")),
      checkWritableDir(resolve(dataDir, "documents")),
      checkWritableDir(resolve(dataDir, "runs")),
      checkWritableDir(resolve(dataDir, "directories")),
    ]),
  });

  sections.push({
    title: "Document Extractors",
    checks: [
      await checkPandoc(env),
      await checkTika(env),
      await checkJavaForTika(env),
    ],
  });

  sections.push({
    title: "Document Vectors",
    checks: [
      {
        label: "AYATI_DOCUMENT_VECTOR_ENABLED",
        status: config.documents.vectorEnabled ? "ok" : "warn",
        detail: config.documents.vectorEnabled
          ? `enabled; minChunks=${config.documents.vectorMinChunks}; batchSize=${config.documents.embedBatchSize}`
          : "disabled; document_query will use lexical retrieval only",
      },
      {
        label: "OPENAI_API_KEY",
        status: !config.documents.vectorEnabled || Boolean(env["OPENAI_API_KEY"]?.trim()) ? "ok" : "warn",
        detail: env["OPENAI_API_KEY"]?.trim()
          ? "present"
          : "missing; OpenAI embeddings cannot start while document vectors are enabled",
      },
    ],
  });

  sections.push({
    title: "Python Runtime",
    checks: [
      await checkPythonInterpreter(config.python.interpreterPath, env),
      await checkPythonImports(config.python.interpreterPath, env),
    ],
  });

  return {
    projectRoot,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    sections,
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines = [
    "Ayati Doctor",
    `Project: ${report.projectRoot}`,
    `Generated: ${report.generatedAt}`,
    "",
  ];

  for (const section of report.sections) {
    lines.push(section.title);
    for (const check of section.checks) {
      lines.push(`- [${check.status.toUpperCase()}] ${check.label}: ${check.detail}`);
    }
    lines.push("");
  }

  const totals = summarizeDoctorReport(report);
  lines.push(`Summary: ${totals.ok} ok, ${totals.warn} warn, ${totals.fail} fail`);
  return lines.join("\n");
}

export function summarizeDoctorReport(report: DoctorReport): Record<DoctorStatus, number> {
  const summary: Record<DoctorStatus, number> = { ok: 0, warn: 0, fail: 0 };
  for (const section of report.sections) {
    for (const check of section.checks) {
      summary[check.status]++;
    }
  }
  return summary;
}

export function hasDoctorFailures(report: DoctorReport): boolean {
  return summarizeDoctorReport(report).fail > 0;
}

function checkNodePackage(packageName: string): DoctorCheck {
  try {
    const resolved = require.resolve(packageName);
    return {
      label: packageName,
      status: "ok",
      detail: resolved,
    };
  } catch {
    return {
      label: packageName,
      status: "fail",
      detail: "missing; run pnpm install",
    };
  }
}

async function checkWritableDir(pathValue: string): Promise<DoctorCheck> {
  const marker = resolve(pathValue, ".ayati-doctor-write-test");
  try {
    await mkdir(pathValue, { recursive: true });
    await writeFile(marker, "ok\n", "utf-8");
    await rm(marker, { force: true });
    return {
      label: pathValue,
      status: "ok",
      detail: "writable",
    };
  } catch (err) {
    return {
      label: pathValue,
      status: "fail",
      detail: `not writable: ${formatError(err)}`,
    };
  }
}

async function checkSqlite(dataDir: string): Promise<DoctorCheck> {
  const doctorDir = resolve(dataDir, ".doctor");
  const dbPath = resolve(doctorDir, "doctor.sqlite");
  try {
    await mkdir(doctorDir, { recursive: true });
    const result = executeSql({
      dbPath,
      sql: "SELECT 1 AS ok",
      mode: "query",
      maxRows: 1,
    });
    await rm(dbPath, { force: true });
    if (!result.ok) {
      return {
        label: "node:sqlite",
        status: "fail",
        detail: result.error ?? "query failed",
      };
    }
    return {
      label: "node:sqlite",
      status: "ok",
      detail: "query succeeded",
    };
  } catch (err) {
    return {
      label: "node:sqlite",
      status: "fail",
      detail: formatError(err),
    };
  }
}

async function checkPandoc(env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const command = env["PANDOC_BIN"]?.trim() || "pandoc";
  const found = await commandPath(command);
  return found
    ? { label: "pandoc", status: "ok", detail: found }
    : {
      label: "pandoc",
      status: "warn",
      detail: "missing; DOCX/HTML/Markdown conversion fallback may be unavailable",
    };
}

async function checkTika(env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const jarPath = env["TIKA_JAR_PATH"]?.trim();
  if (jarPath) {
    const file = await fileIsReadable(jarPath);
    return file
      ? { label: "tika", status: "ok", detail: `jar=${jarPath}` }
      : { label: "tika", status: "warn", detail: `TIKA_JAR_PATH is not readable: ${jarPath}` };
  }

  const command = env["TIKA_BIN"]?.trim() || "tika";
  const found = await commandPath(command);
  return found
    ? { label: "tika", status: "ok", detail: found }
    : {
      label: "tika",
      status: "warn",
      detail: "missing; PDF/PPTX extraction will likely fail",
    };
}

async function checkJavaForTika(env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  if (!env["TIKA_JAR_PATH"]?.trim()) {
    return {
      label: "java",
      status: "warn",
      detail: "not required unless TIKA_JAR_PATH is used; install java for Tika JAR support",
    };
  }

  const found = await commandPath("java");
  return found
    ? { label: "java", status: "ok", detail: found }
    : { label: "java", status: "fail", detail: "missing but required by TIKA_JAR_PATH" };
}

async function checkPythonInterpreter(
  configuredInterpreter: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<DoctorCheck> {
  try {
    const interpreter = resolveManagedPythonInterpreter({
      dataDir: "",
      interpreterPath: configuredInterpreter,
    });
    await withEnv(env, async () => {
      await ensureManagedPythonInterpreter(interpreter);
    });
    return {
      label: "python interpreter",
      status: "ok",
      detail: interpreter,
    };
  } catch (err) {
    return {
      label: "python interpreter",
      status: "fail",
      detail: formatError(err),
    };
  }
}

async function checkPythonImports(
  configuredInterpreter: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<DoctorCheck> {
  const interpreter = await withEnv(env, async () => resolveManagedPythonInterpreter({
    dataDir: "",
    interpreterPath: configuredInterpreter,
  }));
  const script = `import importlib.util\nmods=${JSON.stringify([...PYTHON_IMPORTS])}\nmissing=[m for m in mods if importlib.util.find_spec(m) is None]\nprint("missing=" + ",".join(missing))\nraise SystemExit(1 if missing else 0)\n`;

  try {
    await execFileAsync(interpreter, ["-c", script], { timeout: 15_000 });
    return {
      label: "python analysis packages",
      status: "ok",
      detail: [...PYTHON_IMPORTS].join(", "),
    };
  } catch (err) {
    return {
      label: "python analysis packages",
      status: "warn",
      detail: `one or more imports failed: ${formatError(err)}`,
    };
  }
}

async function commandPath(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("sh", ["-lc", `command -v ${shellQuote(command)}`], {
      timeout: 5_000,
    });
    const pathValue = stdout.trim();
    return pathValue.length > 0 ? pathValue : null;
  } catch {
    return null;
  }
}

async function fileIsReadable(pathValue: string): Promise<boolean> {
  try {
    const info = await stat(pathValue);
    if (!info.isFile()) {
      return false;
    }
    await access(pathValue, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const previous = process.env;
  process.env = { ...previous, ...env };
  try {
    return await fn();
  } finally {
    process.env = previous;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
