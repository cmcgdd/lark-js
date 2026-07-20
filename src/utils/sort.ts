/**
 * Sorting utilities for client-side data ordering.
 *
 * Implements sorting rules matching the server:
 * - Type hierarchy: null < false < true < numbers < strings < objects
 * - orderByKey: special handling for 32-bit integer keys
 * - orderByChild: sorts by nested child value
 * - orderByValue: sorts by the value itself
 * - orderByPriority: same as orderByChild('.priority')
 *
 * All sorting includes tie-breaking by key when values are equal.
 */

import { QueryParams } from '../protocol/messages';

/**
 * Entry for sorting - contains key, value, and sort value.
 */
export interface SortEntry {
  key: string;
  value: unknown;
  sortValue: unknown; // The value to sort by (depends on orderBy)
}

/**
 * Returns the type rank for value sorting.
 * Order: null (0) < false (1) < true (2) < numbers (3) < strings (4) < objects (5)
 */
export function typeRank(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'boolean') {
    return value ? 2 : 1; // false = 1, true = 2
  }
  if (typeof value === 'number') {
    return 3;
  }
  if (typeof value === 'string') {
    return 4;
  }
  if (typeof value === 'object') {
    return 5;
  }
  return 6; // Unknown types sort last
}

/**
 * Compare two values using type-aware ordering rules.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareValues(a: unknown, b: unknown): number {
  const rankA = typeRank(a);
  const rankB = typeRank(b);

  // Different types - compare by rank
  if (rankA !== rankB) {
    return rankA < rankB ? -1 : 1;
  }

  // Same type - compare values
  switch (rankA) {
    case 0: // null
      return 0;

    case 1: // false
    case 2: // true
      return 0; // Same boolean value (rank already differentiated)

    case 3: // number
      const numA = a as number;
      const numB = b as number;
      if (numA < numB) return -1;
      if (numA > numB) return 1;
      return 0;

    case 4: // string
      const strA = a as string;
      const strB = b as string;
      if (strA < strB) return -1;
      if (strA > strB) return 1;
      return 0;

    case 5: // object
      return 0; // Objects are equal for value comparison, sort by key

    default:
      return 0;
  }
}

/**
 * Check if a key should be treated as a 32-bit integer for sorting.
 * Integer keys sort numerically before string keys.
 */
export function isInt32Key(key: string): boolean {
  if (key.length === 0) {
    return false;
  }

  // Check for leading zeros (except "0" itself)
  if (key.length > 1 && key[0] === '0') {
    return false;
  }

  // Handle negative numbers
  if (key[0] === '-') {
    if (key.length === 1) {
      return false; // Just "-" is not valid
    }
    // Check for leading zeros after minus: "-0", "-007"
    if (key.length > 2 && key[1] === '0') {
      return false;
    }
    // Check for "-0" (negative zero)
    if (key === '-0') {
      return false;
    }
  }

  // Try to parse as integer
  const parsed = parseInt(key, 10);
  if (isNaN(parsed)) {
    return false;
  }

  // Check if it's the same string (no extra characters, no scientific notation)
  if (String(parsed) !== key) {
    return false;
  }

  // Check 32-bit signed integer range
  const MIN_INT32 = -2147483648;
  const MAX_INT32 = 2147483647;
  return parsed >= MIN_INT32 && parsed <= MAX_INT32;
}

/**
 * Compare two keys using orderByKey rules.
 * Integer keys sort numerically first, then string keys sort lexicographically.
 */
export function compareKeys(a: string, b: string): number {
  const aIsInt = isInt32Key(a);
  const bIsInt = isInt32Key(b);

  // Integers come before strings
  if (aIsInt && !bIsInt) {
    return -1;
  }
  if (!aIsInt && bIsInt) {
    return 1;
  }

  // Both integers: compare numerically
  if (aIsInt && bIsInt) {
    const aInt = parseInt(a, 10);
    const bInt = parseInt(b, 10);
    if (aInt < bInt) return -1;
    if (aInt > bInt) return 1;
    return 0;
  }

  // Both strings: compare lexicographically
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Get a nested value from an object using a path.
 */
function getNestedValue(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }

  const segments = path.split('/').filter((s) => s.length > 0);
  let current: unknown = obj;

  for (const segment of segments) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Get the sort value for an entry based on query parameters.
 */
export function getSortValue(value: unknown, queryParams: QueryParams | null): unknown {
  // If no queryParams, default to priority ordering
  if (!queryParams) {
    return getNestedValue(value, '.priority');
  }

  // orderByPriority is normalized to orderByChild('.priority') on the server
  // but we handle it explicitly here too
  if (queryParams.orderBy === 'priority') {
    return getNestedValue(value, '.priority');
  }

  if (queryParams.orderByChild) {
    return getNestedValue(value, queryParams.orderByChild);
  }

  if (queryParams.orderBy === 'value') {
    return value;
  }

  if (queryParams.orderBy === 'key') {
    return null; // orderByKey uses key, not value
  }

  // No explicit orderBy - check if there are range filters or limits
  // If so, default to priority ordering (matching server behavior)
  const hasRangeFilter =
    queryParams.startAt !== undefined ||
    queryParams.startAfter !== undefined ||
    queryParams.endAt !== undefined ||
    queryParams.endBefore !== undefined ||
    queryParams.equalTo !== undefined;

  const hasLimit =
    queryParams.limitToFirst !== undefined ||
    queryParams.limitToLast !== undefined;

  if (hasRangeFilter || hasLimit) {
    // Default to priority when range filters or limits exist but no orderBy specified
    return getNestedValue(value, '.priority');
  }

  // No ordering constraints - key is used
  return null;
}

/**
 * Compare two entries for sorting.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareEntries(a: SortEntry, b: SortEntry, queryParams: QueryParams | null): number {
  // If explicitly ordering by key, just compare keys
  if (queryParams?.orderBy === 'key') {
    return compareKeys(a.key, b.key);
  }

  // Compare by sort value first (priority by default, or specified orderBy)
  const cmp = compareValues(a.sortValue, b.sortValue);
  if (cmp !== 0) {
    return cmp;
  }

  // Equal sort values - tie-break by key
  return compareKeys(a.key, b.key);
}

/**
 * Sort an array of entries according to query parameters.
 * Modifies the array in place and returns it.
 */
export function sortEntries(entries: SortEntry[], queryParams: QueryParams | null): SortEntry[] {
  entries.sort((a, b) => compareEntries(a, b, queryParams));
  return entries;
}

/**
 * Create sort entries from an object's children.
 */
export function createSortEntries(data: unknown, queryParams: QueryParams | null): SortEntry[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return [];
  }

  const obj = data as Record<string, unknown>;
  const entries: SortEntry[] = [];

  // Check if this is a wrapped primitive (only .value and .priority keys)
  // Wrapped primitives have no children to sort
  const keys = Object.keys(obj);
  if (
    keys.length === 2 &&
    '.value' in obj &&
    '.priority' in obj
  ) {
    return [];
  }

  for (const key of keys) {
    // Skip .priority when creating entries (it's metadata, not a child)
    if (key === '.priority') {
      continue;
    }

    const value = obj[key];
    entries.push({
      key,
      value,
      sortValue: getSortValue(value, queryParams),
    });
  }

  return sortEntries(entries, queryParams);
}

/**
 * Get the sorted keys from data according to query parameters.
 */
export function getSortedKeys(data: unknown, queryParams: QueryParams | null): string[] {
  const entries = createSortEntries(data, queryParams);
  return entries.map((e) => e.key);
}

/**
 * Find the position where a key should be inserted to maintain sort order.
 * Returns the index of the key that should come before this one,
 * or -1 if it should be first.
 */
export function findInsertPosition(
  orderedKeys: string[],
  data: Record<string, unknown>,
  newKey: string,
  queryParams: QueryParams | null
): number {
  const newValue = data[newKey];
  const newSortValue = getSortValue(newValue, queryParams);
  const newEntry: SortEntry = { key: newKey, value: newValue, sortValue: newSortValue };

  // Find where this entry belongs
  for (let i = 0; i < orderedKeys.length; i++) {
    const existingKey = orderedKeys[i];
    const existingValue = data[existingKey];
    const existingSortValue = getSortValue(existingValue, queryParams);
    const existingEntry: SortEntry = { key: existingKey, value: existingValue, sortValue: existingSortValue };

    const cmp = compareEntries(newEntry, existingEntry, queryParams);
    if (cmp < 0) {
      // New entry should come before this one
      return i - 1; // Return the previous index, or -1 if first
    }
  }

  // New entry goes at the end
  return orderedKeys.length - 1;
}

/**
 * Get the previous child key (the key that comes before this one in sorted order).
 * Returns null if this key should be first.
 */
export function getPreviousKey(orderedKeys: string[], key: string): string | null {
  const idx = orderedKeys.indexOf(key);
  if (idx <= 0) return null;
  return orderedKeys[idx - 1];
}
