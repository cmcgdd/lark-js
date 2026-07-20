/**
 * SHA-256 hashing utilities for transaction conditions.
 *
 * Uses Web Crypto API which is available in:
 * - All modern browsers
 * - Node.js 16+ (via globalThis.crypto)
 */

import canonicalize from 'canonicalize';

/**
 * Compute SHA-256 hash of a value using JCS canonicalization.
 * Returns the hash as a hex string.
 *
 * @param value - The value to hash (will be JCS-canonicalized first)
 * @returns Hex-encoded SHA-256 hash
 */
export async function hashValue(value: unknown): Promise<string> {
  // JCS-canonicalize the value to ensure consistent serialization
  const canonical = canonicalize(value);

  if (canonical === undefined) {
    // canonicalize returns undefined for undefined input
    // Treat as empty string for hashing
    return hashString('');
  }

  return hashString(canonical);
}

/**
 * Compute SHA-256 hash of a string.
 * Returns the hash as a hex string.
 */
async function hashString(str: string): Promise<string> {
  // Convert string to Uint8Array
  const encoder = new TextEncoder();
  const data = encoder.encode(str);

  // Use Web Crypto API (available in browsers and Node.js 16+)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  // Convert ArrayBuffer to hex string
  const hashArray = new Uint8Array(hashBuffer);
  const hashHex = Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return hashHex;
}

/**
 * Check if a value is a primitive (not an object or array).
 * Primitives: null, undefined, boolean, number, string
 */
export function isPrimitive(value: unknown): boolean {
  return value === null || typeof value !== 'object';
}
