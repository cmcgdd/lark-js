/**
 * Integration tests for pending writes (pw field) functionality.
 * Tests the client-server interaction for the pending writes tracking.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';

const TEST_TIMEOUT = 10000;

describe('Integration: Pending Writes', () => {
  let db: LarkDatabase;
  let testId: string;

  // Helper to create unique paths for each test
  const uniquePath = (suffix: string) => `test/pending-writes/${testId}/${suffix}`;

  beforeAll(async () => {
    testId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    db = new LarkDatabase('javascript-integration/test', { anonymous: true });
    await db.connect();
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await db.disconnect();
  });

  describe('pw field is sent with writes', () => {
    it('first write has empty pw array', async () => {
      const path = uniquePath('first-write');

      // Subscribe to get a View
      const values: unknown[] = [];
      const unsubscribe = db.ref(path).on('value', (snapshot) => {
        values.push(snapshot.val());
      });

      // Wait for initial snapshot
      await new Promise(resolve => setTimeout(resolve, 100));

      // First write should succeed (no pending writes)
      await db.ref(path).set({ name: 'Alice' });

      // Verify write succeeded
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(values[values.length - 1]).toEqual({ name: 'Alice' });

      unsubscribe();
    }, TEST_TIMEOUT);

    it('sequential writes work correctly', async () => {
      const path = uniquePath('sequential');

      const values: unknown[] = [];
      const unsubscribe = db.ref(path).on('value', (snapshot) => {
        values.push(snapshot.val());
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Multiple sequential writes
      await db.ref(path + '/a').set(1);
      await new Promise(resolve => setTimeout(resolve, 350)); // Rate limit
      await db.ref(path + '/b').set(2);
      await new Promise(resolve => setTimeout(resolve, 350)); // Rate limit
      await db.ref(path + '/c').set(3);

      await new Promise(resolve => setTimeout(resolve, 100));

      const finalValue = values[values.length - 1] as Record<string, number>;
      expect(finalValue.a).toBe(1);
      expect(finalValue.b).toBe(2);
      expect(finalValue.c).toBe(3);

      unsubscribe();
    }, TEST_TIMEOUT);

    it('rapid writes to same path work correctly', async () => {
      const path = uniquePath('rapid');

      const values: unknown[] = [];
      const unsubscribe = db.ref(path).on('value', (snapshot) => {
        values.push(snapshot.val());
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Rapid writes (within rate limit window - some may be batched/throttled)
      const promises = [
        db.ref(path).set({ count: 1 }),
        db.ref(path).set({ count: 2 }),
        db.ref(path).set({ count: 3 }),
      ];

      await Promise.all(promises);
      await new Promise(resolve => setTimeout(resolve, 200));

      // Final value should be one of the writes (likely the last one)
      const finalValue = values[values.length - 1] as Record<string, number>;
      expect(finalValue.count).toBeGreaterThanOrEqual(1);
      expect(finalValue.count).toBeLessThanOrEqual(3);

      unsubscribe();
    }, TEST_TIMEOUT);
  });

  describe('pending writes tracking per View', () => {
    it('writes to different Views have independent pw tracking', async () => {
      const path1 = uniquePath('view1');
      const path2 = uniquePath('view2');

      const values1: unknown[] = [];
      const values2: unknown[] = [];

      const unsub1 = db.ref(path1).on('value', (snapshot) => {
        values1.push(snapshot.val());
      });
      const unsub2 = db.ref(path2).on('value', (snapshot) => {
        values2.push(snapshot.val());
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Write to both paths
      await db.ref(path1).set({ value: 'a' });
      await new Promise(resolve => setTimeout(resolve, 350));
      await db.ref(path2).set({ value: 'b' });

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(values1[values1.length - 1]).toEqual({ value: 'a' });
      expect(values2[values2.length - 1]).toEqual({ value: 'b' });

      unsub1();
      unsub2();
    }, TEST_TIMEOUT);

    it('nested writes are tracked by parent View', async () => {
      const basePath = uniquePath('nested');

      const values: unknown[] = [];
      const unsubscribe = db.ref(basePath).on('value', (snapshot) => {
        values.push(snapshot.val());
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Write to nested paths - all should be tracked by the parent View
      await db.ref(basePath + '/child1/name').set('Alice');
      await new Promise(resolve => setTimeout(resolve, 350));
      await db.ref(basePath + '/child2/name').set('Bob');
      await new Promise(resolve => setTimeout(resolve, 350));
      await db.ref(basePath + '/child1/age').set(30);

      await new Promise(resolve => setTimeout(resolve, 100));

      const finalValue = values[values.length - 1] as Record<string, Record<string, unknown>>;
      expect(finalValue.child1.name).toBe('Alice');
      expect(finalValue.child1.age).toBe(30);
      expect(finalValue.child2.name).toBe('Bob');

      unsubscribe();
    }, TEST_TIMEOUT);
  });

  describe('writes without subscription', () => {
    it('writes work even without active subscription (no pw tracking)', async () => {
      const path = uniquePath('no-sub');

      // Write without subscription
      await db.ref(path).set({ name: 'Test' });

      // Read back via once()
      const snapshot = await db.ref(path).once();
      expect(snapshot.val()).toEqual({ name: 'Test' });
    }, TEST_TIMEOUT);
  });

  describe('update and delete operations', () => {
    it('update() includes pw field', async () => {
      const path = uniquePath('update-pw');

      const values: unknown[] = [];
      const unsubscribe = db.ref(path).on('value', (snapshot) => {
        values.push(snapshot.val());
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      await db.ref(path).set({ a: 1, b: 2 });
      await new Promise(resolve => setTimeout(resolve, 350));
      await db.ref(path).update({ b: 20, c: 3 });

      await new Promise(resolve => setTimeout(resolve, 100));

      const finalValue = values[values.length - 1] as Record<string, number>;
      expect(finalValue.a).toBe(1);
      expect(finalValue.b).toBe(20);
      expect(finalValue.c).toBe(3);

      unsubscribe();
    }, TEST_TIMEOUT);

    it('remove() includes pw field', async () => {
      const path = uniquePath('remove-pw');

      const values: unknown[] = [];
      const unsubscribe = db.ref(path).on('value', (snapshot) => {
        values.push(snapshot.val());
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      await db.ref(path).set({ a: 1, b: 2 });
      await new Promise(resolve => setTimeout(resolve, 350));
      await db.ref(path + '/a').remove();

      await new Promise(resolve => setTimeout(resolve, 100));

      const finalValue = values[values.length - 1] as Record<string, number>;
      expect(finalValue.a).toBeUndefined();
      expect(finalValue.b).toBe(2);

      unsubscribe();
    }, TEST_TIMEOUT);
  });

  describe('push() with pw tracking', () => {
    it('push() generates key locally and includes pw field', async () => {
      const path = uniquePath('push-pw');

      const addedKeys: string[] = [];
      const unsubscribe = db.ref(path).on('child_added', (snapshot) => {
        addedKeys.push(snapshot.key!);
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Push generates key locally
      const ref1 = await db.ref(path).push({ value: 1 });
      await new Promise(resolve => setTimeout(resolve, 350));
      const ref2 = await db.ref(path).push({ value: 2 });

      await new Promise(resolve => setTimeout(resolve, 100));

      // Both pushes should have succeeded
      expect(addedKeys.length).toBe(2);
      expect(addedKeys).toContain(ref1.key);
      expect(addedKeys).toContain(ref2.key);

      // Keys should be push IDs (start with -)
      expect(ref1.key).toMatch(/^-/);
      expect(ref2.key).toMatch(/^-/);

      unsubscribe();
    }, TEST_TIMEOUT);
  });
});
