import type {
  PlanWorkstreamRequestRouteRequest,
  PlanWorkstreamRequestRouteResponse,
  WorkstreamContextProjection,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import {
  beginRecoverableIdempotent,
  completeRecoverableIdempotent,
} from "../database/idempotency.js";
import { GitContextServiceError } from "../errors.js";
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
import { planWorkstreamRequestChange } from "../workstreams/workstream-request-lifecycle.js";
import { resolvePlannedWorkstreamRequestState } from "../workstreams/planned-workstream-request.js";
import { resolveWorkstreamRequestRoutingDecision } from "../workstreams/workstream-request-routing.js";
import { validateWorkstreamRepository } from "../workstreams/workstream-repository-validator.js";

export class WorkstreamRequestRoutingService {
  constructor(private readonly options: {
    database: ContextDatabase;
    workstreamRoot: string;
  }) {}

  async plan(input: PlanWorkstreamRequestRouteRequest): Promise<PlanWorkstreamRequestRouteResponse> {
    const workstream = readWorkstreamInitialization(this.options.database, input.workstreamId);
    if (!workstream?.head || workstream.status !== "active") {
      throw invalid("Request planning requires an active workstream context repository.", input);
    }
    if (workstream.head !== input.expectedWorkstreamHead) {
      throw new GitContextServiceError({
        code: "WORKSTREAM_HEAD_MISMATCH",
        message: "Workstream HEAD does not match the request plan expectation.",
        retryable: true,
        details: {
          workstreamId: input.workstreamId,
          expectedHead: input.expectedWorkstreamHead,
          actualHead: workstream.head,
        },
      });
    }
    const run = readRunEvidence(this.options.database, input.runId);
    if (!run || run.status !== "running" || run.sessionId !== input.sessionId
      || run.conversationId !== input.conversationId
      || (run.workstreamBinding && run.workstreamBinding.workstreamId !== input.workstreamId)) {
      throw invalid("Request planning requires the matching active run.", input);
    }
    const existingPlan = readWorkstreamRequestRoutePlan(this.options.database, input.runId);
    if (existingPlan && existingPlan.operationRequestId !== input.requestId) {
      throw invalid("Active run already owns a different workstream request plan.", input);
    }
    if (run.workstreamBinding && !existingPlan) {
      throw invalid("Active run is already bound without a recoverable request plan.", input);
    }
    const validation = await validateWorkstreamRepository({
      workstreamRoot: this.options.workstreamRoot,
      contextRepositoryPath: workstream.contextRepositoryPath,
      expectedWorkstreamId: input.workstreamId,
      requestReadMode: "all",
    });
    if (validation.head !== input.expectedWorkstreamHead || validation.branch !== workstream.branch) {
      throw new GitContextServiceError({
        code: "WORKSTREAM_HEAD_MISMATCH",
        message: "Workstream repository identity changed before request planning.",
        retryable: true,
        details: {
          workstreamId: input.workstreamId,
          expectedHead: input.expectedWorkstreamHead,
          actualHead: validation.head,
        },
      });
    }
    if (validation.health !== "ready") {
      throw new GitContextServiceError({
        code: "RECOVERY_REQUIRED",
        message: "Request planning requires a clean workstream context repository.",
        details: { workstreamId: input.workstreamId, workingTreeChanges: validation.workingTreeChanges },
      });
    }
    const state = {
      expectedHead: validation.head,
      workstreamCard: validation.workstreamCard,
      requests: validation.requests,
    };
    const decision = input.route.kind === "continue_active_request"
      ? {
          kind: input.route.kind,
          workstreamId: input.workstreamId,
          requestId: input.route.requestId,
          reason: input.route.reason,
        } as const
      : {
          kind: input.route.kind,
          workstreamId: input.workstreamId,
          reason: input.route.reason,
        } as const;
    const resolution = resolveWorkstreamRequestRoutingDecision({
      workstreams: [state],
      evidence: { explicitWorkstreamId: input.workstreamId },
    }, decision);
    if (resolution.status !== "ready"
      || (resolution.next !== "continue_request" && resolution.next !== "create_active_request")) {
      throw new GitContextServiceError({
        code: "WORKSTREAM_CURRENT_REQUEST_INVALID",
        message: "Request route is not ready for mutation.",
        retryable: true,
        details: { workstreamId: input.workstreamId, resolution },
      });
    }
    const changePlan = input.route.kind === "create_active_request"
      ? planWorkstreamRequestChange(state, {
          kind: "create",
          title: input.route.title,
          request: input.route.request,
          acceptance: input.route.acceptance,
          constraints: input.route.constraints,
          source: "user",
          createdAt: input.at,
          activate: true,
        })
      : undefined;
    const workstreamRequestId = changePlan?.primaryRequestId
      ?? (input.route.kind === "continue_active_request" ? input.route.requestId : undefined);
    if (!workstreamRequestId) throw new Error("Resolved request route is missing its request identity.");
    const pending = beginRecoverableIdempotent<PlanWorkstreamRequestRouteResponse>({
      database: this.options.database,
      requestId: input.requestId,
      operation: "plan_workstream_request_route",
      payload: input,
      now: input.at,
      execute: () => {
        const record = insertWorkstreamRequestRoutePlan(this.options.database, {
          runId: input.runId,
          operationRequestId: input.requestId,
          sessionId: input.sessionId,
          conversationId: input.conversationId,
          workstreamId: input.workstreamId,
          boundRequestId: workstreamRequestId,
          baseHead: input.expectedWorkstreamHead,
          route: input.route,
          ...(changePlan ? { changePlan } : {}),
          at: input.at,
        });
        const boundRun = bindActiveRunToWorkstream(this.options.database, {
          sessionId: input.sessionId,
          conversationId: input.conversationId,
          runId: input.runId,
          workstreamId: input.workstreamId,
          requestId: workstreamRequestId,
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

  async projectContext(runId: string, context: WorkstreamContextProjection): Promise<WorkstreamContextProjection> {
    const record = readWorkstreamRequestRoutePlan(this.options.database, runId);
    if (!record || record.phase !== "planned") {
      return context;
    }
    const workstream = readWorkstreamInitialization(this.options.database, context.workstream.workstreamId);
    if (!workstream?.head) {
      throw new GitContextServiceError({
        code: "WORKSTREAM_NOT_FOUND",
        message: "Workstream context projection requires an active workstream.",
        details: { runId, workstreamId: context.workstream.workstreamId },
      });
    }
    const validation = await validateWorkstreamRepository({
      workstreamRoot: this.options.workstreamRoot,
      contextRepositoryPath: context.workstream.contextRepositoryPath,
      expectedWorkstreamId: context.workstream.workstreamId,
      requestReadMode: "all",
    });
    const planned = resolvePlannedWorkstreamRequestState(record, validation);
    return {
      ...context,
      lifecycleStatus: planned.workstreamCard.status,
      currentFocus: planned.workstreamCard.currentFocus,
      blockers: [...planned.workstreamCard.blockers],
      currentRequest: structuredClone(planned.workstreamRequest),
    };
  }
}

function invalid(
  message: string,
  input: Pick<PlanWorkstreamRequestRouteRequest, "sessionId" | "runId" | "workstreamId">,
): GitContextServiceError {
  return new GitContextServiceError({
    code: "INVALID_REQUEST",
    message,
    details: { sessionId: input.sessionId, runId: input.runId, workstreamId: input.workstreamId },
  });
}
