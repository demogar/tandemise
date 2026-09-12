import type { ErrorCode } from '@tandemise/shared';

/** Uniform error envelope. Every non-2xx response has exactly this shape. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details: Record<string, unknown>;
    readonly retryable: boolean;
  };
}

export const HTTP_STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 400,
  PERMISSION_DENIED: 403,
  APPROVAL_REQUIRED: 428,
  PRECONDITION_FAILED: 412,
  RUNTIME_UNAVAILABLE: 503,
  RUNTIME_FAILED: 502,
  TARGET_UNAVAILABLE: 503,
  INTEGRATION_FAILED: 502,
  CANCELLED: 499,
  TIMEOUT: 504,
  INTERNAL: 500,
};
