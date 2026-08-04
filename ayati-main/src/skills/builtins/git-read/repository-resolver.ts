import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { requireAbsoluteFilesystemPath } from "../../../shared/filesystem-paths.js";
import type { GitRepositoryIdentity } from "./contracts.js";
import { runReadOnlyGit } from "./git-process.js";

export async function resolveGitRepository(
  repositoryPath: string,
  protectedWorkstreamRoot: string,
): Promise<GitRepositoryIdentity> {
  const required = requireAbsoluteFilesystemPath(repositoryPath, "repositoryPath");
  if (!required.ok) throw new Error(required.message);
  const requested = await realpath(required.absolutePath);
  const requestedStat = await stat(requested);
  if (!requestedStat.isDirectory()) {
    throw new Error("repositoryPath must identify a Git repository directory.");
  }

  const bare = (await runReadOnlyGit(requested, ["rev-parse", "--is-bare-repository"]))
    .stdout.trim() === "true";
  const exactRoot = bare
    ? await realpath((await runReadOnlyGit(requested, ["rev-parse", "--absolute-git-dir"])).stdout.trim())
    : await realpath((await runReadOnlyGit(requested, ["rev-parse", "--show-toplevel"])).stdout.trim());
  if (resolve(requested) !== resolve(exactRoot)) {
    throw new Error(`repositoryPath must be the exact Git repository root: ${exactRoot}`);
  }

  const [headResult, branchResult] = await Promise.all([
    runReadOnlyGit(exactRoot, ["rev-parse", "--verify", "HEAD"], { allowedExitCodes: [0, 1, 128] }),
    runReadOnlyGit(exactRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowedExitCodes: [0, 1] }),
  ]);
  const protectedRoot = await canonicalProtectedRoot(protectedWorkstreamRoot);
  return {
    path: exactRoot,
    bare,
    ...(headResult.exitCode === 0 && headResult.stdout.trim()
      ? { head: headResult.stdout.trim().toLowerCase() }
      : {}),
    ...(branchResult.exitCode === 0 && branchResult.stdout.trim()
      ? { branch: branchResult.stdout.trim() }
      : {}),
    protectedWorkstream: resolve(exactRoot) === resolve(protectedRoot),
  };
}

export async function assertRepositoryIdentityUnchanged(
  before: GitRepositoryIdentity,
  protectedWorkstreamRoot: string,
): Promise<void> {
  const after = await resolveGitRepository(before.path, protectedWorkstreamRoot);
  if (
    after.path !== before.path
    || after.bare !== before.bare
    || after.head !== before.head
    || after.branch !== before.branch
    || after.protectedWorkstream !== before.protectedWorkstream
  ) {
    throw new Error("Repository identity or HEAD changed during the read-only Git operation.");
  }
}

async function canonicalProtectedRoot(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
