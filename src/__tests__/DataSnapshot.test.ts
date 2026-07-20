import { describe, it, expect, vi } from 'vitest';
import { DataSnapshot } from '../DataSnapshot';
import type { LarkDatabase } from '../LarkDatabase';

// Mock LarkDatabase
const createMockDb = () => {
  return {
    ref: vi.fn((path: string) => ({ path })),
  } as unknown as LarkDatabase;
};

describe('DataSnapshot', () => {
  describe('basic properties', () => {
    it('returns the key for non-root paths', () => {
      const db = createMockDb();
      const snap = new DataSnapshot({ foo: 'bar' }, '/players/abc', db);
      expect(snap.key).toBe('abc');
    });

    it('returns null key for root', () => {
      const db = createMockDb();
      const snap = new DataSnapshot({ foo: 'bar' }, '/', db);
      expect(snap.key).toBe(null);
    });

    it('returns the value via val()', () => {
      const db = createMockDb();
      const data = { name: 'Riley', score: 10 };
      const snap = new DataSnapshot(data, '/players/abc', db);
      expect(snap.val()).toEqual(data);
    });

    it('val() strips .priority from objects', () => {
      const db = createMockDb();
      const data = { name: 'Riley', '.priority': 5 };
      const snap = new DataSnapshot(data, '/players/abc', db);
      expect(snap.val()).toEqual({ name: 'Riley' });
    });

    it('val() returns null for object with only .priority', () => {
      const db = createMockDb();
      const data = { '.priority': 5 };
      const snap = new DataSnapshot(data, '/players/abc', db);
      expect(snap.val()).toBe(null);
    });

    it('val() does not strip .priority from arrays', () => {
      const db = createMockDb();
      const data = [1, 2, 3];
      const snap = new DataSnapshot(data, '/players/abc', db);
      expect(snap.val()).toEqual([1, 2, 3]);
    });

    it('val() renders an integer-keyed object as an array', () => {
      const db = createMockDb();
      // The optimistic layer produces integer-keyed objects; val() coerces them.
      const snap = new DataSnapshot({ '0': 'a', '1': 'b', '2': 'c' }, '/items', db);
      expect(snap.val()).toEqual(['a', 'b', 'c']);
    });

    it('val() leaves a sparse integer-keyed object as an object', () => {
      const db = createMockDb();
      // {2,4}: maxKey 4 is not < 2*2, so it stays an object.
      const snap = new DataSnapshot({ '2': 'c', '4': 'e' }, '/items', db);
      expect(snap.val()).toEqual({ '2': 'c', '4': 'e' });
    });

    it('val() returns primitives unchanged', () => {
      const db = createMockDb();
      expect(new DataSnapshot('hello', '/', db).val()).toBe('hello');
      expect(new DataSnapshot(123, '/', db).val()).toBe(123);
      expect(new DataSnapshot(true, '/', db).val()).toBe(true);
      expect(new DataSnapshot(null, '/', db).val()).toBe(null);
    });

    it('returns ref for the path', () => {
      const db = createMockDb();
      const snap = new DataSnapshot({}, '/players/abc', db);
      snap.ref;
      expect(db.ref).toHaveBeenCalledWith('/players/abc');
    });
  });

  describe('exists()', () => {
    it('returns true for non-null values', () => {
      const db = createMockDb();
      expect(new DataSnapshot({ foo: 'bar' }, '/', db).exists()).toBe(true);
      expect(new DataSnapshot('string', '/', db).exists()).toBe(true);
      expect(new DataSnapshot(0, '/', db).exists()).toBe(true);
      expect(new DataSnapshot(false, '/', db).exists()).toBe(true);
      expect(new DataSnapshot([], '/', db).exists()).toBe(true);
    });

    it('returns false for null and undefined', () => {
      const db = createMockDb();
      expect(new DataSnapshot(null, '/', db).exists()).toBe(false);
      expect(new DataSnapshot(undefined, '/', db).exists()).toBe(false);
    });
  });

  describe('child()', () => {
    it('returns a snapshot of the child data', () => {
      const db = createMockDb();
      const data = {
        players: {
          abc: { name: 'Riley' },
        },
      };
      const snap = new DataSnapshot(data, '/', db);
      const childSnap = snap.child('players/abc');

      expect(childSnap.val()).toEqual({ name: 'Riley' });
      expect(childSnap.key).toBe('abc');
    });

    it('returns snapshot with null for non-existent child (Firebase compatible)', () => {
      const db = createMockDb();
      const snap = new DataSnapshot({ foo: 'bar' }, '/', db);
      const childSnap = snap.child('nonexistent');

      expect(childSnap.val()).toBe(null);
      expect(childSnap.exists()).toBe(false);
    });

    it('preserves volatile flag', () => {
      const db = createMockDb();
      const snap = new DataSnapshot({ foo: 'bar' }, '/', db, { volatile: true });
      const childSnap = snap.child('foo');

      expect(childSnap.isVolatile()).toBe(true);
    });
  });

  describe('hasChildren() / hasChild() / numChildren()', () => {
    it('hasChildren returns true for objects with children', () => {
      const db = createMockDb();
      expect(new DataSnapshot({ a: 1 }, '/', db).hasChildren()).toBe(true);
      expect(new DataSnapshot({ a: 1, b: 2 }, '/', db).hasChildren()).toBe(true);
    });

    it('hasChildren returns false for empty objects and primitives', () => {
      const db = createMockDb();
      expect(new DataSnapshot({}, '/', db).hasChildren()).toBe(false);
      expect(new DataSnapshot('string', '/', db).hasChildren()).toBe(false);
      expect(new DataSnapshot(123, '/', db).hasChildren()).toBe(false);
      expect(new DataSnapshot(null, '/', db).hasChildren()).toBe(false);
    });

    it('hasChild returns true for existing children', () => {
      const db = createMockDb();
      const snap = new DataSnapshot({ a: 1, b: { c: 2 } }, '/', db);
      expect(snap.hasChild('a')).toBe(true);
      expect(snap.hasChild('b')).toBe(true);
      expect(snap.hasChild('b/c')).toBe(true);
    });

    it('hasChild returns false for non-existent children', () => {
      const db = createMockDb();
      const snap = new DataSnapshot({ a: 1 }, '/', db);
      expect(snap.hasChild('x')).toBe(false);
      expect(snap.hasChild('a/b')).toBe(false);
    });

    it('numChildren returns correct count', () => {
      const db = createMockDb();
      expect(new DataSnapshot({}, '/', db).numChildren()).toBe(0);
      expect(new DataSnapshot({ a: 1 }, '/', db).numChildren()).toBe(1);
      expect(new DataSnapshot({ a: 1, b: 2, c: 3 }, '/', db).numChildren()).toBe(3);
      expect(new DataSnapshot('string', '/', db).numChildren()).toBe(0);
    });
  });

  describe('forEach()', () => {
    it('iterates over children', () => {
      const db = createMockDb();
      const snap = new DataSnapshot({ a: 1, b: 2, c: 3 }, '/', db);
      const keys: string[] = [];
      const values: unknown[] = [];

      snap.forEach((child) => {
        keys.push(child.key!);
        values.push(child.val());
      });

      expect(keys).toContain('a');
      expect(keys).toContain('b');
      expect(keys).toContain('c');
      expect(values).toContain(1);
      expect(values).toContain(2);
      expect(values).toContain(3);
    });

    it('stops iteration when callback returns true', () => {
      const db = createMockDb();
      const snap = new DataSnapshot({ a: 1, b: 2, c: 3 }, '/', db);
      let count = 0;

      snap.forEach(() => {
        count++;
        return count >= 2; // Stop after 2 iterations
      });

      expect(count).toBe(2);
    });

    it('does nothing for primitives', () => {
      const db = createMockDb();
      const snap = new DataSnapshot('string', '/', db);
      const callback = vi.fn();

      snap.forEach(callback);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('volatile and priority', () => {
    it('isVolatile returns the volatile flag', () => {
      const db = createMockDb();
      expect(new DataSnapshot({}, '/', db).isVolatile()).toBe(false);
      expect(new DataSnapshot({}, '/', db, { volatile: false }).isVolatile()).toBe(false);
      expect(new DataSnapshot({}, '/', db, { volatile: true }).isVolatile()).toBe(true);
    });

    it('getPriority returns the priority from .priority field', () => {
      const db = createMockDb();
      expect(new DataSnapshot({}, '/', db).getPriority()).toBe(null);
      expect(new DataSnapshot({ '.priority': 5 }, '/', db).getPriority()).toBe(5);
      expect(new DataSnapshot({ '.priority': 'high' }, '/', db).getPriority()).toBe('high');
      expect(new DataSnapshot({ name: 'test' }, '/', db).getPriority()).toBe(null);
      expect(new DataSnapshot({ name: 'test', '.priority': 10 }, '/', db).getPriority()).toBe(10);
    });
  });

  describe('serverTimestamp', () => {
    it('getServerTimestamp returns null by default', () => {
      const db = createMockDb();
      expect(new DataSnapshot({}, '/', db).getServerTimestamp()).toBe(null);
    });

    it('getServerTimestamp returns the timestamp when provided', () => {
      const db = createMockDb();
      const ts = 1703350200123;
      expect(new DataSnapshot({}, '/', db, { serverTimestamp: ts }).getServerTimestamp()).toBe(ts);
    });

    it('child() preserves serverTimestamp', () => {
      const db = createMockDb();
      const ts = 1703350200123;
      const snap = new DataSnapshot({ foo: 'bar' }, '/', db, { volatile: true, serverTimestamp: ts });
      const childSnap = snap.child('foo');

      expect(childSnap.getServerTimestamp()).toBe(ts);
      expect(childSnap.isVolatile()).toBe(true);
    });
  });

  describe('toJSON()', () => {
    it('returns the same as val()', () => {
      const db = createMockDb();
      const data = { name: 'Riley', score: 10 };
      const snap = new DataSnapshot(data, '/', db);
      expect(snap.toJSON()).toEqual(snap.val());
    });
  });

  describe('wrapped primitives ({.value, .priority})', () => {
    // Primitives with priority are stored as { '.value': primitive, '.priority': priority }
    // This is Firebase's wire format for primitives with priority

    describe('val()', () => {
      it('unwraps wrapped string to just the string', () => {
        const db = createMockDb();
        const snap = new DataSnapshot({ '.value': 'hello', '.priority': 5 }, '/', db);
        expect(snap.val()).toBe('hello');
      });

      it('unwraps wrapped number to just the number', () => {
        const db = createMockDb();
        const snap = new DataSnapshot({ '.value': 42, '.priority': 10 }, '/', db);
        expect(snap.val()).toBe(42);
      });

      it('unwraps wrapped boolean to just the boolean', () => {
        const db = createMockDb();
        const snap = new DataSnapshot({ '.value': true, '.priority': 'high' }, '/', db);
        expect(snap.val()).toBe(true);
      });

      it('unwraps wrapped array to just the array', () => {
        const db = createMockDb();
        const snap = new DataSnapshot({ '.value': [1, 2, 3], '.priority': 5 }, '/', db);
        expect(snap.val()).toEqual([1, 2, 3]);
      });

      it('unwraps wrapped null to null', () => {
        const db = createMockDb();
        const snap = new DataSnapshot({ '.value': null, '.priority': 5 }, '/', db);
        expect(snap.val()).toBe(null);
      });
    });

    describe('exists()', () => {
      it('returns true for wrapped primitives', () => {
        const db = createMockDb();
        expect(new DataSnapshot({ '.value': 'hello', '.priority': 5 }, '/', db).exists()).toBe(true);
        expect(new DataSnapshot({ '.value': 0, '.priority': 5 }, '/', db).exists()).toBe(true);
        expect(new DataSnapshot({ '.value': false, '.priority': 5 }, '/', db).exists()).toBe(true);
      });
    });

    describe('hasChildren()', () => {
      it('returns false for wrapped primitives (they have no logical children)', () => {
        const db = createMockDb();
        expect(new DataSnapshot({ '.value': 'hello', '.priority': 5 }, '/', db).hasChildren()).toBe(false);
        expect(new DataSnapshot({ '.value': 42, '.priority': 10 }, '/', db).hasChildren()).toBe(false);
        expect(new DataSnapshot({ '.value': [1, 2, 3], '.priority': 5 }, '/', db).hasChildren()).toBe(false);
      });
    });

    describe('numChildren()', () => {
      it('returns 0 for wrapped primitives', () => {
        const db = createMockDb();
        expect(new DataSnapshot({ '.value': 'hello', '.priority': 5 }, '/', db).numChildren()).toBe(0);
        expect(new DataSnapshot({ '.value': 42, '.priority': 10 }, '/', db).numChildren()).toBe(0);
      });
    });

    describe('forEach()', () => {
      it('does not iterate for wrapped primitives', () => {
        const db = createMockDb();
        const snap = new DataSnapshot({ '.value': 'hello', '.priority': 5 }, '/', db);
        const callback = vi.fn();

        snap.forEach(callback);

        expect(callback).not.toHaveBeenCalled();
      });
    });

    describe('child()', () => {
      it('child(".priority") returns the priority value', () => {
        const db = createMockDb();
        const snap = new DataSnapshot({ '.value': 'hello', '.priority': 5 }, '/', db);
        expect(snap.child('.priority').val()).toBe(5);
      });

      it('child() of any other path returns null for wrapped primitives', () => {
        const db = createMockDb();
        const snap = new DataSnapshot({ '.value': 'hello', '.priority': 5 }, '/', db);
        expect(snap.child('foo').val()).toBe(null);
        expect(snap.child('.value').val()).toBe(null);
      });
    });

    describe('hasChild()', () => {
      it('hasChild(".priority") returns true for wrapped primitives with priority', () => {
        const db = createMockDb();
        const snap = new DataSnapshot({ '.value': 'hello', '.priority': 5 }, '/', db);
        expect(snap.hasChild('.priority')).toBe(true);
      });

      it('hasChild() returns false for other paths on wrapped primitives', () => {
        const db = createMockDb();
        const snap = new DataSnapshot({ '.value': 'hello', '.priority': 5 }, '/', db);
        expect(snap.hasChild('foo')).toBe(false);
        expect(snap.hasChild('.value')).toBe(false);
      });
    });

    describe('getPriority()', () => {
      it('returns priority from wrapped primitives', () => {
        const db = createMockDb();
        expect(new DataSnapshot({ '.value': 'hello', '.priority': 5 }, '/', db).getPriority()).toBe(5);
        expect(new DataSnapshot({ '.value': 42, '.priority': 'high' }, '/', db).getPriority()).toBe('high');
      });
    });

    describe('edge cases', () => {
      it('objects with .value and other keys are NOT treated as wrapped primitives', () => {
        const db = createMockDb();
        // This should NOT be treated as a wrapped primitive because it has other keys
        const snap = new DataSnapshot({ '.value': 'hello', '.priority': 5, foo: 'bar' }, '/', db);
        // val() should return the object (minus .priority), not unwrap
        expect(snap.val()).toEqual({ '.value': 'hello', foo: 'bar' });
        expect(snap.hasChildren()).toBe(true);
        expect(snap.numChildren()).toBe(2);
      });

      it('objects with only .value (no .priority) ARE treated as wrapped primitives', () => {
        // Server strips null priority, so { '.value': x } is a wrapped primitive
        const db = createMockDb();
        const snap = new DataSnapshot({ '.value': 'hello' }, '/', db);
        // Should unwrap to just the value
        expect(snap.val()).toEqual('hello');
        expect(snap.hasChildren()).toBe(false);
      });
    });
  });

  describe('forEach with orderedKeys', () => {
    it('uses provided orderedKeys for iteration order', () => {
      const db = createMockDb();
      const data = { a: 1, b: 2, c: 3 };
      // Provide orderedKeys in reverse order
      const snap = new DataSnapshot(data, '/', db, { orderedKeys: ['c', 'b', 'a'] });
      const keys: string[] = [];

      snap.forEach((child) => {
        keys.push(child.key!);
      });

      expect(keys).toEqual(['c', 'b', 'a']);
    });

    it('uses provided orderedKeys with custom ordering', () => {
      const db = createMockDb();
      const data = { alice: { score: 30 }, bob: { score: 10 }, charlie: { score: 20 } };
      // Simulate orderByChild('score') - sorted by score ascending
      const snap = new DataSnapshot(data, '/', db, { orderedKeys: ['bob', 'charlie', 'alice'] });
      const keys: string[] = [];

      snap.forEach((child) => {
        keys.push(child.key!);
      });

      expect(keys).toEqual(['bob', 'charlie', 'alice']);
    });

    it('falls back to getSortedKeys when orderedKeys not provided', () => {
      const db = createMockDb();
      const data = { b: 2, a: 1, c: 3 };
      // No orderedKeys - should use default key sorting
      const snap = new DataSnapshot(data, '/', db);
      const keys: string[] = [];

      snap.forEach((child) => {
        keys.push(child.key!);
      });

      // Default sorting puts integer-looking keys first, then lexicographic
      expect(keys).toEqual(['a', 'b', 'c']);
    });

    it('falls back to queryParams-based sorting when no orderedKeys', () => {
      const db = createMockDb();
      const data = {
        a: { '.priority': 3 },
        b: { '.priority': 1 },
        c: { '.priority': 2 },
      };
      // Provide queryParams instead of orderedKeys
      const snap = new DataSnapshot(data, '/', db, { queryParams: { orderBy: 'priority' } });
      const keys: string[] = [];

      snap.forEach((child) => {
        keys.push(child.key!);
      });

      // Should be sorted by priority: b(1), c(2), a(3)
      expect(keys).toEqual(['b', 'c', 'a']);
    });

    it('orderedKeys takes precedence over queryParams', () => {
      const db = createMockDb();
      const data = {
        a: { '.priority': 3 },
        b: { '.priority': 1 },
        c: { '.priority': 2 },
      };
      // Both provided - orderedKeys should win
      const snap = new DataSnapshot(data, '/', db, {
        queryParams: { orderBy: 'priority' },
        orderedKeys: ['a', 'b', 'c'],
      });
      const keys: string[] = [];

      snap.forEach((child) => {
        keys.push(child.key!);
      });

      // orderedKeys order, not priority order
      expect(keys).toEqual(['a', 'b', 'c']);
    });
  });
});
