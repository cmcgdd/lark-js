/**
 * Integration tests for cache consistency.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LarkDatabase } from '../LarkDatabase';
import { getSharedDb, disconnectSharedDb, wait, uniquePath } from './integration-utils';

describe('Integration: Cache Consistency', () => {
  let db: LarkDatabase;

  beforeAll(async () => {
    db = await getSharedDb();
  });

  afterAll(async () => {
    await disconnectSharedDb();
  });

  describe('once() with active subscription', () => {
    it('once() returns cached data when subscribed', async () => {
      const path = uniquePath('test/cache/once-cached');
      const ref = db.ref(path);

      await ref.set({ value: 'cached-value' });

      // Subscribe to cache the data
      let subscriptionValue: unknown = null;
      const unsubscribe = ref.on('value', (snapshot) => {
        subscriptionValue = snapshot.val();
      });

      await wait(200);
      expect(subscriptionValue).toEqual({ value: 'cached-value' });

      // once() should use cache
      const startTime = Date.now();
      const snapshot = await ref.once();
      const elapsed = Date.now() - startTime;

      expect(snapshot.val()).toEqual({ value: 'cached-value' });
      expect(elapsed).toBeLessThan(50); // Cache hit should be very fast

      unsubscribe();
    });

    it('once() on child path uses parent cache', async () => {
      const path = uniquePath('test/cache/child-cache');
      const ref = db.ref(path);

      await ref.set({
        child1: { value: 1 },
        child2: { value: 2 },
        child3: { value: 3 },
      });

      // Subscribe to parent
      const unsubscribe = ref.on('value', () => {});

      await wait(200);

      // once() on child should use parent's cache
      const startTime = Date.now();
      const snapshot = await ref.child('child2').once();
      const elapsed = Date.now() - startTime;

      expect(snapshot.val()).toEqual({ value: 2 });
      expect(elapsed).toBeLessThan(50);

      unsubscribe();
    });
  });

  describe('cache updates correctly', () => {
    it('cache updates after child_added', async () => {
      const path = uniquePath('test/cache/update-add');
      const ref = db.ref(path);

      await ref.set({
        existing: { value: 1 },
      });

      const unsubscribe = ref.on('value', () => {});

      await wait(150);

      // Add a new child
      await ref.child('newChild').set({ value: 2 });

      await wait(200);

      // once() should return updated data
      const snapshot = await ref.once();
      const val = snapshot.val() as Record<string, unknown>;

      expect(val.existing).toEqual({ value: 1 });
      expect(val.newChild).toEqual({ value: 2 });

      unsubscribe();
    });

    it('cache updates after child_changed', async () => {
      const path = uniquePath('test/cache/update-change');
      const ref = db.ref(path);

      await ref.set({
        item: { count: 1 },
      });

      const unsubscribe = ref.on('value', () => {});

      await wait(150);

      // Update the child
      await ref.child('item/count').set(10);

      await wait(200);

      // once() should return updated data
      const snapshot = await ref.once();
      const val = snapshot.val() as Record<string, unknown>;

      expect(val.item).toEqual({ count: 10 });

      unsubscribe();
    });

    it('cache updates after child_removed', async () => {
      const path = uniquePath('test/cache/update-remove');
      const ref = db.ref(path);

      await ref.set({
        keep: { value: 1 },
        remove: { value: 2 },
      });

      const unsubscribe = ref.on('value', () => {});

      await wait(150);

      // Remove a child
      await ref.child('remove').remove();

      await wait(200);

      // once() should return updated data without removed child
      const snapshot = await ref.once();
      const val = snapshot.val() as Record<string, unknown>;

      expect(val.keep).toEqual({ value: 1 });
      expect(val.remove).toBeUndefined();

      unsubscribe();
    });
  });

  describe('cache reflects delta updates', () => {
    it('nested update is reflected in cache', async () => {
      const path = uniquePath('test/cache/delta-nested');
      const ref = db.ref(path);

      await ref.set({
        user: {
          profile: {
            name: 'Alice',
            bio: 'Original bio',
          },
          settings: {
            theme: 'light',
          },
        },
      });

      const unsubscribe = ref.on('value', () => {});

      await wait(150);

      // Update deeply nested value
      await ref.child('user/profile/bio').set('Updated bio');

      await wait(200);

      // Cache should reflect the update
      const snapshot = await ref.once();
      const val = snapshot.val() as Record<string, unknown>;
      const profile = (val.user as Record<string, unknown>).profile as Record<string, unknown>;

      expect(profile.name).toBe('Alice'); // Unchanged
      expect(profile.bio).toBe('Updated bio'); // Changed

      unsubscribe();
    });

    it('multiple rapid updates are all reflected', async () => {
      const path = uniquePath('test/cache/delta-rapid');
      const ref = db.ref(path);

      await ref.set({ counter: 0 });

      const unsubscribe = ref.on('value', () => {});

      await wait(150);

      // Rapid updates
      await ref.child('counter').set(1);
      await ref.child('counter').set(2);
      await ref.child('counter').set(3);

      await wait(300);

      // Cache should have final value
      const snapshot = await ref.once();
      expect(snapshot.val()).toEqual({ counter: 3 });

      unsubscribe();
    });
  });

  describe('cache isolation', () => {
    it('different paths have independent caches', async () => {
      const path1 = uniquePath('test/cache/iso1');
      const path2 = uniquePath('test/cache/iso2');

      await db.ref(path1).set({ data: 'path1-data' });
      await db.ref(path2).set({ data: 'path2-data' });

      const unsub1 = db.ref(path1).on('value', () => {});
      const unsub2 = db.ref(path2).on('value', () => {});

      await wait(200);

      // Update path1 only
      await db.ref(path1).set({ data: 'path1-updated' });

      await wait(200);

      // path1 should be updated
      const snap1 = await db.ref(path1).once();
      expect(snap1.val()).toEqual({ data: 'path1-updated' });

      // path2 should be unchanged
      const snap2 = await db.ref(path2).once();
      expect(snap2.val()).toEqual({ data: 'path2-data' });

      unsub1();
      unsub2();
    });
  });

  describe('cache cleared on unsubscribe', () => {
    it('once() fetches from server after unsubscribe', async () => {
      const path = uniquePath('test/cache/clear-unsub');
      const ref = db.ref(path);

      await ref.set({ value: 'original' });

      // Subscribe then unsubscribe
      const unsubscribe = ref.on('value', () => {});
      await wait(150);
      unsubscribe();

      // Modify data
      await ref.set({ value: 'modified' });
      await wait(100);

      // once() should fetch from server (not stale cache)
      const snapshot = await ref.once();
      expect(snapshot.val()).toEqual({ value: 'modified' });
    });
  });

  describe('cache with queries', () => {
    it('once() without query uses cache from non-query subscription', async () => {
      const path = uniquePath('test/cache/query-cache');
      const ref = db.ref(path);

      await ref.set({
        a: { value: 1 },
        b: { value: 2 },
        c: { value: 3 },
      });

      // Subscribe without query
      const unsubscribe = ref.on('value', () => {});
      await wait(200);

      // once() without query should use cache
      const startTime = Date.now();
      const snapshot = await ref.once();
      const elapsed = Date.now() - startTime;

      expect(snapshot.val()).toHaveProperty('a');
      expect(snapshot.val()).toHaveProperty('b');
      expect(snapshot.val()).toHaveProperty('c');
      expect(elapsed).toBeLessThan(50);

      unsubscribe();
    });

    it('once() with query does not use cache (fetches from server)', async () => {
      const path = uniquePath('test/cache/query-no-cache');
      const ref = db.ref(path);

      await ref.set({
        a: { value: 1 },
        b: { value: 2 },
        c: { value: 3 },
      });

      // Subscribe without query
      const unsubscribe = ref.on('value', () => {});
      await wait(200);

      // once() WITH query should fetch from server (may take longer)
      const snapshot = await ref.orderByKey().limitToFirst(2).once();

      // Should have limited results
      const val = snapshot.val() as Record<string, unknown>;
      expect(Object.keys(val).length).toBe(2);

      unsubscribe();
    });
  });

  describe('deeply nested cache access', () => {
    it('once() on very deep path uses parent cache', async () => {
      const path = uniquePath('test/cache/deep-access');
      const ref = db.ref(path);

      await ref.set({
        l1: {
          l2: {
            l3: {
              l4: {
                l5: {
                  value: 'deep-value',
                },
              },
            },
          },
        },
      });

      const unsubscribe = ref.on('value', () => {});
      await wait(200);

      // once() on very deep path
      const startTime = Date.now();
      const snapshot = await db.ref(`${path}/l1/l2/l3/l4/l5/value`).once();
      const elapsed = Date.now() - startTime;

      expect(snapshot.val()).toBe('deep-value');
      expect(elapsed).toBeLessThan(50);

      unsubscribe();
    });
  });
});
