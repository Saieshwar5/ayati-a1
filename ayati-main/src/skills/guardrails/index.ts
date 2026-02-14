import { realpath } from "node:fs/promises";
import { sep, resolve } from "node:path";
import {
  getFilesystemGuardrailsPolicy,
  getShellGuardrailsPolicy,
  getConfirmationGuardrailsPolicy,
} from "../tool-access-config.js";
import type { ShellGuardrailsPolicy } from "../tool-access-config.js";
import type { ToolResult } from "../types.js";
import { requestConfirmation, verifyConfirmationToken } from "./confirmation-store.js";

export interface FilesystemGuardInput {
  action: "read" | "list" | "write" | "edit" | "create_directory" | "delete" | "move";
  path: string;
  sourcePath?: string;
  overwrite?: boolean;
  recursive?: boolean;
  confirmationToken?: string;
}

export type FilesystemGuardOutcome =
  | {
      ok: true;
      resolvedPath: string;
      resolvedSourcePath?: string;
    }
  | {
      ok: false;
      result: ToolResult;
    };

export interface ShellGuardInput {
  cmd: string;
  cwd?: string;
  confirmationToken?: string;
}

export interface ShellScriptConfirmationInput {
  scriptPath: string;
  args: string[];
  cwd?: string;
  confirmationToken?: string;
}

export type ShellGuardOutcome =
  | { ok: true; resolvedCwd?: string }
  | { ok: false; result: ToolResult };

export type ShellProfile = "read_only" | "developer" | "power_user";

export interface ShellCapabilities {
  profile: ShellProfile;
  effectiveAllowedPrefixes: string[];
  denyPrefixes: string[];
  denyOperators: string[];
  denyPatterns: string[];
  destructivePrefixes: string[];
  destructivePatterns: string[];
  allowedScriptExtensions: string[];
  maxScriptBytes: number;
  maxConcurrentSessions: number;
  sessionIdleTimeoutMs: number;
  maxSessionOutputChars: number;
}

const READ_ACTIONS = new Set<FilesystemGuardInput["action"]>(["read", "list"]);

function normalizePath(path: string): string {
  return resolve(path);
}

async function canonicalizePath(path: string): Promise<string> {
  const normalized = normalizePath(path);
  try {
    return await realpath(normalized);
  } catch {
    return normalized;
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const resolvedCandidate = normalizePath(candidate);
  const resolvedRoot = normalizePath(root);
  if (resolvedRoot === sep) return resolvedCandidate.startsWith(sep);
  if (resolvedCandidate === resolvedRoot) return true;
  return resolvedCandidate.startsWith(`${resolvedRoot}${sep}`);
}

function isInsideAnyRoot(candidate: string, roots: string[]): boolean {
  return roots.some((root) => isPathInside(candidate, root));
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(glob: string): RegExp {
  const parts = escapeRegex(glob)
    .replace(/\\\*\\\*/g, ".*")
    .replace(/\\\*/g, "[^/]*");
  return new RegExp(`^${parts}$`);
}

function matchesProtectedGlob(path: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegex(glob).test(path));
}

function isProtectedPath(path: string, protectedPaths: string[], protectedGlobs: string[]): boolean {
  if (isInsideAnyRoot(path, protectedPaths)) return true;
  return matchesProtectedGlob(path, protectedGlobs);
}

function buildFilesystemFingerprint(
  input: FilesystemGuardInput,
  resolvedPath: string,
  resolvedSourcePath?: string,
): string {
  return JSON.stringify({
    action: input.action,
    path: resolvedPath,
    sourcePath: resolvedSourcePath ?? "",
    overwrite: input.overwrite ?? false,
    recursive: input.recursive ?? false,
  });
}

function requiresFilesystemConfirmation(input: FilesystemGuardInput): boolean {
  const fsPolicy = getFilesystemGuardrailsPolicy();
  const confirmationActions = new Set(fsPolicy.requireConfirmationFor);
  if (input.action === "delete" && confirmationActions.has("delete")) return true;
  if (input.action === "move" && input.overwrite && confirmationActions.has("move_overwrite")) return true;
  return confirmationActions.has(input.action);
}

function validateFilesystemRoots(
  input: FilesystemGuardInput,
  resolvedPath: string,
  resolvedSourcePath?: string,
): ToolResult | null {
  const fsPolicy = getFilesystemGuardrailsPolicy();
  const readRoots = fsPolicy.allowedReadRoots;
  const writeRoots = fsPolicy.allowedWriteRoots;

  if (READ_ACTIONS.has(input.action)) {
    if (!isInsideAnyRoot(resolvedPath, readRoots)) {
      return { ok: false, error: `Path is outside allowed read roots: ${resolvedPath}` };
    }
    return null;
  }

  if (!isInsideAnyRoot(resolvedPath, writeRoots)) {
    return { ok: false, error: `Path is outside allowed write roots: ${resolvedPath}` };
  }
  if (input.action === "move" && resolvedSourcePath && !isInsideAnyRoot(resolvedSourcePath, writeRoots)) {
    return { ok: false, error: `Source path is outside allowed write roots: ${resolvedSourcePath}` };
  }
  return null;
}

function validateFilesystemProtection(
  input: FilesystemGuardInput,
  resolvedPath: string,
  resolvedSourcePath?: string,
): ToolResult | null {
  const fsPolicy = getFilesystemGuardrailsPolicy();
  if (READ_ACTIONS.has(input.action)) return null;

  if (isProtectedPath(resolvedPath, fsPolicy.protectedPaths, fsPolicy.protectedGlobs)) {
    return { ok: false, error: `Protected path cannot be modified: ${resolvedPath}` };
  }
  if (input.action === "move" && resolvedSourcePath && isProtectedPath(
    resolvedSourcePath,
    fsPolicy.protectedPaths,
    fsPolicy.protectedGlobs,
  )) {
    return { ok: false, error: `Protected path cannot be moved: ${resolvedSourcePath}` };
  }
  return null;
}

export function getFilesystemSearchLimits(): { maxResults: number; maxDepth: number } {
  const policy = getFilesystemGuardrailsPolicy();
  return { maxResults: policy.maxSearchResults, maxDepth: policy.maxSearchDepth };
}

export function getFilesystemListLimits(): { maxEntries: number; maxDepth: number } {
  const policy = getFilesystemGuardrailsPolicy();
  return { maxEntries: policy.maxListEntries, maxDepth: policy.maxListDepth };
}

export async function enforceFilesystemGuard(input: FilesystemGuardInput): Promise<FilesystemGuardOutcome> {
  const fsPolicy = getFilesystemGuardrailsPolicy();
  if (!fsPolicy.enabled) {
    return { ok: false, result: { ok: false, error: "Filesystem guardrails are disabled." } };
  }

  const resolvedPath = await canonicalizePath(input.path);
  const resolvedSourcePath = input.sourcePath ? await canonicalizePath(input.sourcePath) : undefined;

  const rootsErr = validateFilesystemRoots(input, resolvedPath, resolvedSourcePath);
  if (rootsErr) return { ok: false, result: rootsErr };

  const protectedErr = validateFilesystemProtection(input, resolvedPath, resolvedSourcePath);
  if (protectedErr) return { ok: false, result: protectedErr };

  const confirmationPolicy = getConfirmationGuardrailsPolicy();
  if (confirmationPolicy.enabled && requiresFilesystemConfirmation(input)) {
    const fingerprint = buildFilesystemFingerprint(input, resolvedPath, resolvedSourcePath);
    const tokenValidation = verifyConfirmationToken(input.confirmationToken, fingerprint);
    if (tokenValidation) return { ok: false, result: tokenValidation };
    if (!input.confirmationToken) {
      return {
        ok: false,
        result: requestConfirmation(fingerprint, {
          action: input.action,
          path: resolvedPath,
          sourcePath: resolvedSourcePath,
        }),
      };
    }
  }

  return { ok: true, resolvedPath, resolvedSourcePath };
}

function tokenizeCommand(cmd: string): string[] {
  return cmd
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function commandPrefix(cmd: string): string {
  const [prefix] = tokenizeCommand(cmd);
  return prefix ?? "";
}

function containsDangerousOperator(cmd: string, denyOperators: string[]): string | undefined {
  return denyOperators.find((op) => cmd.includes(op));
}

function matchesPattern(cmd: string, patterns: string[]): string | undefined {
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, "i").test(cmd)) return pattern;
    } catch {
      continue;
    }
  }
  return undefined;
}

function buildShellFingerprint(cmd: string, cwd?: string): string {
  return JSON.stringify({ cmd, cwd: cwd ?? "" });
}

function buildShellScriptFingerprint(input: ShellScriptConfirmationInput): string {
  return JSON.stringify({
    scriptPath: input.scriptPath,
    args: input.args,
    cwd: input.cwd ?? "",
  });
}

function uniqueStrings(input: string[]): string[] {
  return [...new Set(input)];
}

function getProfilePrefixes(policy: ShellGuardrailsPolicy): string[] {
  if (policy.profile === "read_only") return policy.readOnlyPrefixes;
  if (policy.profile === "power_user") return policy.powerUserPrefixes;
  return policy.developerPrefixes;
}

function getEffectiveAllowedPrefixes(policy: ShellGuardrailsPolicy): string[] {
  return uniqueStrings([...getProfilePrefixes(policy), ...policy.allowedPrefixes]);
}

export function getShellCapabilities(): ShellCapabilities {
  const policy = getShellGuardrailsPolicy();
  return {
    profile: policy.profile,
    effectiveAllowedPrefixes: getEffectiveAllowedPrefixes(policy),
    denyPrefixes: [...policy.denyPrefixes],
    denyOperators: [...policy.denyOperators],
    denyPatterns: [...policy.denyPatterns],
    destructivePrefixes: [...policy.destructivePrefixes],
    destructivePatterns: [...policy.destructivePatterns],
    allowedScriptExtensions: [...policy.allowedScriptExtensions],
    maxScriptBytes: policy.maxScriptBytes,
    maxConcurrentSessions: policy.maxConcurrentSessions,
    sessionIdleTimeoutMs: policy.sessionIdleTimeoutMs,
    maxSessionOutputChars: policy.maxSessionOutputChars,
  };
}

export async function enforceShellScriptPath(scriptPath: string): Promise<{ ok: true; resolvedPath: string } | {
  ok: false;
  result: ToolResult;
}> {
  const fsPolicy = getFilesystemGuardrailsPolicy();
  const resolvedPath = await canonicalizePath(scriptPath);
  if (!isInsideAnyRoot(resolvedPath, fsPolicy.allowedWriteRoots)) {
    return {
      ok: false,
      result: { ok: false, error: `Script path is outside allowed roots: ${resolvedPath}` },
    };
  }
  if (isProtectedPath(resolvedPath, fsPolicy.protectedPaths, fsPolicy.protectedGlobs)) {
    return {
      ok: false,
      result: { ok: false, error: `Script path is protected: ${resolvedPath}` },
    };
  }
  return { ok: true, resolvedPath };
}

export async function enforceShellGuard(input: ShellGuardInput): Promise<ShellGuardOutcome> {
  const shellPolicy = getShellGuardrailsPolicy();
  if (!shellPolicy.enabled) {
    return { ok: false, result: { ok: false, error: "Shell guardrails are disabled." } };
  }

  const prefix = commandPrefix(input.cmd);
  if (prefix.length === 0) {
    return { ok: false, result: { ok: false, error: "Command cannot be empty." } };
  }

  if (shellPolicy.denyPrefixes.includes(prefix)) {
    return { ok: false, result: { ok: false, error: `Dangerous shell command prefix is blocked: ${prefix}` } };
  }

  const matchedPattern = matchesPattern(input.cmd, shellPolicy.denyPatterns);
  if (matchedPattern) {
    return { ok: false, result: { ok: false, error: `Shell command blocked by deny pattern: ${matchedPattern}` } };
  }

  const matchedOperator = containsDangerousOperator(input.cmd, shellPolicy.denyOperators);
  if (matchedOperator) {
    return { ok: false, result: { ok: false, error: `Shell command blocked due to operator: ${matchedOperator}` } };
  }

  const allowedPrefixes = getEffectiveAllowedPrefixes(shellPolicy);
  if (allowedPrefixes.length > 0 && !allowedPrefixes.includes(prefix)) {
    return { ok: false, result: { ok: false, error: `Shell command prefix is not allowed: ${prefix}` } };
  }

  const resolvedCwd = input.cwd ? await canonicalizePath(input.cwd) : undefined;
  if (!shellPolicy.allowAnyCwd && resolvedCwd) {
    const fsPolicy = getFilesystemGuardrailsPolicy();
    if (!isInsideAnyRoot(resolvedCwd, fsPolicy.allowedWriteRoots)) {
      return {
        ok: false,
        result: { ok: false, error: `cwd is outside allowed roots: ${resolvedCwd}` },
      };
    }
  }

  const confirmationPolicy = getConfirmationGuardrailsPolicy();
  const destructivePattern = matchesPattern(input.cmd, shellPolicy.destructivePatterns);
  const destructive = shellPolicy.destructivePrefixes.includes(prefix) || destructivePattern !== undefined;
  const needsConfirm = confirmationPolicy.enabled
    && shellPolicy.requireConfirmationFor.includes("destructive")
    && destructive;
  if (needsConfirm) {
    const fingerprint = buildShellFingerprint(input.cmd, resolvedCwd);
    const tokenValidation = verifyConfirmationToken(input.confirmationToken, fingerprint);
    if (tokenValidation) return { ok: false, result: tokenValidation };
    if (!input.confirmationToken) {
      return {
        ok: false,
        result: requestConfirmation(fingerprint, {
          action: "shell_destructive",
          cmd: input.cmd,
          cwd: resolvedCwd ?? "",
          matchedPattern: destructivePattern ?? "",
        }),
      };
    }
  }

  return { ok: true, resolvedCwd };
}

export function enforceShellScriptConfirmation(
  input: ShellScriptConfirmationInput,
): { ok: true } | { ok: false; result: ToolResult } {
  const shellPolicy = getShellGuardrailsPolicy();
  const confirmationPolicy = getConfirmationGuardrailsPolicy();
  const needsConfirm = confirmationPolicy.enabled && shellPolicy.requireConfirmationFor.includes("script");
  if (!needsConfirm) return { ok: true };

  const fingerprint = buildShellScriptFingerprint(input);
  const tokenValidation = verifyConfirmationToken(input.confirmationToken, fingerprint);
  if (tokenValidation) return { ok: false, result: tokenValidation };
  if (!input.confirmationToken) {
    return {
      ok: false,
      result: requestConfirmation(fingerprint, {
        action: "shell_script",
        scriptPath: input.scriptPath,
        args: input.args,
        cwd: input.cwd ?? "",
      }),
    };
  }
  return { ok: true };
}
