/** Stable, machine-readable failure codes surfaced across the daemon API. */
export type ErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'PERMISSION_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'PRECONDITION_FAILED'
  | 'RUNTIME_UNAVAILABLE'
  | 'RUNTIME_FAILED'
  | 'TARGET_UNAVAILABLE'
  | 'INTEGRATION_FAILED'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'INTERNAL';

export class TandemiseError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TandemiseError';
    this.code = code;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
  }

  static notFound(what: string, id?: string): TandemiseError {
    return new TandemiseError('NOT_FOUND', id ? `${what} '${id}' not found` : `${what} not found`, {
      details: id ? { id } : {},
    });
  }

  static validation(message: string, details?: Record<string, unknown>): TandemiseError {
    return new TandemiseError('VALIDATION', message, { details: details ?? {} });
  }

  static permissionDenied(message: string, details?: Record<string, unknown>): TandemiseError {
    return new TandemiseError('PERMISSION_DENIED', message, { details: details ?? {} });
  }

  toJSON(): { code: ErrorCode; message: string; details: Record<string, unknown>; retryable: boolean } {
    return { code: this.code, message: this.message, details: this.details, retryable: this.retryable };
  }
}

const RETRYABLE_BY_DEFAULT = new Set<ErrorCode>(['TIMEOUT', 'RUNTIME_UNAVAILABLE', 'TARGET_UNAVAILABLE']);

export function isTandemiseError(e: unknown): e is TandemiseError {
  return e instanceof TandemiseError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
