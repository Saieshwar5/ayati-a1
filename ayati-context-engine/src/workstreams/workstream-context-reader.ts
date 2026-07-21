import type { WorkstreamCatalogEntry, WorkstreamContextProjection } from "../contracts.js";
import { ContextEngineServiceError } from "../errors.js";
import { readSimpleWorkstreamContext } from "./simple-workstream-context-reader.js";

export interface WorkstreamContextReadOptions {
  workstreamRoot?: string;
}

export async function readWorkstreamContext(
  workstream: WorkstreamCatalogEntry,
  options: WorkstreamContextReadOptions = {},
): Promise<WorkstreamContextProjection> {
  if (!options.workstreamRoot) {
    throw new ContextEngineServiceError({
      code: "WORKSTREAM_NOT_FOUND",
      message: "The workstream context repository root is unavailable.",
      details: { workstreamId: workstream.workstreamId },
    });
  }
  return await readSimpleWorkstreamContext(workstream, {
    workstreamRoot: options.workstreamRoot,
  });
}
