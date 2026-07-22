import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { canonicalHash, canonicalStringify } from "./canonical.js";
import type {
  EvaluationArtifactReference,
  EvaluationCaptureMode,
} from "./contracts.js";
import { sanitizeEvaluationValue } from "./redaction.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export class EvaluationStorage {
  readonly evaluationDirectory: string;

  constructor(
    readonly evaluationRoot: string,
    readonly evaluationId: string,
    readonly capture: EvaluationCaptureMode,
  ) {
    this.evaluationRoot = resolve(evaluationRoot);
    const segment = safeSegment(evaluationId);
    if (segment !== evaluationId) {
      throw new Error(`Unsafe evaluation id: ${evaluationId}`);
    }
    this.evaluationDirectory = resolve(this.evaluationRoot, segment);
    assertContained(this.evaluationRoot, this.evaluationDirectory);
    if (this.evaluationDirectory === this.evaluationRoot) {
      throw new Error("Evaluation directory must be a child of the evaluation root.");
    }
  }

  async initialize(): Promise<void> {
    await secureMkdir(this.evaluationDirectory);
    await Promise.all([
      secureMkdir(this.path("artifacts")),
      secureMkdir(this.path("operations")),
      secureMkdir(this.path("requests")),
      secureMkdir(this.path("runs")),
    ]);
  }

  path(...parts: string[]): string {
    const target = resolve(this.evaluationDirectory, ...parts);
    assertContained(this.evaluationDirectory, target);
    return target;
  }

  relativePath(target: string): string {
    assertContained(this.evaluationDirectory, resolve(target));
    return relative(this.evaluationDirectory, target).split(sep).join("/");
  }

  async ensureRun(runId: string): Promise<string> {
    const directory = this.path("runs", safeSegment(runId));
    await secureMkdir(directory);
    return directory;
  }

  async appendEventLine(value: unknown): Promise<void> {
    const target = this.path("events.jsonl");
    await secureMkdir(dirname(target));
    await appendFile(target, `${canonicalStringify(value)}\n`, { encoding: "utf8", mode: FILE_MODE });
    await chmod(target, FILE_MODE);
  }

  async writeAtomic(relativePath: string, value: unknown): Promise<void> {
    const target = this.path(relativePath);
    await secureMkdir(dirname(target));
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
    await chmod(temporary, FILE_MODE);
    await rename(temporary, target);
    await chmod(target, FILE_MODE);
  }

  async writeTextAtomic(relativePath: string, value: string): Promise<void> {
    const target = this.path(relativePath);
    await secureMkdir(dirname(target));
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, value, { encoding: "utf8", mode: FILE_MODE });
    await chmod(temporary, FILE_MODE);
    await rename(temporary, target);
    await chmod(target, FILE_MODE);
  }

  async writeArtifact(
    kind: string,
    value: unknown,
    mediaType = "application/json",
  ): Promise<EvaluationArtifactReference> {
    const sanitized = sanitizeEvaluationValue(value, this.capture);
    const envelope = {
      schemaVersion: 1,
      kind,
      mediaType,
      capture: this.capture,
      value: sanitized,
    };
    const sha256 = canonicalHash(envelope);
    const artifactId = `artifact-${sha256}`;
    const target = this.path("artifacts", `${sha256}.json`);
    try {
      await stat(target);
    } catch {
      await this.writeAtomic(join("artifacts", `${sha256}.json`), envelope);
    }
    const sizeBytes = Buffer.byteLength(canonicalStringify(envelope));
    return {
      artifactId,
      sha256,
      path: this.relativePath(target),
      kind,
      mediaType,
      sizeBytes,
      capture: this.capture,
    };
  }

  async readJson<T>(relativePath: string): Promise<T> {
    return JSON.parse(await readFile(this.path(relativePath), "utf8")) as T;
  }
}

export async function atomicWriteOutsideEvaluation(
  root: string,
  relativePath: string,
  value: unknown,
): Promise<void> {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, relativePath);
  assertContained(resolvedRoot, target);
  await secureMkdir(dirname(target));
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
  await chmod(temporary, FILE_MODE);
  await rename(temporary, target);
}

export function assertContained(root: string, target: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`Evaluation path escapes configured root: ${normalizedTarget}`);
  }
}

export function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
    throw new Error(`Unsafe evaluation path segment: ${value}`);
  }
  return value.replaceAll(":", "_");
}

async function secureMkdir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(path, DIRECTORY_MODE);
}
