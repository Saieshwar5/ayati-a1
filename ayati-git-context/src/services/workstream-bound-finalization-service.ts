import type {
  FinalizeRunRequest,
  FinalizeRunResponse,
  SessionRef,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { GitContextServiceError } from "../errors.js";
import { readRunEvidence } from "../repositories/run-records.js";
import { readWorkstreamInitialization } from "../repositories/workstream-records.js";
import {
  WorkstreamFinalizationService,
  type WorkstreamFinalizationHook,
} from "./workstream-finalization-service.js";
import type { ResourceCatalogService } from "./resource-catalog-service.js";

export class WorkstreamBoundFinalizationService {
  private readonly workstreamFinalization: WorkstreamFinalizationService;

  constructor(
    private readonly database: ContextDatabase,
    workstreamRoot: string,
    resourceCatalog: ResourceCatalogService,
    hook?: WorkstreamFinalizationHook,
  ) {
    this.workstreamFinalization = new WorkstreamFinalizationService({
      database,
      workstreamRoot,
      resourceCatalog,
      ...(hook ? { hook } : {}),
    });
  }

  async finalize(
    input: FinalizeRunRequest,
    session: SessionRef,
  ): Promise<FinalizeRunResponse> {
    const run = readRunEvidence(this.database, input.runId);
    const workstreamId = run?.workstreamBinding?.workstreamId;
    if (!workstreamId || !/^W-\d{8}-\d{4}$/.test(workstreamId)) {
      throw invalidWorkstreamId(workstreamId);
    }
    const workstream = readWorkstreamInitialization(this.database, workstreamId);
    if (!workstream?.head) {
      throw new GitContextServiceError({
        code: "INVALID_REQUEST",
        message: "Workstream-bound finalization requires an active workstream context repository.",
        details: { workstreamId },
      });
    }
    return await this.workstreamFinalization.finalize(input, session);
  }

  async recover(at: string): Promise<void> {
    await this.workstreamFinalization.recover(at);
  }
}

function invalidWorkstreamId(workstreamId: string | undefined): GitContextServiceError {
  return new GitContextServiceError({
    code: "INVALID_REQUEST",
    message: "Workstream-bound finalization requires a W-YYYYMMDD-NNNN identity.",
    details: { workstreamId: workstreamId ?? null },
  });
}
