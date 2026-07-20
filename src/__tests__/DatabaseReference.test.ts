import { describe, it, expect, vi } from 'vitest';
import { DatabaseReference } from '../DatabaseReference';
import type { LarkDatabase } from '../LarkDatabase';
import type { DataSnapshot } from '../DataSnapshot';
import { LarkError } from '../LarkError';

// Mock LarkDatabase
const createMockDb = () => {
  return {
    _sendSet: vi.fn().mockResolvedValue(undefined),
    _sendUpdate: vi.fn().mockResolvedValue(undefined),
    _sendDelete: vi.fn().mockResolvedValue(undefined),
    _sendOnce: vi.fn().mockResolvedValue({ val: () => ({ foo: 'bar' }) } as unknown as DataSnapshot),
    _sendOnDisconnect: vi.fn().mockResolvedValue(undefined),
    _subscribe: vi.fn().mockReturnValue(() => {}),
    _unsubscribeEventType: vi.fn(),
    _unsubscribeAll: vi.fn(),
    _getBaseUrl: vi.fn().mockReturnValue('https://db.lark.sh/test/db'),
    isVolatilePath: vi.fn().mockReturnValue(false), // Default: not volatile
  } as unknown as LarkDatabase;
};

describe('DatabaseReference', () => {
  describe('path navigation', () => {
    it('returns the path with leading slash', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, '/players/abc');
      expect(ref.path).toBe('/players/abc');
    });

    it('normalizes path without leading slash', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players/abc');
      expect(ref.path).toBe('/players/abc');
    });

    it('returns "/" for root path', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, '');
      expect(ref.path).toBe('/');
    });

    it('returns the key', () => {
      const db = createMockDb();
      expect(new DatabaseReference(db, 'players/abc').key).toBe('abc');
      expect(new DatabaseReference(db, 'players').key).toBe('players');
      expect(new DatabaseReference(db, '').key).toBe(null);
    });

    it('returns parent reference', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players/abc');
      const parent = ref.parent;
      expect(parent?.path).toBe('/players');
    });

    it('returns null for root parent', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, '');
      expect(ref.parent).toBe(null);
    });

    it('returns root reference', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players/abc/score');
      const root = ref.root;
      expect(root.path).toBe('/');
    });

    it('child() returns a new reference', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players');
      const child = ref.child('abc');
      expect(child.path).toBe('/players/abc');
      expect(child).not.toBe(ref);
    });

    it('child() handles nested paths', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players');
      const child = ref.child('abc/score');
      expect(child.path).toBe('/players/abc/score');
    });
  });

  describe('write operations', () => {
    it('set() calls _sendSet with normalized path', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players/abc');
      await ref.set({ name: 'Riley' });
      expect(db._sendSet).toHaveBeenCalledWith('/players/abc', { name: 'Riley' });
    });

    it('update() calls _sendUpdate with normalized path', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players/abc');
      await ref.update({ score: 10 });
      expect(db._sendUpdate).toHaveBeenCalledWith('/players/abc', { score: 10 });
    });

    it('remove() calls _sendDelete with normalized path', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players/abc');
      await ref.remove();
      expect(db._sendDelete).toHaveBeenCalledWith('/players/abc');
    });

    it('push() without value returns reference immediately', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'chat');
      const result = ref.push();

      // Should return a DatabaseReference, not a Promise
      expect(result).toBeInstanceOf(DatabaseReference);
      expect((result as DatabaseReference).path).toMatch(/^\/chat\/-/);
      // Should not call any send method
      expect(db._sendSet).not.toHaveBeenCalled();
    });

    it('push() with value generates key locally and calls set()', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'chat');

      // First, let's verify that set() returns a promise
      const childRef = ref.child('test');
      const setResult = childRef.set({ foo: 'bar' });
      console.log('set() returned:', setResult, 'is Promise:', setResult instanceof Promise);

      const result = ref.push({ text: 'hello' });

      // Should return a ThenableReference (has .then and is a DatabaseReference)
      expect(typeof result.then).toBe('function');
      expect(typeof result.catch).toBe('function');
      expect(result).toBeInstanceOf(DatabaseReference);
      // Key is available immediately (before await)
      expect(result.path).toMatch(/^\/chat\/-/);

      // The set should have been called
      expect(db._sendSet).toHaveBeenCalled();

      // Test that we can await the set() result directly
      await setResult;

      // Now test push() promise resolves
      const pushResolved = await result;
      expect(pushResolved.path).toMatch(/^\/chat\/-/);
    });

    it('setWithPriority() injects .priority into value', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players/abc');
      await ref.setWithPriority({ name: 'Riley' }, 5);
      expect(db._sendSet).toHaveBeenCalledWith('/players/abc', { name: 'Riley', '.priority': 5 });
    });

    it('setWithPriority() with string priority', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players/abc');
      await ref.setWithPriority({ name: 'Riley' }, 'high');
      expect(db._sendSet).toHaveBeenCalledWith('/players/abc', { name: 'Riley', '.priority': 'high' });
    });

    it('setWithPriority() wraps primitives with .value and .priority', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players/abc');

      // Strings get wrapped
      await ref.setWithPriority('hello', 5);
      expect(db._sendSet).toHaveBeenCalledWith('/players/abc', { '.value': 'hello', '.priority': 5 });

      // Numbers get wrapped
      await ref.setWithPriority(123, 10);
      expect(db._sendSet).toHaveBeenCalledWith('/players/abc', { '.value': 123, '.priority': 10 });

      // Booleans get wrapped
      await ref.setWithPriority(true, 'high');
      expect(db._sendSet).toHaveBeenCalledWith('/players/abc', { '.value': true, '.priority': 'high' });

      // Arrays get wrapped (they're not plain objects)
      await ref.setWithPriority([1, 2, 3], 5);
      expect(db._sendSet).toHaveBeenCalledWith('/players/abc', { '.value': [1, 2, 3], '.priority': 5 });
    });

    it('setWithPriority() with null value just sets null', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players/abc');
      await ref.setWithPriority(null, 5);
      expect(db._sendSet).toHaveBeenCalledWith('/players/abc', null);
    });
  });

  describe('read operations', () => {
    it('once() calls _sendOnce', async () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players/abc');
      await ref.once();
      expect(db._sendOnce).toHaveBeenCalled();
    });
  });

  describe('subscriptions', () => {
    it('on() calls _subscribe and returns unsubscribe function', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players');
      const callback = vi.fn();
      const unsubscribe = ref.on('value', callback);

      // on() passes path, eventType, callback, queryParams, and queryIdentifier
      expect(db._subscribe).toHaveBeenCalledWith('/players', 'value', callback, undefined, 'default');
      expect(typeof unsubscribe).toBe('function');
    });

    it('off() without event type calls _unsubscribeAll', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players');
      ref.off();
      expect(db._unsubscribeAll).toHaveBeenCalledWith('/players');
    });

    it('off() with event type calls _unsubscribeEventType', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players');
      ref.off('child_added');
      expect(db._unsubscribeEventType).toHaveBeenCalledWith('/players', 'child_added');
    });
  });

  describe('onDisconnect', () => {
    it('returns OnDisconnect instance', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players/abc');
      const od = ref.onDisconnect();
      expect(od).toBeDefined();
    });
  });

  describe('query modifiers', () => {
    it('orderByKey() returns new reference', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players');
      const queried = ref.orderByKey();
      expect(queried).not.toBe(ref);
      expect(queried.path).toBe(ref.path);
    });

    it('orderByPriority() returns new reference', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players');
      const queried = ref.orderByPriority();
      expect(queried).not.toBe(ref);
    });

    it('limitToFirst() returns new reference', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players');
      const queried = ref.limitToFirst(10);
      expect(queried).not.toBe(ref);
    });

    it('limitToLast() returns new reference', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players');
      const queried = ref.limitToLast(10);
      expect(queried).not.toBe(ref);
    });

    it('query modifiers can be chained', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players');
      const queried = ref.orderByKey().limitToFirst(5);
      expect(queried).not.toBe(ref);
      expect(queried.path).toBe(ref.path);
    });
  });

  describe('toString', () => {
    it('returns the absolute URL for this location', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players/abc');
      expect(ref.toString()).toBe('https://db.lark.sh/test/db/players/abc');
    });

    it('returns just the base URL for root', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, '');
      expect(ref.toString()).toBe('https://db.lark.sh/test/db');
    });
  });

  describe('Query.ref property', () => {
    it('returns itself for non-query references', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players');
      expect(ref.ref).toBe(ref);
    });

    it('returns a reference without query constraints for queries', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players');
      const query = ref.orderByChild('score').limitToFirst(10);

      const queryRef = query.ref;
      expect(queryRef).not.toBe(query);
      expect(queryRef.path).toBe('/players');
      expect(queryRef.ref).toBe(queryRef); // The returned ref should return itself
    });

    it('ref.toString() returns same URL as query.toString() (same path)', () => {
      const db = createMockDb();
      const ref = new DatabaseReference(db, 'players');
      const query = ref.limitToLast(5);

      expect(query.ref.toString()).toBe(ref.toString());
    });
  });

  describe('query validation', () => {
    describe('orderBy validation', () => {
      it('throws when calling orderByKey() after orderByKey()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByKey().orderByKey()).toThrow(LarkError);
        expect(() => ref.orderByKey().orderByKey()).toThrow(/cannot use orderByKey\(\) with orderByKey\(\)/);
      });

      it('throws when calling orderByChild() after orderByKey()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByKey().orderByChild('score')).toThrow(LarkError);
        expect(() => ref.orderByKey().orderByChild('score')).toThrow(/cannot use orderByChild\(\) with orderByKey\(\)/);
      });

      it('throws when calling orderByKey() after orderByChild()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByChild('score').orderByKey()).toThrow(LarkError);
        expect(() => ref.orderByChild('score').orderByKey()).toThrow(/cannot use orderByKey\(\) with orderByChild\('score'\)/);
      });

      it('throws when calling orderByValue() after orderByPriority()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByPriority().orderByValue()).toThrow(LarkError);
        expect(() => ref.orderByPriority().orderByValue()).toThrow(/cannot use orderByValue\(\) with orderByPriority\(\)/);
      });

      it('throws when calling orderByPriority() after orderByValue()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByValue().orderByPriority()).toThrow(LarkError);
      });

      it('throws when calling orderByChild() after orderByChild()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByChild('score').orderByChild('name')).toThrow(LarkError);
      });
    });

    describe('limit validation', () => {
      it('throws when calling limitToFirst() twice', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.limitToFirst(10).limitToFirst(5)).toThrow(LarkError);
        expect(() => ref.limitToFirst(10).limitToFirst(5)).toThrow(/limitToFirst\(\) cannot be called multiple times/);
      });

      it('throws when calling limitToLast() twice', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.limitToLast(10).limitToLast(5)).toThrow(LarkError);
        expect(() => ref.limitToLast(10).limitToLast(5)).toThrow(/limitToLast\(\) cannot be called multiple times/);
      });

      it('throws when calling limitToFirst() after limitToLast()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.limitToLast(10).limitToFirst(5)).toThrow(LarkError);
        expect(() => ref.limitToLast(10).limitToFirst(5)).toThrow(/cannot use limitToFirst\(\) with limitToLast\(\)/);
      });

      it('throws when calling limitToLast() after limitToFirst()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.limitToFirst(10).limitToLast(5)).toThrow(LarkError);
        expect(() => ref.limitToFirst(10).limitToLast(5)).toThrow(/cannot use limitToLast\(\) with limitToFirst\(\)/);
      });
    });

    describe('startAt/endAt/equalTo validation', () => {
      it('throws when calling startAt() twice', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.startAt('a').startAt('b')).toThrow(LarkError);
        expect(() => ref.startAt('a').startAt('b')).toThrow(/startAt\(\)\/startAfter\(\) cannot be called multiple times/);
      });

      it('throws when calling endAt() twice', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.endAt('a').endAt('b')).toThrow(LarkError);
        expect(() => ref.endAt('a').endAt('b')).toThrow(/endAt\(\)\/endBefore\(\) cannot be called multiple times/);
      });

      it('throws when calling equalTo() twice', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.equalTo('a').equalTo('b')).toThrow(LarkError);
        expect(() => ref.equalTo('a').equalTo('b')).toThrow(/equalTo\(\) cannot be called multiple times/);
      });

      it('throws when calling startAt() after equalTo()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.equalTo('a').startAt('b')).toThrow(LarkError);
        expect(() => ref.equalTo('a').startAt('b')).toThrow(/cannot use startAt\(\) with equalTo\(\)/);
      });

      it('throws when calling endAt() after equalTo()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.equalTo('a').endAt('b')).toThrow(LarkError);
        expect(() => ref.equalTo('a').endAt('b')).toThrow(/cannot use endAt\(\) with equalTo\(\)/);
      });

      it('throws when calling equalTo() after startAt()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.startAt('a').equalTo('b')).toThrow(LarkError);
        expect(() => ref.startAt('a').equalTo('b')).toThrow(/cannot use equalTo\(\) with startAt\(\)/);
      });

      it('throws when calling equalTo() after endAt()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.endAt('a').equalTo('b')).toThrow(LarkError);
        expect(() => ref.endAt('a').equalTo('b')).toThrow(/cannot use equalTo\(\) with endAt\(\)/);
      });

      it('allows startAt() and endAt() together', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.startAt('a').endAt('z')).not.toThrow();
        expect(() => ref.endAt('z').startAt('a')).not.toThrow();
      });
    });

    describe('orderByKey type validation', () => {
      it('throws when startAt() with non-string value for orderByKey()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByKey().startAt(123)).toThrow(LarkError);
        expect(() => ref.orderByKey().startAt(123)).toThrow(/when using orderByKey\(\), the value must be a string/);
      });

      it('throws when endAt() with non-string value for orderByKey()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByKey().endAt(456)).toThrow(LarkError);
        expect(() => ref.orderByKey().endAt(456)).toThrow(/when using orderByKey\(\), the value must be a string/);
      });

      it('throws when equalTo() with non-string value for orderByKey()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByKey().equalTo(789)).toThrow(LarkError);
        expect(() => ref.orderByKey().equalTo(789)).toThrow(/when using orderByKey\(\), the value must be a string/);
      });

      it('throws when startAt() has key parameter with orderByKey()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByKey().startAt('a', 'keyNotAllowed')).toThrow(LarkError);
        expect(() => ref.orderByKey().startAt('a', 'keyNotAllowed')).toThrow(/when using orderByKey\(\), you cannot specify a key parameter/);
      });

      it('throws when endAt() has key parameter with orderByKey()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByKey().endAt('z', 'keyNotAllowed')).toThrow(LarkError);
        expect(() => ref.orderByKey().endAt('z', 'keyNotAllowed')).toThrow(/when using orderByKey\(\), you cannot specify a key parameter/);
      });

      it('throws when equalTo() has key parameter with orderByKey()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByKey().equalTo('abc', 'keyNotAllowed')).toThrow(LarkError);
        expect(() => ref.orderByKey().equalTo('abc', 'keyNotAllowed')).toThrow(/when using orderByKey\(\), you cannot specify a key parameter/);
      });

      it('allows string values with orderByKey()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByKey().startAt('a')).not.toThrow();
        expect(() => ref.orderByKey().endAt('z')).not.toThrow();
        expect(() => ref.orderByKey().equalTo('abc')).not.toThrow();
      });

      it('throws for null values with orderByKey()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByKey().startAt(null)).toThrow(LarkError);
        expect(() => ref.orderByKey().endAt(null)).toThrow(LarkError);
        expect(() => ref.orderByKey().equalTo(null)).toThrow(LarkError);
      });

      it('allows non-string values without orderByKey()', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        // Without orderByKey, numbers should be allowed
        expect(() => ref.orderByChild('score').startAt(100)).not.toThrow();
        expect(() => ref.orderByValue().endAt(500)).not.toThrow();
        expect(() => ref.orderByPriority().equalTo(1)).not.toThrow();
      });

      it('allows key parameter with non-orderByKey queries', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        // Key tie-breakers are allowed for other orderBy types
        expect(() => ref.orderByChild('score').startAt(100, 'alice')).not.toThrow();
        expect(() => ref.orderByValue().endAt(500, 'bob')).not.toThrow();
        expect(() => ref.orderByPriority().equalTo(1, 'charlie')).not.toThrow();
      });
    });

    describe('valid query combinations', () => {
      it('allows orderBy + limit', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByKey().limitToFirst(10)).not.toThrow();
        expect(() => ref.orderByChild('score').limitToLast(5)).not.toThrow();
      });

      it('allows orderBy + range + limit', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByKey().startAt('a').endAt('m').limitToFirst(10)).not.toThrow();
        expect(() => ref.orderByChild('score').startAt(100).limitToLast(5)).not.toThrow();
      });

      it('allows orderBy + equalTo + limit', () => {
        const db = createMockDb();
        const ref = new DatabaseReference(db, 'players');
        expect(() => ref.orderByChild('status').equalTo('active').limitToFirst(10)).not.toThrow();
      });
    });
  });
});
