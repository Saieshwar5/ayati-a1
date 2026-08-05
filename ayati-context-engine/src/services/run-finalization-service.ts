import type {
  FinalizeRunRequest,
  FinalizeRunResponse,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { ContextEngineServiceError } from "../errors.js";
import { readRunEvidence } from "../repositories/run-records.js";
import { readRunWorkState } from "../repositories/run-work-state-records.js";
import { readUnboundRunFinalization } from "../repositories/unbound-run-finalization-records.js";
import type { WorkstreamBoundFinalizationService } from "./workstream-bound-finalization-service.js";
import {
  type UnboundRunFinalizationService,
  withoutWorkstreamCompletion,
} from "./unbound-run-finalization-service.js";
import { withUnsuccessfulBoundRunFinalization } from "./unsuccessful-bound-run-finalization.js";

export class RunFinalizationService {
  constructor(private readonly options: {
    database: ContextDatabase;
    unbound: UnboundRunFinalizationService;
    workstreamBound: WorkstreamBoundFinalizationService;
  }) {}

  async finalize(
    input: FinalizeRunRequest,
  ): Promise<FinalizeRunResponse> {
    const run = readRunEvidence(this.options.database, input.runId);
    if (!run) {
      throw new ContextEngineServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "Finalization requires the matching run.",
        details: { runId: input.runId },
      });
    }
    if (run.workstreamBinding) {
      if (input.workstream) {
        return await this.options.workstreamBound.finalize(input);
      }
      if (input.outcome === "done") {
        throw new ContextEngineServiceError({
          code: "INVALID_REQUEST",
          message: "Workstream-bound finalization requires workstream completion evidence.",
          details: { runId: input.runId, workstreamBinding: run.workstreamBinding },
        });
      }
      const persistedWorkState = readRunWorkState(this.options.database, input.runId);
      if (!persistedWorkState) {
        throw new ContextEngineServiceError({
          code: "RECOVERY_REQUIRED",
          message: "Unsuccessful bound finalization requires the persisted run WorkState.",
          details: { runId: input.runId, workstreamBinding: run.workstreamBinding },
        });
      }
      return await this.options.workstreamBound.finalize(
        withUnsuccessfulBoundRunFinalization(input, persistedWorkState),
      );
    }
    if (input.workstream) {
      if (readUnboundRunFinalization(this.options.database, input.runId)) {
        return await this.options.unbound.finalize(withoutWorkstreamCompletion(input));
      }
      throw new ContextEngineServiceError({
        code: "INVALID_REQUEST",
        message: "Unbound run finalization cannot submit workstream completion evidence.",
        details: { runId: input.runId },
      });
    }
    return await this.options.unbound.finalize(input);
  }

  async recover(at: string): Promise<void> {
    await this.options.unbound.recover(at);
    await this.options.workstreamBound.recover(at);
  }
}
