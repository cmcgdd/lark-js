/**
 * Path utilities for database paths.
 * Paths are Unix-style: /players/abc/score
 */

/**
 * Normalize a path to match server format:
 * - Root is "/"
 * - All other paths start with "/" and have no trailing slash
 * - Multiple slashes are collapsed
 */
export function normalizePath(path: string): string {
  if (!path || path === '/') return '/';

  // Split, filter empty segments, rejoin with leading slash
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return '/';

  return '/' + segments.join('/');
}

/**
 * Join path segments together.
 */
export function joinPath(...segments: string[]): string {
  const allParts: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === '/') continue;
    // Split each segment and add non-empty parts
    const parts = segment.split('/').filter((p) => p.length > 0);
    allParts.push(...parts);
  }

  if (allParts.length === 0) return '/';
  return '/' + allParts.join('/');
}

/**
 * Get the parent path. Returns "/" for paths one level deep, "/" for root.
 */
export function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '/') return '/';

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return '/';

  return normalized.substring(0, lastSlash);
}

/**
 * Get the last segment of a path (the "key").
 */
export function getKey(path: string): string | null {
  const normalized = normalizePath(path);
  if (normalized === '/') return null;

  const lastSlash = normalized.lastIndexOf('/');
  return normalized.substring(lastSlash + 1);
}

/**
 * Check if a path is valid (no invalid characters).
 */
export function isValidPath(path: string): boolean {
  if (path === '' || path === '/') return true;

  const normalized = normalizePath(path);
  // Filter out empty segments from leading slash
  const segments = normalized.split('/').filter((s) => s.length > 0);

  for (const segment of segments) {
    // Check for invalid characters: . $ # [ ]
    if (/[.\$#\[\]]/.test(segment)) {
      return false;
    }
  }

  return true;
}

/**
 * Get a nested value from an object by path.
 */
export function getValueAtPath(obj: unknown, path: string): unknown {
  const normalized = normalizePath(path);
  if (normalized === '/') return obj;

  // Split and filter empty segments (from leading slash)
  const segments = normalized.split('/').filter((s) => s.length > 0);
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Set a nested value in an object by path. Mutates the object.
 * Creates intermediate objects as needed.
 */
export function setValueAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const normalized = normalizePath(path);
  if (normalized === '/') {
    // Can't set root on an object
    return;
  }

  // Split and filter empty segments (from leading slash)
  const segments = normalized.split('/').filter((s) => s.length > 0);
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!(segment in current) || typeof current[segment] !== 'object' || current[segment] === null) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }

  const lastSegment = segments[segments.length - 1];
  current[lastSegment] = value;
}
