import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { GitMemoryWorktreeGitDriver } from "./git-driver.js";
import {
  parseGitMemoryConversationMessageFiles,
  parseGitMemoryConversationMarkdown,
  renderGitMemoryConversationMessageFile,
} from "./conversation-markdown.js";
import type {
  GitMemoryConversationRecord,
  GitMemorySessionAttachmentRecord,
  GitMemorySessionAttachmentsFile,
  GitMemorySessionId,
  GitMemorySessionMetaFile,
} from "./schema.js";
import {
  GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH,
  GIT_MEMORY_SESSION_META_PATH,
  GIT_MEMORY_SESSION_STORE_DIR,
  gitMemorySessionStoreAttachmentsPath,
  gitMemorySessionStoreMessagePath,
  gitMemorySessionStoreMessagesDir,
  gitMemorySessionStoreMetaPath,
  isGitMemorySessionId,
} from "./schema.js";
import { pathExists } from "./session-store-paths.js";
import { prettyJson } from "./session-store-renderers.js";

export const GIT_MEMORY_MAIN_REF = "refs/heads/main";

export async function readWorkingConversation(
  driver: GitMemoryWorktreeGitDriver,
): Promise<GitMemoryConversationRecord[]> {
  const markdown = await driver.readWorkingFile(GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH)
    ?? await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_CONVERSATION_MARKDOWN_PATH);
  return parseGitMemoryConversationMarkdown(markdown);
}

export async function readSessionConversation(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
): Promise<GitMemoryConversationRecord[]> {
  const records = await readSessionMessageStoreConversation(driver, sessionId);
  if (records.length > 0) {
    return records;
  }
  return await readWorkingConversation(driver);
}

export async function readSessionMessageStoreConversation(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
): Promise<GitMemoryConversationRecord[]> {
  const messageStore = await openExistingSessionMessageStoreDriver(driver);
  if (!messageStore) {
    return [];
  }
  const workingRecords = await readWorkingSessionMessageStoreConversation(messageStore, sessionId);
  if (workingRecords.length > 0) {
    return workingRecords;
  }
  const paths = (await messageStore.listTreePaths(GIT_MEMORY_MAIN_REF, gitMemorySessionStoreMessagesDir(sessionId)))
    .filter((path) => path.endsWith(".md"))
    .sort();
  if (paths.length === 0) {
    return [];
  }
  return parseGitMemoryConversationMessageFiles(await Promise.all(paths.map(async (path) => ({
    path,
    content: await messageStore.readFile(GIT_MEMORY_MAIN_REF, path),
  }))));
}

export async function writeSessionMessageStoreWorkingRecord(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
  record: GitMemoryConversationRecord,
): Promise<void> {
  const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
  const messagePath = gitMemorySessionStoreMessagePath(sessionId, record.seq, record.role);
  await messageStore.writeWorkingFiles({
    [messagePath]: renderGitMemoryConversationMessageFile(record, { sessionId }),
  });
}

export async function readSessionMessageStoreAttachments(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
): Promise<GitMemorySessionAttachmentsFile | null> {
  const messageStore = await openExistingSessionMessageStoreDriver(driver);
  if (!messageStore) {
    return null;
  }
  const path = gitMemorySessionStoreAttachmentsPath(sessionId);
  return normalizeSessionAttachmentsFile(
    sessionId,
    parseJson<GitMemorySessionAttachmentsFile>(
      await messageStore.readWorkingFile(path)
        ?? await messageStore.readFile(GIT_MEMORY_MAIN_REF, path),
    ),
  );
}

export async function writeSessionMessageStoreAttachments(
  driver: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
  file: GitMemorySessionAttachmentsFile,
): Promise<void> {
  const messageStore = await driver.openSubmoduleRepo(GIT_MEMORY_SESSION_STORE_DIR);
  await messageStore.writeWorkingFiles({
    [gitMemorySessionStoreAttachmentsPath(sessionId)]: prettyJson(file),
  });
}

export async function openExistingSessionMessageStoreDriver(
  driver: GitMemoryWorktreeGitDriver,
): Promise<GitMemoryWorktreeGitDriver | null> {
  const repoPath = join(driver.repoPath, GIT_MEMORY_SESSION_STORE_DIR);
  if (!(await pathExists(join(repoPath, ".git")))) {
    return null;
  }
  return new GitMemoryWorktreeGitDriver(repoPath);
}

export async function readSessionMeta(
  driver: GitMemoryWorktreeGitDriver,
  fallbackSessionId: string,
): Promise<GitMemorySessionMetaFile | null> {
  const messageStore = await openExistingSessionMessageStoreDriver(driver);
  const sessionStoreMeta = messageStore
    && isGitMemorySessionId(fallbackSessionId)
    ? parseJson<GitMemorySessionMetaFile>(
      await messageStore.readFile(GIT_MEMORY_MAIN_REF, gitMemorySessionStoreMetaPath(fallbackSessionId)),
    )
    : null;
  if (sessionStoreMeta) {
    return sessionStoreMeta;
  }
  return parseJson<GitMemorySessionMetaFile>(
    await driver.readFile(GIT_MEMORY_MAIN_REF, GIT_MEMORY_SESSION_META_PATH),
  );
}

export function normalizeSessionAttachmentsFile(
  sessionId: GitMemorySessionId,
  file: GitMemorySessionAttachmentsFile | null,
): GitMemorySessionAttachmentsFile | null {
  if (!file || file.schemaVersion !== 1 || file.sessionId !== sessionId) {
    return null;
  }
  return {
    schemaVersion: 1,
    sessionId,
    updatedAt: typeof file.updatedAt === "string" ? file.updatedAt : "",
    attachments: Array.isArray(file.attachments)
      ? file.attachments.filter(isGitMemorySessionAttachmentRecord).sort(compareSessionAttachments)
      : [],
  };
}

export function isGitMemorySessionAttachmentRecord(value: unknown): value is GitMemorySessionAttachmentRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.sessionAssetId === "string"
    && record.sessionAssetId.trim().length > 0
    && typeof record.kind === "string"
    && record.kind.trim().length > 0
    && typeof record.name === "string"
    && record.name.trim().length > 0
    && typeof record.source === "string"
    && record.source.trim().length > 0
    && isSessionAttachmentStatus(record.status)
    && typeof record.createdAt === "string"
    && record.createdAt.trim().length > 0;
}

export function compareSessionAttachments(
  left: GitMemorySessionAttachmentRecord,
  right: GitMemorySessionAttachmentRecord,
): number {
  const leftTime = left.lastUsedAt ?? left.createdAt;
  const rightTime = right.lastUsedAt ?? right.createdAt;
  return leftTime.localeCompare(rightTime) || left.sessionAssetId.localeCompare(right.sessionAssetId);
}

async function readWorkingSessionMessageStoreConversation(
  messageStore: GitMemoryWorktreeGitDriver,
  sessionId: GitMemorySessionId,
): Promise<GitMemoryConversationRecord[]> {
  const messageDir = gitMemorySessionStoreMessagesDir(sessionId);
  const absoluteMessageDir = join(messageStore.repoPath, messageDir);
  const entries = await readdir(absoluteMessageDir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => `${messageDir}/${entry.name}`)
    .sort();
  if (files.length === 0) {
    return [];
  }
  return parseGitMemoryConversationMessageFiles(await Promise.all(files.map(async (path) => ({
    path,
    content: await messageStore.readWorkingFile(path),
  }))));
}

function isSessionAttachmentStatus(value: unknown): value is GitMemorySessionAttachmentRecord["status"] {
  return value === "ready" || value === "partial" || value === "failed" || value === "unsupported";
}

function parseJson<T>(value: string | null): T | null {
  if (!value?.trim()) {
    return null;
  }
  return JSON.parse(value) as T;
}
