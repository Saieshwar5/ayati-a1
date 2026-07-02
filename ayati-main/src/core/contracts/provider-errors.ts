export interface ProviderEmptyResponseDetails {
  provider: string;
  model?: string;
  choiceCount?: number;
  responseKeys?: string[];
  finishReason?: string;
  hasMessage?: boolean;
}

export class ProviderEmptyResponseError extends Error {
  readonly details: ProviderEmptyResponseDetails;

  constructor(message: string, details: ProviderEmptyResponseDetails) {
    super(message);
    this.name = "ProviderEmptyResponseError";
    this.details = details;
  }
}

export function isProviderEmptyResponseError(error: unknown): error is ProviderEmptyResponseError {
  return error instanceof ProviderEmptyResponseError;
}
