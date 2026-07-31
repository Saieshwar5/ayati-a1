import type {
  PlanWorkstreamRequestRouteRequest,
  PlanWorkstreamRequestRouteResponse,
  WorkstreamContextProjection,
  WorkstreamRequestRoute,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
} from "../database/idempotency.js";
import { ContextEngineServiceError } from "../errors.js";
import {
  insertWorkstreamRequestRoutePlan,
  readWorkstreamRequestRoutePlan,
  workstreamRequestRoutePlanResponse,
} from "../repositories/workstream-request-route-plan-records.js";
import {
  bindActiveRunToWorkstream,
  readRunEvidence,
} from "../repositories/run-records.js";
import { readWorkstreamInitialization } from "../repositories/workstream-records.js";
import { readSharedWorkstreamRepositoryState } from "../repositories/workstream-repository-state-records.js";
import {
  synchronizeCurrentWorkstreamRequest,
  writeWorkstreamRequestProjection,
} from "../repositories/workstream-request-records.js";
import {
  planWorkstreamRequestChange,
  type WorkstreamRequestChangePlan,
  type WorkstreamRequestLifecycleOperation,
} from "../workstreams/workstream-request-lifecycle.js";
import { resolvePlannedWorkstreamRequestState } from "../workstreams/planned-workstream-request.js";
import { projectProvisionalWorkstreamValidation } from "../workstreams/provisional-workstream-context.js";
import { resolveWorkstreamRequestRoutingDecision } from "../workstreams/workstream-request-routing.js";
import {
  validateWorkstreamRepository,
  type WorkstreamRepositoryValidation,
} from "../workstreams/workstream-repository-validator.js";

export class WorkstreamRequestRoutingService {
  constructor(private readonly options: {
    database: ContextDatabase;
    workstreamRoot: string;
  }) {}

  async plan(input: PlanWorkstreamRequestRouteRequest): Promise<PlanWorkstreamRequestRouteResponse> {
    const workstream = readWorkstreamInitialization(this.options.database, input.workstreamId);
    if (!workstream?.head
      || (workstream.status !== "active" && workstream.status !== "initializing")) {
      throw invalid("Request planning requires an active or provisional workstream.", input);
    }
    if (workstream.head !== input.expectedWorkstreamHead) {
      throw headMismatch(input, workstream.head);
    }
    const run = readRunEvidence(this.options.database, input.runId);
    if (!run || run.status !== "running"
      || (run.workstreamBinding
        && run.workstreamBinding.workstreamId !== input.workstreamId)) {
      throw invalid("Request planning requires the matching active run.", input);
    }
    const existing = readWorkstreamRequestRoutePlan(this.options.database, input.runId);
    if (existing && existing.operationRequestId !== input.requestId) {
      throw invalid("Run already owns a different request route plan.", input);
    }
    if (run.workstreamBinding && !existing) {
      throw invalid("Run is already bound without its recoverable route plan.", input);
    }
    const validation = await this.validation(workstream);
    if (validation.head !== input.expectedWorkstreamHead
      || validation.branch !== workstream.branch) {
      throw headMismatch(input, validation.head);
    }
    if (validation.health !== "ready") {
      throw new ContextEngineServiceError({
        code: "RECOVERY_REQUIRED",
        message: "Request planning requires a clean shared workstream repository.",
        details: {
          workstreamId: input.workstreamId,
          workingTreeChanges: validation.workingTreeChanges,
        },
      });
    }
    const state = {
      expectedHead: validation.head,
      workstreamCard: validation.workstreamCard,
      requests: validation.requests,
    };
    const resolution = resolveWorkstreamRequestRoutingDecision({
      workstreams: [state],
      evidence: { explicitWorkstreamId: input.workstreamId },
    }, routingDecision(input.workstreamId, input.route));
    if (resolution.status !== "ready" || resolution.next !== input.route.kind) {
      // This rejection intentionally precedes lifecycle planning and the
      // recoverable idempotency transaction, so no request or run state changed.
      throw new ContextEngineServiceError({
        code: "WORKSTREAM_CURRENT_REQUEST_INVALID",
        message: "Request route is not valid for the current lifecycle state.",
        retryable: true,
        details: {
          workstreamId: input.workstreamId,
          resolution,
          attemptDisposition: "retryable_no_change",
        },
      });
    }
    const changePlan = input.route.kind === "continue_current"
      ? undefined
      : planWorkstreamRequestChange(state, lifecycleOperation(input.route, input.at));
    const boundRequestId = selectedRequestId(input.route, changePlan);
    const pending = beginRecoverableIdempotent<PlanWorkstreamRequestRouteResponse>({
      database: this.options.database,
      requestId: input.requestId,
      operation: "plan_workstream_request_route",
      payload: input,
      now: input.at,
      execute: () => {
        if (changePlan) {
          for (const request of changePlan.changedRequests) {
            writeWorkstreamRequestProjection(this.options.database, {
              request,
              createdByRunId: changePlan.requestsBefore.some(
                (entry) => entry.id === request.id,
              ) ? undefined : input.runId,
              lastRunId: input.runId,
              lastActivityAt: input.at,
            });
          }
          synchronizeCurrentWorkstreamRequest(this.options.database, input.workstreamId);
        }
        const record = insertWorkstreamRequestRoutePlan(this.options.database, {
          runId: input.runId,
          operationRequestId: input.requestId,
          streamId: run.streamId,
          workstreamId: input.workstreamId,
          boundRequestId,
          baseHead: input.expectedWorkstreamHead,
          route: input.route,
          ...(changePlan ? { changePlan } : {}),
          at: input.at,
        });
        const boundRun = bindActiveRunToWorkstream(this.options.database, {
          runId: input.runId,
          workstreamId: input.workstreamId,
          requestId: boundRequestId,
          at: input.at,
        });
        return workstreamRequestRoutePlanResponse(record, boundRun);
      },
    });
    if (pending.completed) return pending.result;
    return completeRecoverableIdempotent({
      database: this.options.database,
      requestId: input.requestId,
      result: pending.result,
      now: input.at,
    });
  }

  async projectContext(
    runId: string,
    context: WorkstreamContextProjection,
  ): Promise<WorkstreamContextProjection> {
    const { unfinishedRequests: _routingRequests, ...boundedContext } = context;
    const record = readWorkstreamRequestRoutePlan(this.options.database, runId);
    if (!record || record.phase !== "planned") return boundedContext;
    const workstream = readWorkstreamInitialization(
      this.options.database,
      context.workstream.workstreamId,
    );
    if (!workstream) {
      throw new ContextEngineServiceError({
        code: "WORKSTREAM_NOT_FOUND",
        message: "Selected workstream is unavailable.",
        details: { runId, workstreamId: context.workstream.workstreamId },
      });
    }
    const planned = resolvePlannedWorkstreamRequestState(
      record,
      await this.validation(workstream),
    );
    const active = planned.workstreamCard.currentRequest
      ? record.changePlan?.requestsAfter.find(
          (request) => request.id === planned.workstreamCard.currentRequest,
        ) ?? (boundedContext.currentRequest?.id === planned.workstreamCard.currentRequest
          ? boundedContext.currentRequest
          : undefined)
      : undefined;
    return {
      ...boundedContext,
      lifecycleStatus: planned.workstreamCard.status,
      currentFocus: planned.workstreamCard.currentFocus,
      blockers: [...planned.workstreamCard.blockers],
      ...(active ? { currentRequest: requestProjection(active) } : { currentRequest: undefined }),
      selectedRequest: requestProjection(planned.workstreamRequest),
    };
  }

  private async validation(
    workstream: NonNullable<ReturnType<typeof readWorkstreamInitialization>>,
  ): Promise<WorkstreamRepositoryValidation> {
    if (workstream.materialized) {
      return await validateWorkstreamRepository({
        workstreamRoot: this.options.workstreamRoot,
        contextRepositoryPath: workstream.contextRepositoryPath,
        expectedWorkstreamId: workstream.workstreamId,
        requestReadMode: "all",
      });
    }
    const repository = readSharedWorkstreamRepositoryState(this.options.database);
    if (!repository) throw new Error("Shared workstream repository is unavailable.");
    return projectProvisionalWorkstreamValidation({
      database: this.options.database,
      workstream,
      repository,
    });
  }
}

function routingDecision(
  workstreamId: string,
  route: WorkstreamRequestRoute,
) {
  const common = { workstreamId, reason: route.reason };
  switch (route.kind) {
    case "continue_current":
    case "activate_existing":
    case "resume_blocked":
      return { kind: route.kind, requestId: route.requestId, ...common } as const;
    case "amend_current":
      return { kind: route.kind, requestId: route.currentRequestId, ...common } as const;
    case "create_and_activate":
    case "create_queued":
      return { kind: route.kind, ...common } as const;
    case "defer_current_and_create":
      return { kind: route.kind, requestId: route.currentRequestId, ...common } as const;
    case "defer_current_and_activate_existing":
      return {
        kind: route.kind,
        requestId: route.currentRequestId,
        nextRequestId: route.nextRequestId,
        ...common,
      } as const;
  }
}

function lifecycleOperation(
  route: Exclude<WorkstreamRequestRoute, { kind: "continue_current" }>,
  at: string,
): WorkstreamRequestLifecycleOperation {
  switch (route.kind) {
    case "activate_existing":
      return { kind: "activate", requestId: route.requestId, at };
    case "resume_blocked":
      return { kind: "resume", requestId: route.requestId, at };
    case "amend_current":
      return {
        kind: "amend",
        requestId: route.currentRequestId,
        patch: route.patch,
        reason: route.reason,
        authority: route.authority,
        at,
      };
    case "create_and_activate":
    case "create_queued":
      return {
        kind: "create",
        title: route.title,
        request: route.request,
        acceptance: route.acceptance,
        constraints: route.constraints,
        source: "user",
        createdAt: at,
        activate: route.kind === "create_and_activate",
      };
    case "defer_current_and_create":
      return {
        kind: "defer_and_create",
        currentRequestId: route.currentRequestId,
        deferReason: route.reason,
        newRequest: {
          title: route.title,
          request: route.request,
          acceptance: route.acceptance,
          constraints: route.constraints,
          source: "user",
          createdAt: at,
        },
      };
    case "defer_current_and_activate_existing":
      return {
        kind: "defer_and_activate",
        currentRequestId: route.currentRequestId,
        nextRequestId: route.nextRequestId,
        deferReason: route.reason,
        at,
      };
  }
}

function selectedRequestId(
  route: WorkstreamRequestRoute,
  plan: WorkstreamRequestChangePlan | undefined,
): string {
  if (route.kind === "continue_current"
    || route.kind === "activate_existing"
    || route.kind === "resume_blocked") {
    return route.requestId;
  }
  if (route.kind === "amend_current") return route.currentRequestId;
  const id = plan?.activatedRequestId ?? plan?.primaryRequestId;
  if (!id) throw new Error("Request lifecycle plan did not select a request.");
  return id;
}

function requestProjection(request: {
  id: string;
  title: string;
  status: "queued" | "active" | "blocked" | "done" | "dropped";
  request: string;
  acceptance: string[];
  constraints: string[];
}) {
  return {
    id: request.id,
    title: request.title,
    status: request.status,
    request: request.request,
    acceptance: [...request.acceptance],
    constraints: [...request.constraints],
  };
}

function invalid(
  message: string,
  input: Pick<PlanWorkstreamRequestRouteRequest, "runId" | "workstreamId">,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "INVALID_REQUEST",
    message,
    details: { runId: input.runId, workstreamId: input.workstreamId },
  });
}

function headMismatch(
  input: Pick<
    PlanWorkstreamRequestRouteRequest,
    "workstreamId" | "expectedWorkstreamHead"
  >,
  actualHead: string,
): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "WORKSTREAM_HEAD_MISMATCH",
    message: "Workstream revision changed before request planning.",
    retryable: true,
    details: {
      workstreamId: input.workstreamId,
      expectedHead: input.expectedWorkstreamHead,
      actualHead,
    },
  });
}
