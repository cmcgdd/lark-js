/**
 * Array coercion for read materialization.
 *
 * Data is held and addressed as integer-keyed maps. An object renders as an
 * array when it is non-empty, every key is a canonical non-negative integer,
 * and `maxKey < 2 * numKeys`; otherwise it stays an object. Absent indices in
 * `[0, maxKey]` become `null`.
 *
 * Applying this on read makes the shape identical whether a value arrived from
 * the server (already coerced) or from the local optimistic layer (which builds
 * integer-keyed objects), and keeps transaction hashes aligned with the server.
 */

/** Canonical non-negative integer: `0` or a non-zero-leading run of digits. */
const CANONICAL_INT = /^(0|[1-9]\d*)$/;

/**
 * Return the maximum index if `keys` should render as an array, else `null`.
 */
function arrayMaxIndex(keys: string[]): number | null {
  if (keys.length === 0) {
    return null;
  }
  let max = 0;
  for (const key of keys) {
    if (!CANONICAL_INT.test(key)) {
      return null;
    }
    const n = Number(key);
    if (n > max) {
      max = n;
    }
  }
  return max < 2 * keys.length ? max : null;
}

/**
 * Recursively coerce integer-keyed objects into arrays (gaps become `null`).
 * Arrays and primitives are returned with their children coerced.
 */
export function coerceArrays(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(coerceArrays);
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const max = arrayMaxIndex(keys);

  if (max !== null) {
    const arr: unknown[] = new Array(max + 1).fill(null);
    for (const key of keys) {
      arr[Number(key)] = coerceArrays(obj[key]);
    }
    return arr;
  }

  const result: Record<string, unknown> = {};
  for (const key of keys) {
    result[key] = coerceArrays(obj[key]);
  }
  return result;
}
