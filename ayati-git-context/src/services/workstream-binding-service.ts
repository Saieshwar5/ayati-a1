import type {
  ActivateWorkstreamForRunRequest,
  CreateWorkstreamForRunRequest,
  SelectedWorkstreamForRunResponse,
  WorkstreamCatalogEntry,
  WorkstreamRequestRoute,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";
import { readRunEvidence } from "../repositories/run-records.js";
import { readWorkstreamRequestRoutePlan } from "../repositories/workstream-request-route-plan-records.js";
import { GitContextObserver } from "../observability.js";
import type { WorkstreamLifecycleService } from "./workstream-lifecycle-service.js";
import type { WorkstreamRequestRoutingService } from "./workstream-request-routing-service.js";

export class WorkstreamBindingService {
  constructor(
    private readonly database: ContextDatabase,
    private readonly workstreamLifecycle: WorkstreamLifecycleService,
    private readonly workstreamRequestRouting: WorkstreamRequestRoutingService,
    private readonly observer: GitContextObserver = new GitContextObserver("git-context-engine"),
  ) {}

  async create(input: CreateWorkstreamForRunRequest): Promise<SelectedWorkstreamForRunResponse> {
    this.assertBindableRun(input);
    this.emitRequested(input, "create", "initial");
    const creation = await this.workstreamLifecycle.createSimpleWorkstream({
      requestId: input.requestId + ":workstream",
      sessionId: input.sessionId,
      runId: input.runId,
      title: input.title,
      objective: input.objective,
      at: input.at,
    });
    this.emitValidated(input, creation.workstream, creation.created);
    return await this.select(
      input,
      creation.workstream,
      creation.created,
      {
        kind: "continue_active_request",
        requestId: "R-0001",
        reason: "Continue the initial request created with the workstream.",
      },
      "initial",
    );
  }

  async activate(input: ActivateWorkstreamForRunRequest): Promise<SelectedWorkstreamForRunResponse> {
    this.assertBindableRun(input);
    if (!/^W-\d{8}-\d{4}$/.test(input.workstreamId)) {
      throw invalid("Workstream activation requires a W-YYYYMMDD-NNNN identity.", input);
    }
    this.emitRequested(
      input,
      "activate",
      input.route.kind === "continue_active_request" ? "continue" : "create",
    );
    const response = await this.workstreamLifecycle.getWorkstream({ workstreamId: input.workstreamId });
    if (input.expectedWorkstreamHead && response.workstream.head !== input.expectedWorkstreamHead) {
      throw new GitContextServiceError({
        code: "WORKSTREAM_HEAD_MISMATCH",
        message: "Workstream changed after it was selected.",
        details: {
          workstreamId: input.workstreamId,
          expectedHead: input.expectedWorkstreamHead,
          actualHead: response.workstream.head,
        },
      });
    }
    this.emitValidated(input, response.workstream, false);
    return await this.select(
      input,
      response.workstream,
      false,
      input.route,
      input.route.kind === "continue_active_request" ? "continue" : "create",
    );
  }

  private async select(
    input: CreateWorkstreamForRunRequest | ActivateWorkstreamForRunRequest,
    workstream: WorkstreamCatalogEntry,
    workstreamCreated: boolean,
    route: WorkstreamRequestRoute,
    workstreamRequestDecision: "initial" | "continue" | "create",
  ): Promise<SelectedWorkstreamForRunResponse> {
    const headBeforeSelection = workstream.head;
    const planned = await this.workstreamRequestRouting.plan({
      requestId: input.requestId + ":route",
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      runId: input.runId,
      workstreamId: workstream.workstreamId,
      expectedWorkstreamHead: workstream.head,
      route,
      at: input.at,
    });
    const context = await this.workstreamRequestRouting.projectContext(
      input.runId,
      await this.workstreamLifecycle.readContext(workstream),
    );
    const status = context.currentRequest?.status;
    if (!status) {
      throw new Error("Selected workstream context is missing its active request status.");
    }
    return {
      workstream,
      run: planned.run,
      context,
      workstreamCreated,
      workstreamRequestDecision,
      workstreamRequestStatus: status,
      workstreamRequestCreated: workstreamRequestDecision === "initial" ? true : planned.requestCreated,
      headBeforeSelection,
      resourceBindings: context.resources ?? [],
    };
  }

  private assertBindableRun(
    input: Pick<
      CreateWorkstreamForRunRequest,
      "requestId" | "sessionId" | "conversationId" | "runId"
    >,
  ): void {
    const existing = readRunEvidence(this.database, input.runId);
    if (!existing
      || existing.status !== "running"
      || existing.sessionId !== input.sessionId
      || existing.conversationId !== input.conversationId) {
      throw new GitContextServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "Workstream selection requires the matching active run and conversation.",
        details: input,
      });
    }
    if (existing.workstreamBinding) {
      const plan = readWorkstreamRequestRoutePlan(this.database, input.runId);
      if (plan?.operationRequestId === input.requestId + ":route") return;
      throw new GitContextServiceError({
        code: "RUN_WORKSTREAM_BINDING_IMMUTABLE",
        message: "The active run already has an immutable workstream/request binding.",
        details: { runId: input.runId, workstreamBinding: existing.workstreamBinding },
      });
    }
  }

  private emitRequested(
    input: CreateWorkstreamForRunRequest | ActivateWorkstreamForRunRequest,
    mode: "create" | "activate",
    decision: "initial" | "continue" | "create",
  ): void {
    this.observer.emit({
      level: "info",
      event: "workstream_activation_requested",
      requestId: input.requestId,
      sessionId: input.sessionId,
      runId: input.runId,
      ...("workstreamId" in input ? { workstreamId: input.workstreamId } : {}),
      outcome: "started",
      data: { mode, workstreamRequestDecision: decision },
    });
  }

  private emitValidated(
    input: CreateWorkstreamForRunRequest | ActivateWorkstreamForRunRequest,
    workstream: WorkstreamCatalogEntry,
    newlyCreated: boolean,
  ): void {
    this.observer.emit({
      level: "info",
      event: "workstream_repository_validated",
      requestId: input.requestId,
      sessionId: input.sessionId,
      runId: input.runId,
      workstreamId: workstream.workstreamId,
      outcome: "succeeded",
      data: {
        contextRepositoryPath: workstream.contextRepositoryPath,
        branch: workstream.branch,
        workstreamHead: workstream.head,
        newlyCreated,
      },
    });
  }
}

function invalid(
  message: string,
  input: { sessionId: string; runId: string; workstreamId?: string },
): GitContextServiceError {
  return new GitContextServiceError({
    code: "INVALID_REQUEST",
    message,
    details: {
      sessionId: input.sessionId,
      runId: input.runId,
      ...(input.workstreamId ? { workstreamId: input.workstreamId } : {}),
    },
  });
}
