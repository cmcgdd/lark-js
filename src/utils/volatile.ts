/**
 * Volatile path matching utilities.
 *
 * Volatile paths are patterns where a wildcard matches exactly one path segment.
 * These paths use unreliable transport for better performance (WebTransport datagrams when available).
 */

/**
 * Check if a path matches any of the volatile path patterns.
 *
 * Pattern matching rules:
 * - Wildcard matches exactly one path segment
 * - Patterns and paths are compared segment by segment
 * - If pattern is exhausted before path, it's still a match (descendant rule)
 * - If path is exhausted before pattern, no match
 *
 * @param path - The path to check
 * @param patterns - Array of volatile patterns with wildcards
 * @returns true if the path matches any pattern
 */
export function isVolatilePath(path: string, patterns: string[] | null | undefined): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  // Remove leading slash and split into segments, filter empty
  const segments = path.replace(/^\//, '').split('/').filter(s => s.length > 0);

  return patterns.some((pattern) => {
    // Remove leading slash from pattern too and split
    const patternSegments = pattern.replace(/^\//, '').split('/').filter(s => s.length > 0);

    // If path has fewer segments than pattern, no match
    // (path must be at or below the pattern level)
    if (segments.length < patternSegments.length) {
      return false;
    }

    // Check each pattern segment matches the corresponding path segment
    // (* matches any single segment)
    for (let i = 0; i < patternSegments.length; i++) {
      const p = patternSegments[i];
      const s = segments[i];
      if (p !== '*' && p !== s) {
        return false;
      }
    }

    // Pattern exhausted - all segments matched
    // Path may have more segments (descendant) which is fine
    return true;
  });
}
