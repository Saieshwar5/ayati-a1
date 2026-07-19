import type {
  FinalizeRunRequest,
  FinalizeRunResponse,
  SessionRef,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";
import { readRunEvidence } from "../repositories/run-records.js";
import type { WorkstreamBoundFinalizationService } from "./workstream-bound-finalization-service.js";
import type { UnboundRunFinalizationService } from "./unbound-run-finalization-service.js";

export class RunFinalizationService {
  constructor(private readonly options: {
    database: ContextDatabase;
    unbound: UnboundRunFinalizationService;
    workstreamBound: WorkstreamBoundFinalizationService;
  }) {}

  async finalize(
    input: FinalizeRunRequest,
    session: SessionRef,
  ): Promise<FinalizeRunResponse> {
    const run = readRunEvidence(this.options.database, input.runId);
    if (!run || run.sessionId !== input.sessionId) {
      throw new GitContextServiceError({
        code: "RUN_NOT_ACTIVE",
        message: "Finalization requires the matching run and session.",
        details: { sessionId: input.sessionId, runId: input.runId },
      });
    }
    if (run.workstreamBinding) {
      if (!input.workstream?.completion) {
        throw new GitContextServiceError({
          code: "INVALID_REQUEST",
          message: "Workstream-bound finalization requires workstream completion evidence.",
          details: { runId: input.runId, workstreamBinding: run.workstreamBinding },
        });
      }
      return await this.options.workstreamBound.finalize(input, session);
    }
    if (input.workstream) {
      throw new GitContextServiceError({
        code: "INVALID_REQUEST",
        message: "Unbound run finalization cannot submit workstream completion evidence.",
        details: { runId: input.runId },
      });
    }
    return await this.options.unbound.finalize(input, session);
  }

  async recover(at: string): Promise<void> {
    await this.options.unbound.recover(at);
    await this.options.workstreamBound.recover(at);
  }
}
