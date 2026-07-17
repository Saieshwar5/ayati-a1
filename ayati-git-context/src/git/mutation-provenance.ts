import type {
  MutationProvenance,
  ResolvedMutationTarget,
} from "../contracts.js";
import { runGit, runGitRaw } from "./git-process.js";

export async function readMutationProvenance(
  checkoutPath: string,
  targets: ResolvedMutationTarget[],
  baseline: "head" | "index" = "head",
  options: { excludedPathPrefixes?: string[]; includedPaths?: string[] } = {},
): Promise<MutationProvenance> {
  const difference = await runGitRaw([
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    ...(baseline === "head" ? ["HEAD"] : []),
    "--",
  ], { cwd: checkoutPath });
  const created = new Set<string>();
  const modified = new Set<string>();
  const deleted = new Set<string>();
  const renamed: Array<{ from: string; to: string }> = [];
  parseDifference(difference, { created, modified, deleted, renamed });

  for (const path of await readOtherPaths(checkoutPath, false)) {
    created.add(path);
  }
  for (const path of await readOtherPaths(checkoutPath, true)) {
    created.add(path);
  }
  await detectExactRenames(checkoutPath, created, deleted, renamed, baseline);

  const excluded = options.excludedPathPrefixes ?? [];
  for (const collection of [created, modified, deleted]) {
    for (const path of collection) {
      if (isExcluded(path, excluded, options.includedPaths ?? [])) collection.delete(path);
    }
  }
  for (let index = renamed.length - 1; index >= 0; index -= 1) {
    const item = renamed[index];
    if (item
      && isExcluded(item.from, excluded, options.includedPaths ?? [])
      && isExcluded(item.to, excluded, options.includedPaths ?? [])) {
      renamed.splice(index, 1);
    }
  }

  const changedPaths = new Set<string>([
    ...created,
    ...modified,
    ...deleted,
    ...renamed.flatMap((item) => [item.from, item.to]),
  ]);
  const unexpectedPaths = [...changedPaths]
    .filter((path) => !isAuthorizedPath(path, targets))
    .sort();
  return {
    created: [...created].sort(),
    modified: [...modified].sort(),
    deleted: [...deleted].sort(),
    renamed: renamed.sort((left, right) => left.from.localeCompare(right.from)),
    unexpectedPaths,
  };
}

function isExcluded(path: string, prefixes: string[], includedPaths: string[]): boolean {
  return !includedPaths.includes(path)
    && prefixes.some((prefix) => path === prefix || path.startsWith(prefix));
}

async function detectExactRenames(
  checkoutPath: string,
  created: Set<string>,
  deleted: Set<string>,
  renamed: Array<{ from: string; to: string }>,
  baseline: "head" | "index",
): Promise<void> {
  const createdByObject = new Map<string, string[]>();
  for (const path of created) {
    const object = await runGit(["hash-object", "--", path], { cwd: checkoutPath });
    const paths = createdByObject.get(object) ?? [];
    paths.push(path);
    createdByObject.set(object, paths);
  }
  for (const path of [...deleted]) {
    const object = await runGit([
      "rev-parse",
      (baseline === "head" ? "HEAD:" : ":") + path,
    ], { cwd: checkoutPath });
    const destinations = createdByObject.get(object);
    const destination = destinations?.shift();
    if (!destination) {
      continue;
    }
    deleted.delete(path);
    created.delete(destination);
    renamed.push({ from: path, to: destination });
  }
}

export function hasMutationChanges(provenance: MutationProvenance): boolean {
  return provenance.created.length > 0
    || provenance.modified.length > 0
    || provenance.deleted.length > 0
    || provenance.renamed.length > 0;
}

function parseDifference(
  value: string,
  output: {
    created: Set<string>;
    modified: Set<string>;
    deleted: Set<string>;
    renamed: Array<{ from: string; to: string }>;
  },
): void {
  const tokens = value.split("\0");
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index];
    index += 1;
    if (!status) {
      continue;
    }
    const path = tokens[index];
    index += 1;
    if (!path) {
      continue;
    }
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const destination = tokens[index];
      index += 1;
      if (destination) {
        output.renamed.push({ from: path, to: destination });
      }
    } else if (kind === "A") {
      output.created.add(path);
    } else if (kind === "D") {
      output.deleted.add(path);
    } else {
      output.modified.add(path);
    }
  }
}

async function readOtherPaths(checkoutPath: string, ignored: boolean): Promise<string[]> {
  const output = await runGitRaw([
    "ls-files",
    "--others",
    "-z",
    ...(ignored ? ["--ignored", "--exclude-standard"] : ["--exclude-standard"]),
  ], { cwd: checkoutPath });
  return output.split("\0").filter((path) => path.length > 0);
}

function isAuthorizedPath(
  path: string,
  targets: ResolvedMutationTarget[],
): boolean {
  return targets.some((target) => {
    if (target.kind === "file") {
      return path === target.path;
    }
    return target.path === "."
      || path === target.path
      || path.startsWith(target.path + "/");
  });
}
