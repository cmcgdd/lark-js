import { describe, it, expect, beforeEach } from 'vitest';
import { DataCache } from '../cache/DataCache';

describe('DataCache', () => {
  let cache: DataCache;

  beforeEach(() => {
    cache = new DataCache();
  });

  describe('basic get/set', () => {
    it('stores and retrieves values at a path', () => {
      cache.set('/users/alice', { name: 'Alice', age: 30 });

      const result = cache.get('/users/alice');
      expect(result.found).toBe(true);
      expect(result.value).toEqual({ name: 'Alice', age: 30 });
    });

    it('returns found: false for non-existent paths', () => {
      const result = cache.get('/nonexistent');
      expect(result.found).toBe(false);
      expect(result.value).toBeUndefined();
    });

    it('normalizes paths', () => {
      cache.set('users/alice', { name: 'Alice' });

      // Should find with or without leading slash
      expect(cache.get('/users/alice').found).toBe(true);
      expect(cache.get('users/alice').found).toBe(true);
    });

    it('stores root path', () => {
      cache.set('/', { foo: 'bar' });

      const result = cache.get('/');
      expect(result.found).toBe(true);
      expect(result.value).toEqual({ foo: 'bar' });
    });

    it('handles null values', () => {
      cache.set('/path', null);

      const result = cache.get('/path');
      expect(result.found).toBe(true);
      expect(result.value).toBeNull();
    });

    it('handles primitive values', () => {
      cache.set('/count', 42);
      cache.set('/name', 'hello');
      cache.set('/active', true);

      expect(cache.get('/count').value).toBe(42);
      expect(cache.get('/name').value).toBe('hello');
      expect(cache.get('/active').value).toBe(true);
    });
  });

  describe('nested path extraction', () => {
    it('extracts child values from cached parent', () => {
      cache.set('/boxes', { 0: true, 1: false, 2: true });

      const result = cache.get('/boxes/1');
      expect(result.found).toBe(true);
      expect(result.value).toBe(false);
    });

    it('extracts deeply nested values', () => {
      cache.set('/users', {
        alice: {
          profile: {
            name: 'Alice',
            email: 'alice@example.com',
          },
        },
      });

      const result = cache.get('/users/alice/profile/name');
      expect(result.found).toBe(true);
      expect(result.value).toBe('Alice');
    });

    it('extracts from root cache', () => {
      cache.set('/', {
        users: { alice: { name: 'Alice' } },
        settings: { theme: 'dark' },
      });

      expect(cache.get('/users/alice/name').value).toBe('Alice');
      expect(cache.get('/settings/theme').value).toBe('dark');
    });

    it('returns undefined for non-existent nested paths', () => {
      cache.set('/users', { alice: { name: 'Alice' } });

      const result = cache.get('/users/bob');
      expect(result.found).toBe(true); // Parent exists
      expect(result.value).toBeUndefined(); // But child doesn't
    });

    it('prefers exact match over parent extraction', () => {
      cache.set('/users', { alice: { name: 'Old Alice' } });
      cache.set('/users/alice', { name: 'New Alice' });

      const result = cache.get('/users/alice');
      expect(result.value).toEqual({ name: 'New Alice' });
    });
  });

  describe('has()', () => {
    it('returns true for exact matches', () => {
      cache.set('/users', { alice: 1 });
      expect(cache.has('/users')).toBe(true);
    });

    it('returns true for extractable child paths', () => {
      cache.set('/users', { alice: { name: 'Alice' } });
      expect(cache.has('/users/alice')).toBe(true);
      expect(cache.has('/users/alice/name')).toBe(true);
    });

    it('returns false for uncached paths', () => {
      expect(cache.has('/users')).toBe(false);
    });
  });

  describe('delete()', () => {
    it('removes a cached value', () => {
      cache.set('/users/alice', { name: 'Alice' });
      cache.delete('/users/alice');

      expect(cache.get('/users/alice').found).toBe(false);
    });

    it('does not affect other paths', () => {
      cache.set('/users/alice', { name: 'Alice' });
      cache.set('/users/bob', { name: 'Bob' });

      cache.delete('/users/alice');

      expect(cache.get('/users/alice').found).toBe(false);
      expect(cache.get('/users/bob').found).toBe(true);
    });
  });

  describe('deleteTree()', () => {
    it('removes a path and all descendants', () => {
      cache.set('/users', { alice: 1 });
      cache.set('/users/alice', { name: 'Alice' });
      cache.set('/users/alice/profile', { bio: 'Hello' });
      cache.set('/settings', { theme: 'dark' });

      cache.deleteTree('/users');

      expect(cache.get('/users').found).toBe(false);
      expect(cache.get('/users/alice').found).toBe(false);
      expect(cache.get('/users/alice/profile').found).toBe(false);
      expect(cache.get('/settings').found).toBe(true);
    });

    it('handles root deletion', () => {
      cache.set('/', { foo: 'bar' });
      cache.set('/users', { alice: 1 });

      cache.deleteTree('/');

      expect(cache.size).toBe(0);
    });
  });

  describe('updateChild()', () => {
    it('sets the child path', () => {
      cache.updateChild('/boxes/5', true);

      const result = cache.get('/boxes/5');
      expect(result.found).toBe(true);
      expect(result.value).toBe(true);
    });

    it('updates cached parent with new child value', () => {
      cache.set('/boxes', { 0: true, 1: false, 2: true });

      cache.updateChild('/boxes/1', true);

      // Direct child cache should be updated
      expect(cache.get('/boxes/1').value).toBe(true);

      // Parent cache should also be updated
      const boxes = cache.get('/boxes').value as Record<string, boolean>;
      expect(boxes[1]).toBe(true);
    });

    it('updates deeply nested values in ancestors', () => {
      cache.set('/users', {
        alice: { scores: { game1: 100 } },
      });

      cache.updateChild('/users/alice/scores/game1', 200);

      const users = cache.get('/users').value as Record<string, unknown>;
      expect((users.alice as Record<string, unknown>).scores).toEqual({ game1: 200 });
    });

    it('does not mutate the original cached object', () => {
      const original = { 0: true, 1: false };
      cache.set('/boxes', original);

      cache.updateChild('/boxes/1', true);

      // Original should be unchanged
      expect(original[1]).toBe(false);
    });
  });

  describe('removeChild()', () => {
    it('deletes the child path from cache', () => {
      cache.set('/boxes/5', true);
      cache.removeChild('/boxes/5');

      expect(cache.get('/boxes/5').found).toBe(false);
    });

    it('updates cached parent to remove the child', () => {
      cache.set('/boxes', { 0: true, 1: false, 2: true });

      cache.removeChild('/boxes/1');

      const boxes = cache.get('/boxes').value as Record<string, boolean>;
      expect(boxes).toEqual({ 0: true, 2: true });
      expect('1' in boxes).toBe(false);
    });
  });

  describe('clear()', () => {
    it('removes all cached data', () => {
      cache.set('/users', { alice: 1 });
      cache.set('/boxes', { 0: true });
      cache.set('/settings', { theme: 'dark' });

      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.get('/users').found).toBe(false);
      expect(cache.get('/boxes').found).toBe(false);
      expect(cache.get('/settings').found).toBe(false);
    });
  });

  describe('size', () => {
    it('returns the number of cached paths', () => {
      expect(cache.size).toBe(0);

      cache.set('/a', 1);
      expect(cache.size).toBe(1);

      cache.set('/b', 2);
      expect(cache.size).toBe(2);

      cache.delete('/a');
      expect(cache.size).toBe(1);
    });
  });
});
