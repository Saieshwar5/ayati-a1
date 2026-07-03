export interface ProviderEmptyResponseDetails {
  provider: string;
  model?: string;
  choiceCount?: number;
  responseKeys?: string[];
  finishReason?: string;
  hasMessage?: boolean;
}

export interface ProviderMalformedResponseDetails {
  provider: string;
  model?: string;
  errorName?: string;
  errorMessage?: string;
}

export class ProviderEmptyResponseError extends Error {
  readonly details: ProviderEmptyResponseDetails;

  constructor(message: string, details: ProviderEmptyResponseDetails) {
    super(message);
    this.name = "ProviderEmptyResponseError";
    this.details = details;
  }
}

export class ProviderMalformedResponseError extends Error {
  readonly details: ProviderMalformedResponseDetails;
  readonly cause?: unknown;

  constructor(message: string, details: ProviderMalformedResponseDetails, cause?: unknown) {
    super(message);
    this.name = "ProviderMalformedResponseError";
    this.details = details;
    this.cause = cause;
  }
}

export function isProviderEmptyResponseError(error: unknown): error is ProviderEmptyResponseError {
  return error instanceof ProviderEmptyResponseError;
}

export function isProviderMalformedResponseError(error: unknown): error is ProviderMalformedResponseError {
  return error instanceof ProviderMalformedResponseError;
}
