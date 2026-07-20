/**
 * LarkError - custom error class for Lark operations.
 *
 * Standard error codes:
 * - `permission_denied` - Security rules rejected operation
 * - `invalid_data` - Malformed data
 * - `not_found` - Path doesn't exist
 * - `invalid_path` - Invalid path format
 * - `timeout` - Request timed out
 * - `not_connected` - Operation attempted while disconnected
 * - `condition_failed` - Transaction condition check failed (CAS mismatch)
 * - `max_retries_exceeded` - Optimistic transaction exceeded retry limit
 * - `write_tainted` - Write rejected locally because it depended on a failed write
 * - `view_recovering` - Write rejected because View is recovering from failed write
 */

export class LarkError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message || code);
    this.code = code;
    this.name = 'LarkError';

    // Maintain proper stack trace in V8 environments
    const ErrorWithCapture = Error as typeof Error & {
      captureStackTrace?: (target: object, constructor: Function) => void;
    };
    if (ErrorWithCapture.captureStackTrace) {
      ErrorWithCapture.captureStackTrace(this, LarkError);
    }
  }
}
