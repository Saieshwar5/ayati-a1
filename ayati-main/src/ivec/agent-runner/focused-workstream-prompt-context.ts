import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import { compactOptionalText, compactText } from "../state-compaction.js";

const FOCUSED_WORKSTREAM_LIMITS = {
  purposeChars: 800,
  summaryChars: 800,
  currentFocusChars: 500,
  blockerCount: 5,
  blockerChars: 300,
  nextActionChars: 500,
  resourceCount: 10,
  resourceNameChars: 160,
} as const;

type FocusedWorkstream = NonNullable<
  ContextEngineMachineContext["agentStream"]["focusedWorkstream"]
>;

export interface PromptFocusedWorkstreamContext {
  id: string;
  title: string;
  purpose: string;
  summary: string;
  lifecycleStatus: "active" | "paused" | "archived";
  repositoryHealth: "ready" | "dirty_external";
  request: {
    id: string;
    title: string;
    status: "queued" | "active" | "blocked";
    request: string;
  };
  currentFocus?: string;
  blockers: string[];
  nextAction?: string;
  resources: Array<{
    id: string;
    name: string;
    access: "read" | "mutate";
    availability: FocusedWorkstream["resources"][number]["resource"]["availability"];
    primary: boolean;
  }>;
  otherResourceCount: number;
}

export function buildFocusedWorkstreamPromptContext(
  workstream: FocusedWorkstream | undefined,
): PromptFocusedWorkstreamContext | undefined {
  const request = workstream?.selectedRequest;
  if (!workstream || !request
    || request.status === "done"
    || request.status === "dropped") {
    return undefined;
  }
  const resources = [...workstream.resources]
    .sort((left, right) => resourcePriority(right, request.id) - resourcePriority(left, request.id))
    .slice(0, FOCUSED_WORKSTREAM_LIMITS.resourceCount)
    .map((binding) => ({
      id: binding.resource.resourceId,
      name: compactText(
        binding.resource.displayName,
        FOCUSED_WORKSTREAM_LIMITS.resourceNameChars,
      ),
      access: binding.access,
      availability: binding.resource.availability,
      primary: binding.primary,
    }));
  const currentFocus = compactOptionalText(
    workstream.currentFocus,
    FOCUSED_WORKSTREAM_LIMITS.currentFocusChars,
  );
  const nextAction = compactOptionalText(
    workstream.next,
    FOCUSED_WORKSTREAM_LIMITS.nextActionChars,
  );
  return {
    id: workstream.workstreamId,
    title: workstream.title,
    purpose: compactText(workstream.objective, FOCUSED_WORKSTREAM_LIMITS.purposeChars),
    summary: compactText(workstream.summary, FOCUSED_WORKSTREAM_LIMITS.summaryChars),
    lifecycleStatus: workstream.lifecycleStatus,
    repositoryHealth: workstream.repositoryHealth,
    request: {
      id: request.id,
      title: request.title,
      status: request.status,
      request: request.request,
    },
    ...(currentFocus ? { currentFocus } : {}),
    blockers: workstream.blockers
      .map((blocker) => compactText(blocker, FOCUSED_WORKSTREAM_LIMITS.blockerChars))
      .filter(Boolean)
      .slice(0, FOCUSED_WORKSTREAM_LIMITS.blockerCount),
    ...(nextAction ? { nextAction } : {}),
    resources,
    otherResourceCount: Math.max(0, workstream.resources.length - resources.length),
  };
}

function resourcePriority(
  binding: FocusedWorkstream["resources"][number],
  requestId: string,
): number {
  return (binding.requestIds.includes(requestId) ? 8 : 0)
    + (binding.primary ? 4 : 0)
    + (binding.access === "mutate" ? 2 : 0)
    + (binding.resource.availability === "available" ? 1 : 0);
}
