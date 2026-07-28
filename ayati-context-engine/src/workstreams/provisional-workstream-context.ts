import type { ContextDatabase } from "../database/database.js";
import type { WorkstreamInitializationRecord } from "../repositories/workstream-records.js";
import { readWorkstreamRequests } from "../repositories/workstream-request-records.js";
import type { SharedWorkstreamRepositoryState } from "../repositories/workstream-repository-state-records.js";
import { buildInitialWorkstreamContext } from "./initial-workstream-context.js";
import {
  parseWorkstreamProgress,
} from "./workstream-progress.js";
import {
  WORKSTREAM_PROGRESS_PATH,
  WORKSTREAM_RESOURCES_PATH,
} from "./workstream-repository-layout.js";
import { parseWorkstreamResourceManifest } from "./workstream-resource-manifest.js";
import type { WorkstreamRepositoryValidation } from "./workstream-repository-validator.js";

export function projectProvisionalWorkstreamValidation(input: {
  database: ContextDatabase;
  workstream: WorkstreamInitializationRecord;
  repository: SharedWorkstreamRepositoryState;
}): WorkstreamRepositoryValidation {
  if (input.workstream.materialized || input.workstream.status !== "initializing") {
    throw new Error("Only an initializing workstream can use provisional context.");
  }
  const initial = buildInitialWorkstreamContext({
    workstreamId: input.workstream.workstreamId,
    title: input.workstream.title,
    purpose: input.workstream.objective,
    at: input.workstream.createdAt,
    ...(input.workstream.initialRequest
      ? { initialRequest: input.workstream.initialRequest }
      : {}),
  });
  const requests = readWorkstreamRequests(
    input.database,
    input.workstream.workstreamId,
  );
  const current = requests.find((request) => request.status === "active");
  if (!current || current.id !== initial.card.currentRequest) {
    throw new Error("Provisional workstream request projection is inconsistent.");
  }
  const progressContent = initial.files.get(WORKSTREAM_PROGRESS_PATH);
  const resourcesContent = initial.files.get(WORKSTREAM_RESOURCES_PATH);
  if (!progressContent || !resourcesContent) {
    throw new Error("Provisional workstream scaffold is incomplete.");
  }
  return {
    workstreamId: input.workstream.workstreamId,
    contextRepositoryPath: input.workstream.contextRepositoryPath,
    repositoryPath: input.repository.repositoryPath,
    branch: input.repository.branch,
    head: input.workstream.head,
    repositoryHead: input.repository.head,
    health: input.repository.health === "ready" ? "ready" : "dirty_external",
    workstreamCard: initial.card,
    currentRequest: current,
    requests,
    progress: {
      content: progressContent,
      entries: parseWorkstreamProgress(progressContent),
    },
    resourceManifest: parseWorkstreamResourceManifest(
      resourcesContent,
      input.workstream.workstreamId,
    ),
    workingTreeChanges: [],
  };
}
