/**
 * DataCache - local data store for caching subscription data.
 *
 * Only stores data from active subscriptions (not from once() calls).
 * Data is considered "live" if covered by an active subscription.
 */

import { getValueAtPath, normalizePath, setValueAtPath } from '../utils/path';

export class DataCache {
  // path -> cached value
  private cache = new Map<string, unknown>();

  /**
   * Store a value at a path.
   * Called when we receive data from a subscription event.
   */
  set(path: string, value: unknown): void {
    const normalized = normalizePath(path);
    this.cache.set(normalized, value);
  }

  /**
   * Get the cached value at a path.
   * Returns undefined if not in cache.
   *
   * This method handles nested lookups:
   * - If /boxes is cached with {0: true, 1: false}
   * - get('/boxes/0') returns true (extracted from parent)
   */
  get(path: string): { value: unknown; found: boolean } {
    const normalized = normalizePath(path);

    // First, check for exact match
    if (this.cache.has(normalized)) {
      return { value: this.cache.get(normalized), found: true };
    }

    // Next, check if any ancestor path has cached data we can extract from
    const ancestorResult = this.getFromAncestor(normalized);
    if (ancestorResult.found) {
      return ancestorResult;
    }

    return { value: undefined, found: false };
  }

  /**
   * Check if we have cached data that covers the given path.
   * This includes exact matches and ancestor paths.
   */
  has(path: string): boolean {
    return this.get(path).found;
  }

  /**
   * Try to get data from an ancestor path.
   * E.g., if /boxes is cached and we want /boxes/5, extract it.
   */
  private getFromAncestor(path: string): { value: unknown; found: boolean } {
    // Walk up the path tree looking for cached ancestors
    const segments = path.split('/').filter((s) => s.length > 0);

    for (let i = segments.length - 1; i >= 0; i--) {
      const ancestorPath = i === 0 ? '/' : '/' + segments.slice(0, i).join('/');

      if (this.cache.has(ancestorPath)) {
        const ancestorValue = this.cache.get(ancestorPath);
        // Calculate the relative path from ancestor to target
        const relativePath = '/' + segments.slice(i).join('/');
        const extractedValue = getValueAtPath(ancestorValue, relativePath);
        return { value: extractedValue, found: true };
      }
    }

    // Also check root
    if (this.cache.has('/')) {
      const rootValue = this.cache.get('/');
      const extractedValue = getValueAtPath(rootValue, path);
      return { value: extractedValue, found: true };
    }

    return { value: undefined, found: false };
  }

  /**
   * Remove cached data at a path.
   * Called when unsubscribing from a path that's no longer covered.
   */
  delete(path: string): void {
    const normalized = normalizePath(path);
    this.cache.delete(normalized);
  }

  /**
   * Remove cached data at a path and all descendant paths.
   * Called when a subscription is removed and no other subscription covers it.
   */
  deleteTree(path: string): void {
    const normalized = normalizePath(path);

    // Delete exact match
    this.cache.delete(normalized);

    // Delete all descendants
    const prefix = normalized === '/' ? '/' : normalized + '/';
    for (const cachedPath of this.cache.keys()) {
      if (cachedPath.startsWith(prefix) || (normalized === '/' && cachedPath !== '/')) {
        this.cache.delete(cachedPath);
      }
    }
  }

  /**
   * Update cache when a child value changes.
   * This updates both the child path and any cached ancestor that contains it.
   *
   * E.g., if /boxes is cached and /boxes/5 changes:
   * - Update the /boxes cache to reflect the new /boxes/5 value
   *
   * If an ancestor is null, it creates a new object to hold the child.
   */
  updateChild(path: string, value: unknown): void {
    const normalized = normalizePath(path);

    // Set the exact path
    this.cache.set(normalized, value);

    // Also update any cached ancestors that would contain this data
    const segments = normalized.split('/').filter((s) => s.length > 0);

    for (let i = segments.length - 1; i >= 1; i--) {
      const ancestorPath = '/' + segments.slice(0, i).join('/');

      if (this.cache.has(ancestorPath)) {
        const ancestorValue = this.cache.get(ancestorPath);
        // If ancestor is null, create a new object to hold the child
        const baseValue = (ancestorValue !== null && typeof ancestorValue === 'object')
          ? this.deepClone(ancestorValue)
          : {};
        const remainingPath = '/' + segments.slice(i).join('/');
        setValueAtPath(baseValue as Record<string, unknown>, remainingPath, value);
        this.cache.set(ancestorPath, baseValue);
      }
    }

    // Check root as well
    if (this.cache.has('/') && normalized !== '/') {
      const rootValue = this.cache.get('/');
      const baseValue = (rootValue !== null && typeof rootValue === 'object')
        ? this.deepClone(rootValue)
        : {};
      setValueAtPath(baseValue as Record<string, unknown>, normalized, value);
      this.cache.set('/', baseValue);
    }
  }

  /**
   * Remove a child from the cache (e.g., on child_removed event).
   */
  removeChild(path: string): void {
    const normalized = normalizePath(path);

    // Delete the exact path and any descendants
    this.deleteTree(normalized);

    // Also update any cached ancestors
    const segments = normalized.split('/').filter((s) => s.length > 0);

    for (let i = segments.length - 1; i >= 1; i--) {
      const ancestorPath = '/' + segments.slice(0, i).join('/');

      if (this.cache.has(ancestorPath)) {
        const ancestorValue = this.cache.get(ancestorPath);
        if (ancestorValue !== null && typeof ancestorValue === 'object') {
          const updatedAncestor = this.deepClone(ancestorValue);
          // Navigate to parent and delete the child key
          const parentPath = '/' + segments.slice(i, -1).join('/');
          const childKey = segments[segments.length - 1];
          const parent = parentPath === '/'
            ? updatedAncestor
            : getValueAtPath(updatedAncestor, parentPath);
          if (parent && typeof parent === 'object') {
            delete (parent as Record<string, unknown>)[childKey];
          }
          this.cache.set(ancestorPath, updatedAncestor);
        }
      }
    }
  }

  /**
   * Clear all cached data.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the number of cached paths (for testing/debugging).
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Deep clone a value to avoid mutation issues.
   */
  private deepClone<T>(value: T): T {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    return JSON.parse(JSON.stringify(value));
  }
}
