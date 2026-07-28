import {
  renderWorkstreamCard,
  type WorkstreamCard,
} from "./workstream-card.js";
import { renderWorkstreamProgress } from "./workstream-progress.js";
import {
  requestPath,
  WORKSTREAM_CARD_PATH,
  WORKSTREAM_PROGRESS_PATH,
  WORKSTREAM_RESOURCES_PATH,
} from "./workstream-repository-layout.js";
import {
  renderWorkstreamRequest,
  type WorkstreamRequest,
} from "./workstream-request.js";
import {
  renderWorkstreamResourceManifest,
  WORKSTREAM_RESOURCE_MANIFEST_SCHEMA,
} from "./workstream-resource-manifest.js";

export interface InitialRequestContract {
  title: string;
  request: string;
  acceptance: string[];
  constraints: string[];
}

export interface InitialWorkstreamContext {
  card: WorkstreamCard;
  request: WorkstreamRequest;
  files: Map<string, string>;
}

export function buildInitialWorkstreamContext(input: {
  workstreamId: string;
  title: string;
  purpose: string;
  at: string;
  initialRequest?: InitialRequestContract;
}): InitialWorkstreamContext {
  const contract = input.initialRequest ?? {
    title: input.title,
    request: input.purpose,
    acceptance: [
      "The initial workstream objective is completed and deterministically verified.",
    ],
    constraints: [],
  };
  const request: WorkstreamRequest = {
    schema: "ayati.request/v3",
    id: "R-0001",
    workstreamId: input.workstreamId,
    relativePath: requestPath("R-0001", contract.title),
    title: contract.title,
    status: "active",
    source: "user",
    createdAt: input.at,
    updatedAt: input.at,
    startedAt: input.at,
    closedAt: null,
    request: contract.request,
    acceptance: [...contract.acceptance],
    constraints: [...contract.constraints],
    lifecycleNote: "Created as the active request.",
    finalOutcome: "Pending.",
  };
  const card: WorkstreamCard = {
    schema: "ayati.workstream/v3",
    id: input.workstreamId,
    title: input.title,
    status: "active",
    currentRequest: request.id,
    aliases: [],
    purpose: input.purpose,
    currentSnapshot: "The workstream is initialized; no request work is complete yet.",
    importantFindings: [],
    decisions: [
      "Keep deliverables, secrets, and attachment bytes outside the workstream notebook.",
    ],
    currentFocus: "Complete the initial request and record verified outcomes.",
    openQuestions: [],
    blockers: [],
    nextAction: "Advance R-0001 toward its acceptance criteria.",
  };
  return {
    card,
    request,
    files: new Map([
      [WORKSTREAM_CARD_PATH, renderWorkstreamCard(card)],
      [WORKSTREAM_PROGRESS_PATH, renderWorkstreamProgress([])],
      [request.relativePath, renderWorkstreamRequest(request)],
      [WORKSTREAM_RESOURCES_PATH, renderWorkstreamResourceManifest({
        schema: WORKSTREAM_RESOURCE_MANIFEST_SCHEMA,
        workstreamId: input.workstreamId,
        updatedAt: input.at,
        resources: [],
      })],
    ]),
  };
}
