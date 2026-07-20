/**
 * Validation utilities for keys and values.
 *
 * Server rules:
 * - Keys: UTF-8 encoded, max 768 bytes, cannot contain . $ # [ ] /
 *   or ASCII control characters (0-31, 127)
 *   Note: . is allowed as first character for special keys (.priority, .value, .sv)
 * - String values: Max 10 MB, no control character restriction
 */

import { LarkError } from '../LarkError';
import { ErrorCode } from '../protocol/constants';

/** Maximum key size in bytes */
const MAX_KEY_BYTES = 768;

/** Maximum string value size in bytes (10 MB) */
const MAX_STRING_VALUE_BYTES = 10 * 1024 * 1024;

/** Maximum write size in bytes for set/update operations (16 MB) */
const MAX_WRITE_BYTES = 16 * 1024 * 1024;

/** Maximum write size in bytes for volatile operations (2 KB) */
const MAX_VOLATILE_WRITE_BYTES = 2 * 1024;

/** Characters not allowed in keys */
const INVALID_KEY_CHARS = /[.#$\[\]\/]/;

/** ASCII control characters (0-31 and 127) */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Check if a string contains ASCII control characters.
 */
function hasControlChars(str: string): boolean {
  return CONTROL_CHARS.test(str);
}

/**
 * Get the byte length of a UTF-8 string.
 */
function getByteLength(str: string): number {
  // TextEncoder is available in browsers and Node.js 11+
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).length;
  }
  // Fallback for older environments
  return Buffer.byteLength(str, 'utf8');
}

/**
 * Validate a single key (path segment).
 *
 * @throws LarkError if key is invalid
 */
export function validateKey(key: string, context?: string): void {
  const prefix = context ? `${context}: ` : '';

  if (typeof key !== 'string') {
    throw new LarkError(
      ErrorCode.INVALID_DATA,
      `${prefix}key must be a string`
    );
  }

  if (key.length === 0) {
    throw new LarkError(
      ErrorCode.INVALID_DATA,
      `${prefix}key cannot be empty`
    );
  }

  // Check for invalid characters
  if (INVALID_KEY_CHARS.test(key)) {
    throw new LarkError(
      ErrorCode.INVALID_DATA,
      `${prefix}key "${key}" contains invalid characters (. $ # [ ] / are not allowed)`
    );
  }

  // Check for control characters
  if (hasControlChars(key)) {
    throw new LarkError(
      ErrorCode.INVALID_DATA,
      `${prefix}key "${key}" contains control characters (ASCII 0-31, 127 are not allowed)`
    );
  }

  // Check byte length
  const byteLength = getByteLength(key);
  if (byteLength > MAX_KEY_BYTES) {
    throw new LarkError(
      ErrorCode.INVALID_DATA,
      `${prefix}key "${key.substring(0, 50)}..." exceeds maximum size of ${MAX_KEY_BYTES} bytes (got ${byteLength})`
    );
  }
}

/**
 * Validate a path (multiple segments separated by /).
 * Each segment is validated as a key.
 *
 * @throws LarkError if any segment is invalid
 */
export function validatePath(path: string, context?: string): void {
  if (typeof path !== 'string') {
    throw new LarkError(
      ErrorCode.INVALID_PATH,
      `${context ? `${context}: ` : ''}path must be a string`
    );
  }

  // Empty path or root is valid
  if (path === '' || path === '/') {
    return;
  }

  // Split and validate each segment
  const segments = path.split('/').filter(s => s.length > 0);
  for (const segment of segments) {
    // Allow special keys: .priority, .value, .sv, .info (internal/system use)
    if (segment === '.priority' || segment === '.value' || segment === '.sv' || segment === '.info') {
      continue;
    }
    validateKey(segment, context);
  }
}

/**
 * Validate a value recursively.
 * - String values: max 10 MB (no control character restriction)
 * - Object keys are validated as keys
 * - .value can only coexist with .priority
 *
 * @throws LarkError if value contains invalid data
 */
export function validateValue(value: unknown, context?: string, path: string = ''): void {
  const prefix = context ? `${context}: ` : '';
  const location = path ? ` at "${path}"` : '';

  if (value === null || value === undefined) {
    return;
  }

  if (typeof value === 'string') {
    // Only check size - control characters are allowed in string values
    const byteLength = getByteLength(value);
    if (byteLength > MAX_STRING_VALUE_BYTES) {
      throw new LarkError(
        ErrorCode.INVALID_DATA,
        `${prefix}string value${location} exceeds maximum size of 10 MB (got ${Math.round(byteLength / 1024 / 1024 * 100) / 100} MB)`
      );
    }
    return;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      validateValue(value[i], context, path ? `${path}/${i}` : String(i));
    }
    return;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);

    // .value can only coexist with .priority
    if ('.value' in obj) {
      const otherKeys = keys.filter(k => k !== '.value' && k !== '.priority');
      if (otherKeys.length > 0) {
        const loc = path || '/';
        throw new LarkError(
          ErrorCode.INVALID_DATA,
          `${prefix}data at ${loc} contains ".value" alongside other children (${otherKeys.join(', ')}). ` +
          `".value" can only be used with ".priority" for primitives with priority.`
        );
      }
    }

    for (const [key, childValue] of Object.entries(obj)) {
      // Allow special keys: .priority, .value, .sv (ServerValue)
      if (key !== '.priority' && key !== '.value' && key !== '.sv') {
        validateKey(key, context);
      }
      validateValue(childValue, context, path ? `${path}/${key}` : key);
    }
    return;
  }

  // Other types (functions, symbols, etc.) are not valid
  throw new LarkError(
    ErrorCode.INVALID_DATA,
    `${prefix}invalid value type${location}: ${typeof value}`
  );
}

/**
 * Validate data for a write operation.
 * Validates both the value and any nested keys.
 */
export function validateWriteData(value: unknown, context?: string): void {
  validateValue(value, context);
}

/**
 * Get the JSON byte size of a value.
 * This measures the size as the server would see it (raw JSON bytes of the value).
 */
export function getJsonByteSize(value: unknown): number {
  const json = JSON.stringify(value);
  return getByteLength(json);
}

/**
 * Validate write size for set/update operations.
 * Server limit is 16 MB for the JSON-encoded value.
 *
 * @throws LarkError if value exceeds 16 MB
 */
export function validateWriteSize(value: unknown, context?: string): void {
  const byteSize = getJsonByteSize(value);
  if (byteSize > MAX_WRITE_BYTES) {
    const sizeMB = Math.round(byteSize / 1024 / 1024 * 100) / 100;
    throw new LarkError(
      ErrorCode.INVALID_DATA,
      `${context ? `${context}: ` : ''}write exceeds 16 MB limit (got ${sizeMB} MB)`
    );
  }
}

/**
 * Validate write size for volatile operations.
 * Server limit is 2 KB for volatile writes.
 *
 * @throws LarkError if value exceeds 2 KB
 */
export function validateVolatileWriteSize(value: unknown, context?: string): void {
  const byteSize = getJsonByteSize(value);
  if (byteSize > MAX_VOLATILE_WRITE_BYTES) {
    const sizeKB = Math.round(byteSize / 1024 * 100) / 100;
    throw new LarkError(
      ErrorCode.INVALID_DATA,
      `${context ? `${context}: ` : ''}volatile write exceeds 2 KB limit (got ${sizeKB} KB)`
    );
  }
}
