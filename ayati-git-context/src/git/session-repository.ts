import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRef } from "../contracts.js";
import { writeFileAtomically } from "../files/atomic-file.js";
import { GitContextServiceError } from "../errors.js";
import { runGit } from "./git-process.js";

interface SessionMetadata {
  sessionId: string;
  date: string;
  timezone: string;
  agentId: string;
  createdAt: string;
}

export async function ensureSessionRepository(input: {
  session: SessionRef;
  agentId: string;
  createdAt: string;
}): Promise<string> {
  const gitDirectory = join(input.session.repositoryPath, ".git");
  const metadataPath = join(input.session.repositoryPath, "session", "meta.json");
  const exists = await pathExists(gitDirectory);
  if (!exists) {
    await createRepository(input.session.repositoryPath);
  }
  const hasHead = await repositoryHasHead(input.session.repositoryPath);
  if (!hasHead) {
    await rm(join(input.session.repositoryPath, ".gitkeep"), { force: true });
    await configureRepository(input.session.repositoryPath);
    await writeFileAtomically(metadataPath, JSON.stringify(metadata(input), null, 2) + "\n");
    await runGit(["add", "--", "session/meta.json"], { cwd: input.session.repositoryPath });
    await runGit(["commit", "-m", initialCommitMessage(input)], {
      cwd: input.session.repositoryPath,
      env: commitEnvironment(input.createdAt),
    });
  } else {
    await verifyMetadata(metadataPath, input);
  }
  return await runGit(["rev-parse", "HEAD"], { cwd: input.session.repositoryPath });
}

async function createRepository(repositoryPath: string): Promise<void> {
  await writeFileAtomically(join(repositoryPath, ".gitkeep"), "");
  await runGit(["init", "--initial-branch=main"], { cwd: repositoryPath });
  await rm(join(repositoryPath, ".gitkeep"));
}

async function configureRepository(repositoryPath: string): Promise<void> {
  await runGit(["config", "user.name", "Ayati Git Context Engine"], { cwd: repositoryPath });
  await runGit(["config", "user.email", "git-context@ayati.local"], { cwd: repositoryPath });
  await runGit(["config", "commit.gpgsign", "false"], { cwd: repositoryPath });
}

async function repositoryHasHead(repositoryPath: string): Promise<boolean> {
  try {
    await runGit(["rev-parse", "--verify", "HEAD"], { cwd: repositoryPath });
    return true;
  } catch {
    return false;
  }
}

async function verifyMetadata(
  metadataPath: string,
  input: { session: SessionRef; agentId: string },
): Promise<void> {
  try {
    const value = JSON.parse(await readFile(metadataPath, "utf8")) as Partial<SessionMetadata>;
    if (value.sessionId !== input.session.sessionId
      || value.date !== input.session.date
      || value.timezone !== input.session.timezone
      || value.agentId !== input.agentId) {
      throw new Error("Session metadata does not match SQLite identity.");
    }
  } catch (error) {
    throw new GitContextServiceError({
      code: "REPOSITORY_UNAVAILABLE",
      message: "Session repository metadata is missing or inconsistent.",
      details: {
        sessionId: input.session.sessionId,
        metadataPath,
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function metadata(input: {
  session: SessionRef;
  agentId: string;
  createdAt: string;
}): SessionMetadata {
  return {
    sessionId: input.session.sessionId,
    date: input.session.date,
    timezone: input.session.timezone,
    agentId: input.agentId,
    createdAt: input.createdAt,
  };
}

function initialCommitMessage(input: { session: SessionRef }): string {
  return [
    "session: initialize " + input.session.sessionId,
    "",
    "Session-Id: " + input.session.sessionId,
    "Date: " + input.session.date,
    "Timezone: " + input.session.timezone,
    "Ayati-Event: session_initialized",
  ].join("\n");
}

function commitEnvironment(at: string): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_DATE: at,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
