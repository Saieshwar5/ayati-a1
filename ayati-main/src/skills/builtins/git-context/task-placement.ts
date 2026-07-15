import { basename, isAbsolute, relative, resolve } from "node:path";
import type { ActiveContext, TaskPlacement } from "ayati-git-context";

export type TaskPlacementEvidence =
  | {
      source: "current_user_message";
    }
  | {
      source: "verified_read";
      readContextKey: string;
    };

export type TaskPlacementInput =
  | {
      mode: "managed";
    }
  | {
      mode: "requested";
      path: string;
    };

export type TaskPlacementResolution =
  | {
      ok: true;
      placement: TaskPlacement;
      evidence?: TaskPlacementEvidence;
    }
  | {
      ok: false;
      message: string;
    };

export function parseTaskPlacement(value: unknown): TaskPlacementInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value["mode"] === "managed") {
    return Object.keys(value).every((key) => key === "mode")
      ? { mode: "managed" }
      : undefined;
  }
  if (value["mode"] !== "requested") {
    return undefined;
  }
  const path = nonEmptyString(value["path"]);
  if (!path
    || !Object.keys(value).every((key) => key === "mode" || key === "path")) {
    return undefined;
  }
  return { mode: "requested", path };
}

export function resolveTaskPlacement(
  placement: TaskPlacementInput,
  active: ActiveContext,
  workspaceRoot: string,
): TaskPlacementResolution {
  const userMessage = latestUserMessage(active);
  if (placement.mode === "managed") {
    if (refersToRequestedLocation(userMessage)) {
      return {
        ok: false,
        message: "The current request refers to a requested directory. Use requested placement with the exact path; managed placement cannot silently replace it.",
      };
    }
    return { ok: true, placement: { mode: "managed" } };
  }

  const requestedPath = requestedPathIdentity(placement.path, workspaceRoot);
  if (pathAppearsIn(requestedPath, userMessage)) {
    return {
      ok: true,
      placement: {
        mode: "requested",
        workingDirectory: requestedPath.canonicalPath,
      },
      evidence: { source: "current_user_message" },
    };
  }

  const readEntry = active.readContext?.entries.find(
    (entry) => pathAppearsIn(requestedPath, JSON.stringify(entry)),
  );
  if (!readEntry) {
    return {
      ok: false,
      message: "Requested placement path is not supported by the current user message or verified read context.",
    };
  }

  return {
    ok: true,
    placement: {
      mode: "requested",
      workingDirectory: requestedPath.canonicalPath,
    },
    evidence: {
      source: "verified_read",
      readContextKey: readEntry.key,
    },
  };
}

function latestUserMessage(active: ActiveContext): string {
  const messages = (active.session?.pendingConversationContext ?? [])
    .flatMap((conversation) => conversation.messages)
    .filter((message) => message.role === "user");
  return messages.at(-1)?.content ?? "";
}

function refersToRequestedLocation(message: string): boolean {
  const normalized = message.toLowerCase();
  return /\b(?:requested|specified|chosen|given|mentioned|required|target|output)\b[^.\n]{0,80}\b(?:directory|folder|path|location)\b/.test(normalized)
    || /\b(?:directory|folder|path|location)\b[^.\n]{0,80}\b(?:requested|specified|chosen|given|mentioned|required|target|output)\b/.test(normalized)
    || /(?:^|\s)(?:workspace|work_space)\/[a-z0-9._~@%+\-/]+/i.test(message)
    || /(?:^|\s)(?:~\/|\/)[a-z0-9._~@%+\-/]+/i.test(message);
}

interface RequestedPathIdentity {
  canonicalPath: string;
  evidenceForms: string[];
}

function requestedPathIdentity(path: string, workspaceRoot: string): RequestedPathIdentity {
  const root = resolve(workspaceRoot);
  const normalizedInput = normalizedPath(path);
  const workspaceAliases = new Set(["workspace", "work_space", basename(root).toLowerCase()]);
  const parts = normalizedInput.split("/").filter((part) => part && part !== ".");
  while (!isAbsolute(normalizedInput)
    && parts[0]
    && workspaceAliases.has(parts[0].toLowerCase())) {
    parts.shift();
  }
  const canonicalPath = isAbsolute(normalizedInput)
    ? resolve(normalizedInput)
    : resolve(root, parts.join("/"));
  const forms = new Set<string>([normalizedInput, normalizedPath(canonicalPath)]);
  const workspaceRelative = relative(root, canonicalPath);
  if (workspaceRelative
    && !workspaceRelative.startsWith("..")
    && !isAbsolute(workspaceRelative)) {
    const relativeForm = normalizedPath(workspaceRelative);
    forms.add(relativeForm);
    forms.add("workspace/" + relativeForm);
    forms.add("work_space/" + relativeForm);
    forms.add(normalizedPath(basename(root) + "/" + relativeForm));
  }
  return {
    canonicalPath,
    evidenceForms: [...forms].filter(Boolean),
  };
}

function pathAppearsIn(path: RequestedPathIdentity, text: string): boolean {
  const normalizedText = normalize(text);
  return path.evidenceForms.some((form) => containsPathToken(normalizedText, normalize(form)));
}

function containsPathToken(text: string, path: string): boolean {
  let start = text.indexOf(path);
  while (start >= 0) {
    if (!continuesPathAt(text, start - 1, -1)
      && !continuesPathAt(text, start + path.length, 1)) {
      return true;
    }
    start = text.indexOf(path, start + 1);
  }
  return false;
}

function continuesPathAt(text: string, index: number, direction: -1 | 1): boolean {
  const value = text[index];
  if (!value) return false;
  if (value !== ".") return /[a-z0-9_~@%+\-/]/i.test(value);
  const neighbor = text[index + direction];
  return Boolean(neighbor && /[a-z0-9_-]/i.test(neighbor));
}

function normalize(value: string): string {
  return normalizedPath(value).toLowerCase();
}

function normalizedPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/+$/g, "");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
