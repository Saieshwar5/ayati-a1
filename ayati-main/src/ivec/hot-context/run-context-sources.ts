import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import { hotRecentDocuments } from "../recent-document-registry.js";
import type { HotContextSourceEntry } from "./contracts.js";
import {
  buildRecentFilesHotContextEntry,
  FILES_RECENT_HOT_CONTEXT_KEY,
} from "./files-recent-source.js";
import {
  buildRecentWorkstreamsHotContextEntry,
  WORKSTREAMS_RECENT_HOT_CONTEXT_KEY,
} from "./workstreams-recent-source.js";
import {
  buildRecentWorkStatesHotContextEntry,
  WORKSTATES_RECENT_HOT_CONTEXT_KEY,
} from "./workstates-recent-source.js";

export const RUN_SCOPED_HOT_CONTEXT_KEYS = [
  FILES_RECENT_HOT_CONTEXT_KEY,
  WORKSTREAMS_RECENT_HOT_CONTEXT_KEY,
  WORKSTATES_RECENT_HOT_CONTEXT_KEY,
] as const;

export function buildRunHotContextEntries(input: {
  context: ContextEngineMachineContext | undefined;
}): HotContextSourceEntry[] {
  const entries: Array<HotContextSourceEntry | undefined> = [
    buildRecentFilesHotContextEntry(
      hotRecentDocuments(input.context?.agentStream.recentFiles ?? []),
    ),
    buildRecentWorkstreamsHotContextEntry(
      input.context?.agentStream.recentWorkstreams ?? [],
    ),
    buildRecentWorkStatesHotContextEntry(
      input.context?.agentStream.recentWorkStates ?? [],
    ),
  ];
  return entries.filter((entry): entry is HotContextSourceEntry => entry !== undefined);
}
