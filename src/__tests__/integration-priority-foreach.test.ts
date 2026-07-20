/**
 * Integration tests for:
 * 1. Primitive priority round-trip (setWithPriority with primitives)
 * 2. Subscription forEach ordering (value events iterate in correct order)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { LarkDatabase, DatabaseReference } from '../index';

// Use a unique database per test run to avoid conflicts
const testRunId = `priority-foreach-${Date.now()}`;
const DATABASE_ID = `javascript-integration/${testRunId}`;

// Helper to wait between writes (server rate limit: 3Hz for non-volatile)
const WRITE_DELAY = 350;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Generate a unique test path
const getUniqueTestPath = () => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  return `priority-foreach-test/${timestamp}-${random}`;
};

describe('Integration: Primitive Priority Round-Trip', () => {
  let db: LarkDatabase;
  let testPath: string;

  beforeAll(async () => {
    db = new LarkDatabase(DATABASE_ID, { anonymous: true });
    await db.connect();
  });

  afterAll(async () => {
    await db.disconnect();
  });

  beforeEach(() => {
    testPath = getUniqueTestPath();
  });

  describe('setWithPriority with primitives', () => {
    it('round-trips string with priority', async () => {
      const ref = db.ref(`${testPath}/string`);

      await ref.setWithPriority('hello', 5);
      await pause(WRITE_DELAY);

      const snap = await ref.once();
      expect(snap.val()).toBe('hello');
      expect(snap.getPriority()).toBe(5);
    });

    it('round-trips number with priority', async () => {
      const ref = db.ref(`${testPath}/number`);

      await ref.setWithPriority(42, 10);
      await pause(WRITE_DELAY);

      const snap = await ref.once();
      expect(snap.val()).toBe(42);
      expect(snap.getPriority()).toBe(10);
    });

    it('round-trips boolean with priority', async () => {
      const ref = db.ref(`${testPath}/boolean`);

      await ref.setWithPriority(true, 'high');
      await pause(WRITE_DELAY);

      const snap = await ref.once();
      expect(snap.val()).toBe(true);
      expect(snap.getPriority()).toBe('high');
    });

    it('round-trips zero with priority', async () => {
      const ref = db.ref(`${testPath}/zero`);

      await ref.setWithPriority(0, 1);
      await pause(WRITE_DELAY);

      const snap = await ref.once();
      expect(snap.val()).toBe(0);
      expect(snap.getPriority()).toBe(1);
    });

    it('round-trips false with priority', async () => {
      const ref = db.ref(`${testPath}/false`);

      await ref.setWithPriority(false, 2);
      await pause(WRITE_DELAY);

      const snap = await ref.once();
      expect(snap.val()).toBe(false);
      expect(snap.getPriority()).toBe(2);
    });

    it('round-trips empty string with priority', async () => {
      const ref = db.ref(`${testPath}/empty-string`);

      await ref.setWithPriority('', 3);
      await pause(WRITE_DELAY);

      const snap = await ref.once();
      expect(snap.val()).toBe('');
      expect(snap.getPriority()).toBe(3);
    });
  });

  describe('child(".priority") access', () => {
    it('can access priority via child(".priority") for wrapped primitives', async () => {
      const ref = db.ref(`${testPath}/access-priority`);

      await ref.setWithPriority('test value', 42);
      await pause(WRITE_DELAY);

      const snap = await ref.once();
      const prioritySnap = snap.child('.priority');
      expect(prioritySnap.val()).toBe(42);
    });

    it('can access priority via child(".priority") for objects', async () => {
      const ref = db.ref(`${testPath}/object-priority`);

      await ref.setWithPriority({ name: 'Riley' }, 99);
      await pause(WRITE_DELAY);

      const snap = await ref.once();
      const prioritySnap = snap.child('.priority');
      expect(prioritySnap.val()).toBe(99);
    });
  });

  describe('hasChildren/numChildren for wrapped primitives', () => {
    it('hasChildren returns false for wrapped primitives', async () => {
      const ref = db.ref(`${testPath}/has-children`);

      await ref.setWithPriority('primitive with priority', 5);
      await pause(WRITE_DELAY);

      const snap = await ref.once();
      expect(snap.val()).toBe('primitive with priority');
      expect(snap.hasChildren()).toBe(false);
      expect(snap.numChildren()).toBe(0);
    });
  });

  describe('priority ordering with primitives', () => {
    it('orderByPriority works with wrapped primitives', async () => {
      const ref = db.ref(`${testPath}/priority-order`);

      // Set primitives with different priorities
      await ref.child('c').setWithPriority('third', 3);
      await pause(WRITE_DELAY);
      await ref.child('a').setWithPriority('first', 1);
      await pause(WRITE_DELAY);
      await ref.child('b').setWithPriority('second', 2);
      await pause(WRITE_DELAY);

      // Query by priority
      const snap = await ref.orderByPriority().once();
      const keys: string[] = [];
      const values: string[] = [];

      snap.forEach((child) => {
        keys.push(child.key!);
        values.push(child.val() as string);
      });

      expect(keys).toEqual(['a', 'b', 'c']);
      expect(values).toEqual(['first', 'second', 'third']);
    });
  });
});

describe('Integration: Subscription forEach Ordering', () => {
  let db: LarkDatabase;
  let testPath: string;

  beforeAll(async () => {
    db = new LarkDatabase(DATABASE_ID, { anonymous: true });
    await db.connect();
  });

  afterAll(async () => {
    await db.disconnect();
  });

  beforeEach(() => {
    testPath = getUniqueTestPath();
  });

  describe('value subscription forEach with orderByChild', () => {
    it('forEach iterates in orderByChild order in subscription callback', async () => {
      const ref = db.ref(`${testPath}/order-by-child`);

      // Set up data
      await ref.set({
        alice: { score: 30 },
        bob: { score: 10 },
        charlie: { score: 20 },
      });
      await pause(WRITE_DELAY);

      // Subscribe with orderByChild
      const keys: string[] = [];
      const scores: number[] = [];

      await new Promise<void>((resolve) => {
        const unsubscribe = ref.orderByChild('score').on('value', (snap) => {
          snap.forEach((child) => {
            keys.push(child.key!);
            scores.push((child.val() as { score: number }).score);
          });
          unsubscribe();
          resolve();
        });
      });

      // Should be ordered by score ascending
      expect(keys).toEqual(['bob', 'charlie', 'alice']);
      expect(scores).toEqual([10, 20, 30]);
    });
  });

  describe('value subscription forEach with orderByPriority', () => {
    it('forEach iterates in priority order in subscription callback', async () => {
      const ref = db.ref(`${testPath}/order-by-priority`);

      // Set up data with priorities
      await ref.child('c').setWithPriority({ name: 'Charlie' }, 3);
      await pause(WRITE_DELAY);
      await ref.child('a').setWithPriority({ name: 'Alice' }, 1);
      await pause(WRITE_DELAY);
      await ref.child('b').setWithPriority({ name: 'Bob' }, 2);
      await pause(WRITE_DELAY);

      // Subscribe with orderByPriority
      const keys: string[] = [];

      await new Promise<void>((resolve) => {
        const unsubscribe = ref.orderByPriority().on('value', (snap) => {
          snap.forEach((child) => {
            keys.push(child.key!);
          });
          unsubscribe();
          resolve();
        });
      });

      // Should be ordered by priority
      expect(keys).toEqual(['a', 'b', 'c']);
    });
  });

  describe('value subscription forEach with orderByKey', () => {
    it('forEach iterates in key order in subscription callback', async () => {
      const ref = db.ref(`${testPath}/order-by-key`);

      // Set up data (keys intentionally out of order)
      await ref.set({
        zebra: 1,
        alpha: 2,
        mango: 3,
      });
      await pause(WRITE_DELAY);

      // Subscribe with orderByKey
      const keys: string[] = [];

      await new Promise<void>((resolve) => {
        const unsubscribe = ref.orderByKey().on('value', (snap) => {
          snap.forEach((child) => {
            keys.push(child.key!);
          });
          unsubscribe();
          resolve();
        });
      });

      // Should be ordered alphabetically by key
      expect(keys).toEqual(['alpha', 'mango', 'zebra']);
    });
  });

  describe('value subscription forEach with orderByValue', () => {
    it('forEach iterates in value order in subscription callback', async () => {
      const ref = db.ref(`${testPath}/order-by-value`);

      // Set up primitive values
      await ref.set({
        a: 30,
        b: 10,
        c: 20,
      });
      await pause(WRITE_DELAY);

      // Subscribe with orderByValue
      const keys: string[] = [];
      const values: number[] = [];

      await new Promise<void>((resolve) => {
        const unsubscribe = ref.orderByValue().on('value', (snap) => {
          snap.forEach((child) => {
            keys.push(child.key!);
            values.push(child.val() as number);
          });
          unsubscribe();
          resolve();
        });
      });

      // Should be ordered by value ascending
      expect(keys).toEqual(['b', 'c', 'a']);
      expect(values).toEqual([10, 20, 30]);
    });
  });

  describe('once() forEach ordering', () => {
    it('once() forEach also respects orderByChild', async () => {
      const ref = db.ref(`${testPath}/once-order`);

      // Set up data
      await ref.set({
        x: { age: 25 },
        y: { age: 18 },
        z: { age: 30 },
      });
      await pause(WRITE_DELAY);

      // Once with orderByChild
      const snap = await ref.orderByChild('age').once();
      const keys: string[] = [];

      snap.forEach((child) => {
        keys.push(child.key!);
      });

      // Should be ordered by age ascending
      expect(keys).toEqual(['y', 'x', 'z']);
    });
  });

  describe('subscription forEach with primitives with priority', () => {
    it('forEach iterates primitives in priority order', async () => {
      const ref = db.ref(`${testPath}/primitive-priority-sub`);

      // Set primitives with priorities
      await ref.child('third').setWithPriority('C', 3);
      await pause(WRITE_DELAY);
      await ref.child('first').setWithPriority('A', 1);
      await pause(WRITE_DELAY);
      await ref.child('second').setWithPriority('B', 2);
      await pause(WRITE_DELAY);

      // Subscribe with orderByPriority
      const keys: string[] = [];
      const values: string[] = [];

      await new Promise<void>((resolve) => {
        const unsubscribe = ref.orderByPriority().on('value', (snap) => {
          snap.forEach((child) => {
            keys.push(child.key!);
            values.push(child.val() as string);
          });
          unsubscribe();
          resolve();
        });
      });

      // Should be in priority order
      expect(keys).toEqual(['first', 'second', 'third']);
      expect(values).toEqual(['A', 'B', 'C']);
    });
  });
});
